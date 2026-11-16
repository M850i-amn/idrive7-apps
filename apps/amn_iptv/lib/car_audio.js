'use strict';
/**
 * car_audio.js - the channel's sound on the car's speakers. tvh-player plays into SmartXbar's CarLife input, source
 * 287 (no CarLife phone uses it outside China); the GENIVI audio manager routes a source to a sink on request: this
 * module marks 287 available (RoutingControlObserver.hookSourceAvailablityStatusChange), connects it to the front
 * speakers, MediaSink_Front (1024), with CommandControl.connect, and disconnects that connection when the sound is
 * no longer wanted. (The route is Moonride's, JustAnotherPU, as aurelmarius' TVH Player uses it; this file is
 * amn_iptv's own.)
 *
 * Other apps (myAirPlay, TVH Player) use 287 too, so only this app's own connection is ever disconnected: its id is
 * kept in a file with the boot it was made in (an id from before a restart may be another app's now, and is
 * forgotten, never disconnected). While another app's connection holds 287, this one does not connect and says so.
 *
 *   const audio = createCarAudio(ctx.signals, log, file);
 *   audio.want(true | false)       the sound on (a channel plays) or off
 *   audio.state()                  { on, connected, taken, error }
 *
 * Node 8.
 */
const fs = require('fs');
const AM = 'org.genivi.am.commandinterface.CommandControl';
const AMR = 'org.genivi.am.routinginterface.RoutingControlObserver';
const SRC = 287, SINK = 1024;

function createCarAudio(signals, log, file) {
    const st = { on: false, connected: false, taken: false, error: null };
    let p = null, r = null, id = null, q = Promise.resolve(), retry = null;
    const boot = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return null; } };
    const save = (v) => { try { if (v == null) fs.unlinkSync(file); else fs.writeFileSync(file, JSON.stringify({ mainConnectionID: v, bootId: boot() })); } catch (e) { /* none */ } };
    const saved = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j.bootId && j.bootId === boot() ? j.mainConnectionID : null; } catch (e) { return null; } };
    async function proxies() {
        if (!p) p = await signals.proxy(AM, '1');
        if (!r) r = await signals.proxy(AMR, '1');
    }
    const avail = (on) => signals.call(r, 'hookSourceAvailablityStatusChange',
        { sourceID: SRC, availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 } });
    async function on287() {
        const v = await signals.call(p, 'getListMainConnections', {});
        const list = Array.isArray(v) ? v : (v && Object.keys(v).map((k) => v[k]).filter(Array.isArray)[0]) || [];
        return list.filter((x) => x && x.sourceID === SRC);
    }
    async function connect() {
        await proxies();
        const left = saved();
        if (left != null && (await on287()).some((c) => c.mainConnectionID === left)) id = left;   // ours, from before a crash of the app
        if (id != null) { st.connected = true; return; }
        const other = await on287();
        if (other.length) {
            st.taken = true;
            log.info('car audio: another app has the speakers (' + other.map((c) => c.mainConnectionID).join(', ') + ')');
            return;
        }
        st.taken = false;
        await avail(true);
        const res = await signals.call(p, 'connect', { sourceID: SRC, sinkID: SINK });
        if (res && (res.amError === 'E_OK' || res.amError === 0) && res.mainConnectionID != null) {
            id = res.mainConnectionID; save(id); st.connected = true;
            log.info('car audio: on (' + id + ')');
        } else throw new Error('connect refused: ' + JSON.stringify(res));
    }
    async function disconnect() {
        await proxies();
        const mine = id != null ? id : saved();
        if (mine == null) { st.connected = false; return; }
        if ((await on287()).some((c) => c.mainConnectionID === mine)) await signals.call(p, 'disconnect', { mainConnectionID: mine });
        id = null; save(null); st.connected = false;
        if (!(await on287()).length) await avail(false);
        log.info('car audio: off');
    }
    function step() {
        q = q.then(() => (st.on ? connect() : disconnect())).then(() => { st.error = null; }, (e) => { st.error = String(e.message || e); log.warn('car audio: ' + st.error); });
        return q;
    }
    function want(on) {
        on = !!on;
        if (on === st.on && (on ? st.connected : !st.connected)) return;
        st.on = on;
        clearInterval(retry); retry = null;
        // while another app holds the speakers (or a call failed), look again every 5 s
        if (on) retry = setInterval(() => { if (st.on && !st.connected) step(); }, 5000);
        step();
    }
    return { want, state: () => Object.assign({}, st) };
}

module.exports = { createCarAudio, SRC, SINK };
