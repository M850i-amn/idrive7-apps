'use strict';
/**
 * camera.js - Side View's camera (0.3.0): the left or right camera in the cluster while a turn signal is on.
 *
 * Two parts:
 *   - the camera unit, asked over SOME/IP (de.bmw.infotainment.video.cameraproxy.ICAM2Proxy, instance 1): attached
 *     once as an indirect client (clientAttach CLIENT_INDIRECT -> cookie), then changeState(cookie, { DR_ACTIVE,
 *     MODE_MOSAIK, perspective }) for a side (3 = the left camera alone, 4 = the right) and DR_STANDBY after it. The
 *     unit's interface catalogue (ICAM2Proxy extends CameraProxy) and Drive Recorder's view numbers, found on the car
 *     Nov 16 2026. On iDrive 7 the unit takes about 10 s after the attach to be ready, so the attach is made at start
 *     and kept while the app runs; it is given back (clientDetach) when the app stops or Camera is switched off.
 *   - the picture: the tool amn-sideview-cam (Robert Nisipeanu's waze-on-cluster with Side View's settings) decodes
 *     the camera unit's stream and draws it in the cluster's map area. Its control socket takes {"cmd":"cluster",
 *     "on":"0"|"1"}: on while a side is wanted, off as soon as it is not, whatever the stream does. It reports
 *     {"ev":"status","state":"showing"|"idle"|"starting"|"waiting"|"off"|"error",...} every second.
 *
 * Enum arguments go by name first (BMW's generator writes the names into the app's config), then as wire numbers.
 * Nothing throws out of here; every failure is a state the screen shows. Node 8.
 */
const net = require('net');

const ICAM = 'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy';
const SOCK = process.env.SIDEVIEW_CAM_SOCK || '/dev/shm/amn-sideview-cam/ctl.sock';
const VIEW = { left: 3, right: 4, front: 1 };   // 0.3.1: front = the 360 system's front camera, without a signal
const WIRE = { CLIENT_INDIRECT: 1, DR_STANDBY: 50, DR_ACTIVE: 51, MODE_MOSAIK: 50 };
const RECONNECT_MS = 5000, ATTACH_RETRY_MS = 10000;
// BMW's own camera screens (reverse, top / 360 view, side view, off-road, remote 3D): Side View never asks then
const PARKING = /^(TOPREARVIEW|SIDEVIEW|RFK|OFFROAD|REMOTE360|1|2|3|20|60)$/;
const errText = (e) => String(e && e.message || e).slice(0, 120);
const enumName = (v) => (v && typeof v === 'object' ? v.name || v.value : v);

class Camera {
    /** o: ctx (signals), log, enabled() -> bool */
    constructor(o) {
        this.ctx = o.ctx; this.log = o.log; this.enabled = o.enabled || (() => true);
        this.px = null; this.pxErr = null; this.cookie = null; this.attaching = false; this.attachErr = null; this.attachAt = 0;
        this.state = null; this.ready = null; this.stream = null;          // the camera unit's currentState / cameraProxyState / streamInfo
        this.want = null; this.asked = null; this.askErr = null;           // the side wanted, the one last asked of the unit
        this.sock = null; this.sockUp = false; this.buf = ''; this.tool = null; this.toolAt = 0; this.sockErr = null;
        this.onAt = 0;
    }

    start() {
        this._connect();
        this.timer = setInterval(() => { try { this._tick(); } catch (e) { this.log.warn('camera: tick ' + errText(e)); } }, 500);
        const sig = this.ctx.signals;
        if (!sig || !sig.watch) { this.pxErr = 'no SOME/IP in this app'; return; }
        sig.watch(ICAM, '1', {
            currentState: (v) => { const s = this._fmt(v); if (s !== this.state) this.log.info('camera unit: ' + s); this.state = s; this.stateRaw = v; },
            cameraProxyState: (v) => { const s = String(enumName(v)); if (s !== this.ready) this.log.info('camera unit state: ' + s); this.ready = s; },
            streamInfo: (v) => { if (v && typeof v === 'object') this.stream = v.imageWidth + 'x' + v.imageHeight + ' ' + v.framesPerSecond + ' fps'; },
        }, this.log, { pollMs: 2000 }).then((r) => {
            if (r.error || !r.proxy) { this.pxErr = r.error || 'not available'; this.log.warn('camera unit: ' + this.pxErr); return; }
            this.px = r.proxy; this.sub = r; this.pxErr = null;
            this.log.info('camera unit: connected (ICAM2Proxy)');
        }).catch((e) => { this.pxErr = errText(e); this.log.warn('camera unit: ' + this.pxErr); });
    }

    _fmt(v) {
        if (!v || typeof v !== 'object') return String(v);
        return enumName(v.application) + ' / ' + enumName(v.mode) + ' / ' + v.perspective;
    }

    /** side: 'left' | 'right' | null - called on every tick of the app. */
    set(side) {
        if (!this.enabled()) side = null;
        if (side === this.want) return;
        this.want = side;
        this.log.info('camera: ' + (side ? 'want ' + side + ' (view ' + VIEW[side] + ')' : 'none'));
        this._send({ cmd: 'cluster', on: side && !this.parking() ? '1' : '0' });
        if (side) this.onAt = Date.now();
        this._ask();
    }

    /* ---------- the camera unit ---------- */
    _call(method, byName, byNumber) {
        const sig = this.ctx.signals;
        return sig.call(this.px, method, byName, 8000).catch((e) => {
            if (!byNumber) throw e;
            this.log.info('camera: ' + method + ' by name refused (' + errText(e) + '), as numbers');
            return sig.call(this.px, method, byNumber, 8000);
        });
    }
    _attach() {
        if (!this.px || this.cookie !== null || this.attaching || !this.enabled()) return;
        if (this.sub && !this.sub.available) return;              // the camera unit not offering its service yet
        if (this.attachErr && Date.now() - this.attachAt < ATTACH_RETRY_MS) return;
        this.attaching = true; this.attachAt = Date.now();
        this._call('clientAttach', { type: 'CLIENT_INDIRECT' }, { type: WIRE.CLIENT_INDIRECT }).then((r) => {
            this.attaching = false;
            this.cookie = r && typeof r === 'object' ? r.cookie : r;
            this.attachErr = null;
            this.log.info('camera: attached, cookie ' + this.cookie);
            this.asked = undefined;                              // ask again with the cookie
            this._ask();
        }, (e) => { this.attaching = false; this.attachErr = errText(e); this.log.warn('camera: attach ' + this.attachErr); });
    }
    /** The camera unit shows one of BMW's own camera screens (reversing, parking): hands off. */
    parking() { const v = this.stateRaw; return !!(v && typeof v === 'object' && PARKING.test(String(enumName(v.application)))); }
    _ask() {
        if (this.cookie === null || this.asking) return;
        const want = this.parking() ? null : this.want;
        if (want === this.asked) return;
        // standby only after a side was asked: nothing is sent at start, and nothing while BMW's camera screen has the unit
        if (!want && (this.asked === undefined || this.asked === null || this.parking())) { this.asked = null; return; }
        const view = want ? VIEW[want] : (VIEW[this.asked] || 3);
        const app = want ? 'DR_ACTIVE' : 'DR_STANDBY';
        const st = (a, m) => ({ cookie: this.cookie, desiredState: { application: a, mode: m, perspective: view } });
        this.asking = true;
        this._call('changeState', st(app, 'MODE_MOSAIK'), st(WIRE[app], WIRE.MODE_MOSAIK)).then(() => {
            this.asking = false; this.asked = want; this.askErr = null;
            this.log.info('camera: asked ' + app + ' / MODE_MOSAIK / ' + view);
            if (this.want !== want) this._ask();
        }, (e) => {
            this.asking = false; this.askErr = errText(e);
            this.log.warn('camera: changeState ' + this.askErr);
        });
    }
    release() {
        this._send({ cmd: 'cluster', on: '0' });
        if (this.cookie === null || !this.px) return Promise.resolve();
        const c = this.cookie;
        this.cookie = null; this.asked = undefined;
        return this.ctx.signals.call(this.px, 'clientDetach', { cookie: c }, 3000)
            .then(() => this.log.info('camera: given back (cookie ' + c + ')'), (e) => this.log.warn('camera: detach ' + errText(e)));
    }

    /* ---------- the tool's control socket ---------- */
    _connect() {
        if (this.sock) return;
        let s;
        try { s = this.sock = net.connect(SOCK); } catch (e) { this.sockErr = errText(e); this.sock = null; return; }
        s.setEncoding('utf8');
        s.on('connect', () => {
            this.sockUp = true; this.sockErr = null; this.buf = '';
            this.log.info('camera tool: connected');
            this._send({ cmd: 'cluster', on: this.want ? '1' : '0' });
        });
        s.on('data', (d) => {
            this.buf += d;
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
                let m = null;
                try { m = JSON.parse(line); } catch (e) { continue; }
                if (m && m.ev === 'status') {
                    if (!this.tool || this.tool.state !== m.state) this.log.info('camera tool: ' + m.state + (m.reason ? ' (' + m.reason + ')' : ''));
                    this.tool = m; this.toolAt = Date.now();
                } else if (m && m.ev === 'log' && /warn|error|stream|decod|avb/i.test(String(m.line))) this.log.info('camera tool log: ' + String(m.line).slice(0, 200));
            }
        });
        const gone = (why) => {
            if (this.sock !== s) return;
            if (this.sockUp || !this.sockErr) this.log.info('camera tool: ' + why);
            this.sock = null; this.sockUp = false; this.sockErr = why; this.tool = null;
        };
        s.on('error', (e) => gone(e.code === 'ENOENT' ? 'not installed' : e.code === 'ECONNREFUSED' ? 'not running' : errText(e)));
        s.on('close', () => gone(this.sockErr || 'closed'));
    }
    _send(msg) {
        if (!this.sock || !this.sockUp) return false;
        try { this.sock.write(JSON.stringify(msg) + '\n'); return true; } catch (e) { return false; }
    }

    _tick() {
        if (!this.sock && Date.now() - (this.sockTry || 0) > RECONNECT_MS) { this.sockTry = Date.now(); this._connect(); }
        if (this.enabled()) { this._attach(); this._ask(); }
        else if (this.cookie !== null) this.release();
    }

    /** True while the picture is on the cluster (the tool says so). */
    showing() { return !!(this.tool && this.tool.state === 'showing' && Date.now() - this.toolAt < 3000); }

    /** The status row: { kind: 'on'|'wait'|'off'|'error', text }. */
    view() {
        if (!this.enabled()) return { kind: 'off', text: 'Off in Settings' };
        if (!this.sockUp) return { kind: 'error', text: 'Camera tool ' + (this.sockErr || 'connecting') };
        if (this.pxErr) return { kind: 'error', text: 'Camera unit: ' + this.pxErr };
        if (!this.px) return { kind: 'wait', text: 'Connecting to the camera unit' };
        if (this.sub && !this.sub.available) return { kind: 'wait', text: 'Camera unit not offered yet' };
        if (this.attachErr) return { kind: 'error', text: 'Attach: ' + this.attachErr };
        if (this.cookie === null) return { kind: 'wait', text: 'Attaching to the camera unit' };
        if (this.askErr) return { kind: 'error', text: 'Ask: ' + this.askErr };
        const t = this.tool ? this.tool.state : '?';
        if (this.parking()) return { kind: 'off', text: "BMW's camera screen has the cameras" };
        if (this.want) return { kind: t === 'showing' ? 'on' : 'wait', text: this.want + ': ' + t + (this.stream ? ' · ' + this.stream : '') };
        return { kind: 'on', text: 'Ready · ' + (this.ready || 'unit ?') };
    }
    /** Lines for the camera page. */
    lines() {
        return [
            'Camera tool: ' + (this.sockUp ? 'connected · ' + (this.tool ? this.tool.state + (this.tool.reason ? ' (' + this.tool.reason + ')' : '') : 'no status yet') : (this.sockErr || 'connecting')),
            'Camera unit: ' + (this.px ? 'connected' : this.pxErr || 'connecting') + ' · ' + (this.ready || '?'),
            'Attached: ' + (this.cookie !== null ? 'cookie ' + this.cookie : this.attachErr || (this.attaching ? 'attaching' : 'no')),
            'Asked: ' + (this.asked ? this.asked + ' (view ' + VIEW[this.asked] + ')' : this.asked === null ? 'standby' : '-') + (this.askErr ? ' · ' + this.askErr : ''),
            'Unit now: ' + (this.state || '-') + (this.stream ? ' · ' + this.stream : ''),
        ];
    }
    close() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        try { this.release(); } catch (e) { /* stopping */ }
        if (this.sock) { try { this.sock.destroy(); } catch (e) { /* closing */ } this.sock = null; }
    }
}

module.exports = { Camera, VIEW };
