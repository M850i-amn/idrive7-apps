'use strict';
/**
 * Side View (amn_sideview): the camera on the side you signal, on the instrument cluster.
 *
 * Left signal: the left side on the cluster. Right signal: the right side. Signal off: it goes, a moment
 * later. Hazards: nothing. It starts with the car and runs in the background.
 *
 * 0.1 is the half that can be built without knowing where the car's camera pictures are: the turn signal
 * (learned once, parked: hardly anyone has mapped BMW's light status) and the cluster layer, which shows a
 * panel naming the side. The camera picture plugs into that layer once a source is found; "Camera check"
 * lists what the app can see of the unit's cameras toward that.
 *
 * Read-only toward the car: it subscribes to and reads Vehicle2 statusLightStatus, never calls a method or
 * writes a value. No internet. The log holds the light status values while teaching, and the layer's state.
 *
 * Node 8 only (the car's version): no ?. ?? import, object spread, class fields, optional catch binding.
 * Nothing may throw out of a callback: every callback goes through guard().
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const { Turn, CAPTURE_MS } = require('./turn');
// 0.2.0: the turn signals straight from the light module (de.bmw.body.Light); the taught light status is the fallback
const { Indicators } = require('./indicators');
const { SidePanel, PW, PH } = require('./sidepanel');
const camprobe = require('./camprobe');

const VERSION = '0.2.1';
const W = 1600, H = 520;
const LIGHT = ['de.bmw.infotainment.vehicle.Vehicle2', '1', 'statusLightStatus'];
const BODY_LIGHT = ['de.bmw.body.Light', '1', ['StatusFunctionsIndicators', 'StatusFunctionsIndicators2']];
const POLL_MS = 300;              // the light status re-read this often (the car may not notify each flash)
const TICK_MS = 100;              // the side decided this often

const C = {
    top: '#0b1220', bottom: '#030508',
    text: '#ffffff', dim: '#8e8e93', faint: '#5a5d66',
    accent: '#ffb000',             // turn-signal amber
    green: '#30d158', amber: '#ff9f0a', red: '#ff453a', grey: '#636366', blue: '#64d2ff',
};
const A = (c, a) => { const s = String(c).replace('#', '').slice(0, 6); return '#' + s + ('0' + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16)).slice(-2); };
const B = { font: 'bold' }, M = { font: 'label' };

function fit(cv, s, size, w, o) {
    s = String(s || '');
    if (cv.textWidth(s, size, o) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, mid) + '...', size, o) <= w) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo) + '...';
}
function wrap(cv, s, size, w, max, o) {
    const words = String(s || '').split(/\s+/).filter(Boolean), out = [];
    let cur = '';
    words.forEach((word) => { const n = cur ? cur + ' ' + word : word; if (!cur || cv.textWidth(n, size, o) <= w) cur = n; else { out.push(cur); cur = word; } });
    if (cur) out.push(cur);
    if (out.length > max) { const rest = out.slice(max - 1).join(' '); out.length = max - 1; out.push(fit(cv, rest, size, w, o)); }
    return out;
}
/** A turn-signal arrow pointing dir (-1 left, 1 right), centred on cx, cy, s wide. */
function arrow(cv, cx, cy, s, dir, c) {
    const h = s * 0.62, head = s * 0.5, shaft = h * 0.42;
    const tip = cx + dir * s / 2, base = tip - dir * head, tail = cx - dir * s / 2;
    // quad() only: the screen's recorder has no triangle or convex (the head is a quad with the tip twice)
    cv.quad([[tip, cy], [base, cy - h / 2], [base, cy + h / 2], [tip, cy]], c);
    cv.quad([[base + dir * 1, cy - shaft / 2], [tail, cy - shaft / 2], [tail, cy + shaft / 2], [base + dir * 1, cy + shaft / 2]], c);
}

/** The cluster panel for a side (PW x PH, opaque RGBA). */
function panelImage(side) {
    const cv = new Canvas(PW, PH), dir = side === 'left' ? -1 : 1;
    cv.clear('#000000');
    cv.card(0, 0, PW, PH, 36, [[0, '#141b28'], [1, '#06080d']]);
    cv.strokeRoundRect(1, 1, PW - 2, PH - 2, 35, 2, A(C.accent, 0.55));
    arrow(cv, PW / 2, 150, 200, dir, C.accent);
    cv.text(side === 'left' ? 'LEFT SIDE' : 'RIGHT SIDE', PW / 2, 300, 52, C.text, { font: 'bold', align: 'center', spacing: 3 });
    cv.text('Camera feed not connected yet', PW / 2, 352, 26, C.dim, { font: 'label', align: 'center' });
    const d = Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    return { w: PW, h: PH, d: Buffer.from(d) };
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            /* ---------- what was learned, kept in the data folder ---------- */
            const FILE = path.join(ctx.dataDir || __dirname, 'turn-signals.json');
            let saved = null;
            try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first start */ }
            const T = new Turn(saved);
            const D = new Indicators();
            const ready = () => D.live() || T.ready();
            const sideNow = (now) => (D.live() ? D.side(now, holdMs()) : T.ready() ? T.side(now, holdMs()) : null);
            const litNow = (s, now) => (D.live() ? D.lit(s) : T.lit(s, now));
            const hazards = (now) => (D.live() ? D.state === 'hazard' : T.lit('left', now) && T.lit('right', now));
            const save = () => {
                try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(T.learned(), null, 1)); fs.renameSync(tmp, FILE); }
                catch (e) { log.warn('save: ' + e.message); }
            };
            let toast = null;
            const say = (text, ms) => { toast = { text: text, until: Date.now() + (ms || 4000) }; };
            let page = 'main', cams = null, sigs = null, test = null, light = { state: 'connecting', n: 0, at: 0 };

            /* ---------- the car's light status ---------- */
            if (ctx.signals && ctx.signals.watch) {
                const h = {};
                h[LIGHT[2]] = guard('light', (v) => {
                    const now = Date.now();
                    light.n++; light.at = now; light.state = 'on';
                    if (T.capturing(now)) log.info('light (' + T.capturing(now) + '): ' + JSON.stringify(v));
                    T.feed('light', v, now);
                });
                ctx.signals.watch(LIGHT[0], LIGHT[1], h, log, { pollMs: POLL_MS })
                    .then((s) => { if (s.error) { light.state = 'error'; light.err = s.error; } log.info('light status: ' + (s.error ? 'error: ' + s.error : 'subscribed')); })
                    .catch((e) => { light.state = 'error'; light.err = e.message; log.warn('light status: ' + e.message); });
            } else light.state = 'error';

            /* ---------- 0.2.0: the light module's turn-signal status ---------- */
            if (ctx.signals && ctx.signals.watch) {
                const h = {};
                let logged = 0;
                BODY_LIGHT[2].forEach((f) => {
                    h[f] = guard(f, (v) => {
                        const was = D.state, st = D.feed(v, Date.now());
                        if (st !== was || logged < 3) { logged++; log.info('indicators (' + f + '): ' + JSON.stringify(v) + ' -> ' + st); }
                    });
                });
                ctx.signals.watch(BODY_LIGHT[0], BODY_LIGHT[1], h, log)
                    .then((s2) => { D.err = s2.error || null; log.info('indicators: ' + (s2.error ? 'error: ' + s2.error : 'subscribed')); })
                    .catch((e) => { D.err = e.message; log.warn('indicators: ' + e.message); });
            }

            /* ---------- the cluster ---------- */
            const panel = new SidePanel({ log: log, app: 'amn_sideview', draw: panelImage });
            const holdMs = () => Number(settings.get('hold')) || 1500;
            let lastSide = null;
            setInterval(guard('tick', () => {
                const now = Date.now();
                const done = T.tick(now);
                if (done) {
                    say(done.text, 6000);
                    log.info('learn ' + done.which + ': ' + done.text + ' ' + JSON.stringify(T.learned().marks));
                    save();
                }
                let side = settings.get('cluster') && ready() ? sideNow(now) : null;
                if (test && now < test.until) side = test.side; else test = null;
                if (side !== lastSide) { log.info('side: ' + (side || 'none')); lastSide = side; }
                panel.show(side);
            }), TICK_MS);
            process.once('exit', () => { try { panel.close(); } catch (e) { /* closing */ } });

            /* ---------- the buttons ---------- */
            const teach = (which, label) => guard(which, () => {
                if (light.state !== 'on') { say('No light status from the car yet - cannot learn', 5000); return; }
                if (which !== 'off' && !T.base) { say('First tap Signals off, with both signals off', 5000); return; }
                page = 'main';
                T.capture(which, Date.now());
                say(label, CAPTURE_MS);
                log.info('learn ' + which + ': recording');
            });
            ui.onClick('BTN_OFF', teach('off', 'Recording: keep both signals off'));
            ui.onClick('BTN_LEFT', teach('left', 'Recording: keep the LEFT signal on'));
            ui.onClick('BTN_RIGHT', teach('right', 'Recording: keep the RIGHT signal on'));
            ui.onClick('BTN_TEST', guard('test', () => {
                const now = Date.now(), side = test && test.side === 'left' ? 'right' : 'left';
                test = { side: side, until: now + 4000 };
                say('Cluster test: ' + side + ' for 4 s');
            }));
            ui.onClick('BTN_CAMS', guard('cams', () => {
                if (page === 'cams') { page = 'main'; return; }
                cams = camprobe.probe();
                sigs = camprobe.findSignals();
                page = 'cams';
                camprobe.lines(cams).forEach((l) => log.info('camera check: ' + l));
                log.info('signal finder: ' + sigs.files.join(', ') + (sigs.error ? ' error: ' + sigs.error : '') + ' - ' + sigs.hits.length + ' hits');
                sigs.hits.forEach((h) => log.info('signal finder: ' + h));
            }));
            settings.onChange(guard('settings', (k) => { if (k === 'cluster') say(settings.get('cluster') ? 'Cluster: on' : 'Cluster: off'); }));

            /* ---------- the centre screen ---------- */
            function glass(cv, x, y, w, h, r) {
                cv.roundRect(x, y, w, h, r, A('#ffffff', 0.055));
                cv.strokeRoundRect(x, y, w, h, r, 1, A('#ffffff', 0.09));
            }
            /** The car from above, its two lamps lit live as the car reports them. */
            function carCard(cv, now) {
                const x = 48, y = 36, w = 520, h = 372;
                glass(cv, x, y, w, h, 28);
                cv.text('SIDE VIEW', x + 36, y + 52, 14, C.accent, Object.assign({ spacing: 2.2 }, B));
                const cx = x + w / 2, cy = y + 196, bw = 120, bh = 210;
                cv.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 40, '#2a3140');
                cv.roundRect(cx - bw / 2 + 14, cy - bh / 2 + 42, bw - 28, 50, 14, '#0e131c');      // windscreen
                cv.roundRect(cx - bw / 2 + 16, cy + bh / 2 - 62, bw - 32, 34, 12, '#0e131c');      // rear window
                cv.roundRect(cx - bw / 2 - 18, cy - bh / 2 + 64, 20, 12, 5, '#2a3140');            // mirrors
                cv.roundRect(cx + bw / 2 - 2, cy - bh / 2 + 64, 20, 12, 5, '#2a3140');
                const side = ready() ? sideNow(now) : null;
                ['left', 'right'].forEach((s) => {
                    const dir = s === 'left' ? -1 : 1, on = litNow(s, now), held = side === s;
                    arrow(cv, cx + dir * 150, cy, 74, dir, on ? C.accent : held ? A(C.accent, 0.35) : A('#ffffff', 0.1));
                });
                const word = !ready() ? 'Waiting for the turn signals' : side ? (side === 'left' ? 'Left' : 'Right') + ' on the cluster' :
                    hazards(now) ? 'Hazards - nothing shown' : 'No signal';
                cv.text(word, cx, y + h - 34, 22, side ? C.text : C.dim, Object.assign({ align: 'center' }, M));
            }
            /** Teaching: three steps, each with its state. */
            function teachCard(cv, now) {
                const x = 600, y = 36, w = W - 48 - x, h = 372, ix = x + 36, iw = w - 72;
                glass(cv, x, y, w, h, 28);
                if (D.live()) {
                    // 0.2.0: the car says which side: nothing to teach
                    cv.text('TURN SIGNALS  ·  FROM THE CAR', ix, y + 52, 14, C.accent, Object.assign({ spacing: 2.2 }, B));
                    const now2 = { left: 'LEFT', right: 'RIGHT', hazard: 'HAZARDS', off: 'OFF', other: 'OFF (another flash)' }[D.state] || '-';
                    cv.text(now2, ix, y + 140, 64, D.state === 'left' || D.state === 'right' ? C.accent : C.text, B);
                    wrap(cv, 'The light module reports the turn signals, so there is nothing to teach. Left shows the left side on the cluster, right the right side; hazards show nothing.', 20, iw, 3, M)
                        .forEach((r, k) => cv.text(r, ix, y + 200 + k * 28, 20, C.dim, M));
                    cv.text(fit(cv, 'Light module: ' + JSON.stringify(D.raw), 14, iw, M), ix, y + h - 14, 14, C.faint, M);
                    return;
                }
                cv.text('TEACH THE TURN SIGNALS  ·  ONCE, PARKED', ix, y + 52, 14, C.accent, Object.assign({ spacing: 2.2 }, B));
                const cap = T.capturing(now);
                const steps = [
                    ['off', 'Both signals off, then tap Signals off', !!T.base],
                    ['left', 'Signal LEFT, then tap Left is on', T.has('left')],
                    ['right', 'Signal RIGHT, then tap Right is on', T.has('right')],
                ];
                steps.forEach((s, k) => {
                    const sy = y + 104 + k * 62, rec = cap === s[0];
                    cv.circle(ix + 18, sy - 8, 18, rec ? C.amber : s[2] ? C.green : A('#ffffff', 0.12));
                    cv.text(rec ? '' : s[2] ? 'OK' : String(k + 1), ix + 18, sy, s[2] && !rec ? 13 : 18, s[2] || rec ? '#000000' : C.dim, Object.assign({ align: 'center' }, B));
                    cv.text(s[1], ix + 54, sy, 24, rec ? C.text : s[2] ? C.dim : C.text, M);
                    if (rec) {
                        const f = Math.min(1, (now - (T.cap.until - CAPTURE_MS)) / CAPTURE_MS), bx = ix + 54, by = sy + 14;
                        cv.roundRect(bx, by, iw - 54, 6, 3, A('#ffffff', 0.14));
                        cv.roundRect(bx, by, Math.max(6, f * (iw - 54)), 6, 3, C.amber);
                    }
                });
                const note = T.marks.note ? 'Left and right look the same in the light status: this car may not report them apart.' :
                    T.ready() ? 'Learned. Side View now follows the signals by itself, from every start of the car.' :
                    'Push the stalk all the way (not the light tap that flashes three times) so it keeps flashing through each 3-second recording.';
                wrap(cv, note, 19, iw, 2, M).forEach((r, k) => cv.text(r, ix, y + 300 + k * 26, 19, T.marks.note ? C.amber : C.dim, M));
                // the light status's latest changes, small: what a photo of the screen tells me
                const ch = T.changes.slice(-2).map((c) => c.k.replace(/^light\/?/, '') + '=' + JSON.stringify(c.v)).join('   ');
                if (ch) cv.text(fit(cv, 'Light status: ' + ch, 14, iw, M), ix, y + h - 14, 14, C.faint, M);
            }
            function camsCard(cv) {
                const x = 600, y = 36, w = W - 48 - x, h = 372, ix = x + 36, iw = w - 72;
                glass(cv, x, y, w, h, 28);
                cv.text('CAR CHECK  ·  TURN SIGNAL AND CAMERAS', ix, y + 52, 14, C.blue, Object.assign({ spacing: 2.2 }, B));
                const sg = sigs || camprobe.findSignals();
                const L = [];
                L.push(sg.error && !sg.hits.length ? 'Turn-signal fields: ' + sg.error : 'Turn-signal fields found: ' + sg.hits.length);
                sg.hits.slice(0, 7).forEach((h2) => L.push('  ' + h2));
                if (sg.hits.length > 7) L.push('  ... and ' + (sg.hits.length - 7) + ' more (in the log)');
                camprobe.lines(cams || camprobe.probe()).slice(0, 3).forEach((l) => L.push(l));
                L.slice(0, 11).forEach((l, k) => { const sub = l.charAt(0) === ' ', sz = sub ? 15 : 19; cv.text(fit(cv, l, sz, iw, M), ix, y + 90 + k * 23, sz, sub ? C.dim : C.text, M); });
                wrap(cv, 'Send a photo of this page: it tells which signal carries the turn signals, and where the camera picture could come from. Tap Car check again to go back.', 16, iw, 2, M)
                    .forEach((r, k) => cv.text(r, ix, y + h - 40 + k * 22, 16, C.faint, M));
            }
            function statusRow(cv) {
                const y = 428, hh = 64, gap = 14, x0 = 48, w = (W - 96 - 3 * gap) / 4;
                const pv = panel.view();
                const items = [
                    ['LIGHT STATUS', light.state === 'on' ? 'green' : light.state === 'error' ? 'red' : 'amber',
                        light.state === 'on' ? 'From the car  ·  ' + light.n : light.state === 'error' ? 'Not available' + (light.err ? ': ' + light.err : '') : 'Connecting'],
                    D.live() ? ['TURN SIGNALS', 'green', 'From the car  ·  ' + D.n] :
                        ['TURN SIGNALS', T.ready() ? 'green' : T.base ? 'amber' : 'grey', T.ready() ? 'Learned' : T.base ? 'Half learned' : D.err ? 'Light module: ' + D.err : 'Signal once to start'],
                    ['CLUSTER', !settings.get('cluster') ? 'grey' : ({ on: 'green', wait: 'amber', off: 'grey', error: 'red' })[pv.kind] || 'grey', settings.get('cluster') ? pv.text : 'Off in Settings'],
                    ['CAMERA', 'grey', 'Not connected yet  ·  ' + VERSION],
                ];
                items.forEach((it, k) => {
                    const x = x0 + k * (w + gap);
                    glass(cv, x, y, w, hh, hh / 2);
                    cv.circle(x + 30, y + hh / 2, 7, C[it[1]]);
                    cv.circle(x + 30, y + hh / 2, 12, A(C[it[1]], 0.18));
                    cv.text(it[0], x + 52, y + 26, 12, C.dim, Object.assign({ spacing: 1.6 }, B));
                    cv.text(fit(cv, it[2], 19, w - 70, M), x + 52, y + 50, 19, C.text, M);
                });
            }

            ctx.loop('MAIN', 6, guard('draw', async () => {
                const now = Date.now(), cv = ctx.canvas(W, H);
                cv.gradientRect(0, 0, W, H, [[0, C.top], [1, C.bottom]]);
                carCard(cv, now);
                if (page === 'cams') camsCard(cv); else teachCard(cv, now);
                statusRow(cv);
                if (toast && now < toast.until) {
                    const s = fit(cv, toast.text, 18, 760, M), tw = cv.textWidth(s, 18, M) + 48;
                    cv.roundRect(W - 48 - tw, 6, tw, 40, 20, '#000000cc');
                    cv.strokeRoundRect(W - 48 - tw, 6, tw, 40, 20, 1, A('#ffffff', 0.2));
                    cv.text(s, W - 48 - tw / 2, 32, 18, C.text, Object.assign({ align: 'center' }, M));
                }
                await ui.image('MAIN_GFX', cv);
            }));

            log.info('started ' + VERSION + ', signals ' + (T.ready() ? 'learned' : 'not learned') + ', cluster ' + (settings.get('cluster') ? 'on' : 'off'));
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
