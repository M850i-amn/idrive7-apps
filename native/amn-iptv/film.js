'use strict';
/**
 * film.js - a film or a series' episode from the Xtream account (amn-iptv 0.2.0). Runs in the client (client.js, the
 * tool's internet uid) beside playback.js (live TV); one or the other plays. tvh-player reads the film itself, over
 * HTTP, from a server this module keeps on 127.0.0.1: a random port, and a random 128-bit path per film, so no other
 * program on the head unit can name it. The server answers only that path, and fetches the bytes the player's read
 * asks for (its Range) from the account (xtream.js file()): an MP4's index may be at its end, and a skip reads there.
 *
 * A skip or a resume is a new player started at that second (MGU_START_S: the key frame at or before it). Pause ends
 * the player and keeps the position (a read left open while paused is dropped by the server). A player that ends
 * before the film's end (the connection dropped) is started again where it was, 3 times in 2 minutes at most; a
 * film the player cannot play (HEVC, a framing it cannot read) is said at once.
 *
 *   const fm = createFilm({ xt, log, sink, prefs: () => ({ gain, even }) });
 *   fm.play({ kind: 'movie' | 'series', id, ext, name, start, duration })
 *   fm.seek(seconds)  fm.pause()  fm.resume()  fm.stop()
 *   fm.active()       a film is on (playing, paused, ended or failed): its status is the app's
 *   fm.owns(id)       a player id of this module's (from FIRST_ID)
 *   fm.onPlayer(id, ev)
 *   fm.status()       { kind: 'film', state, error, film, pos, duration, audioError, video, at }
 *   sink: playback.js's, start(id, env) with the player's MGU_INPUT_URL and MGU_START_S
 *
 * States: loading, playing, buffering, paused, ended, error, idle. Plain Node 8.
 */
const http = require('http');
const crypto = require('crypto');

const FIRST_ID = 1000000;          // live TV's players count from 1 (playback.js)
const RESTARTS = 3;
const RESTART_WINDOW_MS = 120000;
const END_MARGIN_S = 45;           // ended this close to the duration: the film is over (credits cut short)
const FATAL = /only H\.264|framing|no picture or sound|does not open: (Invalid data|Server returned 4)/;

function createFilm(o) {
    const xt = o.xt, log = o.log || (() => {}), sink = o.sink, now = o.now || Date.now;
    const prefs = o.prefs || (() => null);
    let ids = FIRST_ID, cur = null, server = null, listening = null;
    // videoError: the decoder's refusal; shown / decerr: pictures shown and failed to decode (the player's ticks), for "No picture"
    const st = { kind: 'film', state: 'idle', error: null, film: null, pos: 0, duration: null, audioError: null, video: null, videoError: null,
        shown: 0, decerr: 0, profile: null, at: now() };
    const set = (state, error) => { st.state = state; st.error = error || null; st.at = now(); };

    /* ---------- the player's source on 127.0.0.1 ---------- */
    function listen() {
        if (listening) return listening;
        listening = new Promise((resolve, reject) => {
            server = http.createServer(serve);
            server.on('error', (e) => { log('film server: ' + e.message); listening = null; reject(e); });
            server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        });
        return listening;
    }
    const HEADERS = { 'content-length': 'Content-Length', 'content-range': 'Content-Range' };
    function serve(req, res) {
        const c = cur;
        if (!c || req.method !== 'GET' || req.url !== '/' + c.token + '/film') { res.writeHead(404); res.end(); return; }
        let up = null, gone = false;
        req.on('close', () => { gone = true; if (up) up.abort(); });
        xt.file(c.film.kind, c.film.id, c.film.ext, req.headers.range).then((r) => {
            up = r;
            if (gone) { r.abort(); return; }
            if (r.status !== 200 && r.status !== 206) {
                log('film: the server answered HTTP ' + r.status);
                res.writeHead(r.status >= 400 && r.status < 500 ? r.status : 502); res.end(); r.abort();
                return;
            }
            const h = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
            Object.keys(HEADERS).forEach((k) => { if (r.headers[k]) h[HEADERS[k]] = r.headers[k]; });
            res.writeHead(r.status, h);
            r.res.on('error', () => res.destroy());
            r.res.pipe(res);
        }, (e) => {
            log('film: ' + e.message);
            if (!res.headersSent) { res.writeHead(502); res.end(); }
        });
    }

    /* ---------- the player ---------- */
    function startPlayer(c, at) {
        const id = ++ids;
        c.pid = id; c.pos = Math.max(0, at); c.lastError = null; c.done = false;
        st.pos = c.pos; st.audioError = null; st.videoError = null; st.shown = 0; st.decerr = 0;
        set('loading');
        listen().then((port) => {
            if (cur !== c || c.pid !== id) return;
            sink.start(id, { MGU_INPUT_URL: 'http://127.0.0.1:' + port + '/' + c.token + '/film', MGU_START_S: String(Math.floor(c.pos)) });
            const p = prefs();
            if (p) { sink.ctl(id, 'gain ' + p.gain); sink.ctl(id, 'even ' + (p.even ? 'on' : 'off')); }
        }, (e) => fail(c, 'the film\'s server did not start: ' + e.message));
    }
    function fail(c, why) {
        if (cur !== c) return;
        if (c.pid) { sink.stop(c.pid); c.pid = 0; }
        log('film: ' + why);
        set('error', why);
    }
    function play(f) {
        stop();
        const film = { kind: f.kind === 'series' ? 'series' : 'movie', id: Number(f.id), ext: String(f.ext || 'mp4'), name: String(f.name || '').slice(0, 120) };
        cur = { film, token: crypto.randomBytes(16).toString('hex'), pid: 0, pos: 0, restarts: [] };
        st.film = film; st.duration = Number(f.duration) > 0 ? Number(f.duration) : null; st.video = null;
        log('film: ' + film.kind + ' ' + film.id + ' from ' + Math.floor(Number(f.start) || 0) + ' s');
        startPlayer(cur, Number(f.start) || 0);
    }
    function seek(s) {
        const c = cur;
        if (!c) return;
        let t = Number(s);
        if (!isFinite(t)) return;
        if (st.duration) t = Math.min(t, Math.max(0, st.duration - 5));
        startPlayer(c, Math.max(0, t));
    }
    function pause() {
        const c = cur;
        if (!c || !c.pid || ['loading', 'playing', 'buffering'].indexOf(st.state) < 0) return;
        c.pos = st.pos;
        sink.stop(c.pid); c.pid = 0;
        set('paused');
    }
    function resume() {
        const c = cur;
        if (c && (st.state === 'paused' || st.state === 'error' || st.state === 'ended')) startPlayer(c, st.state === 'ended' ? 0 : c.pos);
    }
    function stop() {
        const c = cur;
        if (!c) return;
        if (c.pid) sink.stop(c.pid);
        cur = null;
        Object.assign(st, { film: null, pos: 0, duration: null, audioError: null, video: null });
        set('idle');
    }
    function onPlayer(id, ev) {
        const c = cur;
        if (!c || id !== c.pid || !ev) return;
        if (ev.ev === 'open') {
            if (ev.duration > 0) st.duration = ev.duration;
            st.video = ev.video || null;
        } else if (ev.ev === 'tick') {
            if (ev.state === 'playing') { if (st.state !== 'playing') set('playing'); }
            else if (ev.state === 'buffering' && st.state === 'playing') set('buffering');
            if (typeof ev.pos === 'number' && ev.pos > 0) { st.pos = ev.pos; c.pos = ev.pos; }
            if (typeof ev.shown === 'number') st.shown = ev.shown;
            if (typeof ev.decerr === 'number') st.decerr = ev.decerr;
        } else if (ev.ev === 'decoder' && ev.ok === false) {
            st.videoError = ev.error || 'the decoder did not start';
        } else if (ev.ev === 'audio' && ev.ok === false) {
            st.audioError = ev.error || 'this sound does not play here';
        } else if (ev.ev === 'error') {
            c.lastError = ev.error || 'the player failed';
        } else if (ev.ev === 'end' || ev.ev === 'exit') {
            if (c.done) return;
            c.done = true;
            c.pid = 0;
            if (st.duration && c.pos >= st.duration - END_MARGIN_S) { set('ended'); return; }
            if (c.lastError && FATAL.test(c.lastError)) { set('error', c.lastError); return; }
            const t = now();
            c.restarts = c.restarts.filter((x) => t - x < RESTART_WINDOW_MS);
            if (c.restarts.length >= RESTARTS) { set('error', c.lastError || 'the film keeps stopping (the connection?)'); return; }
            c.restarts.push(t);
            log('film: the player ended at ' + Math.floor(c.pos) + ' s (' + (c.lastError || ev.ev) + '): again from there');
            startPlayer(c, c.pos);
        }
    }
    return {
        play, seek, pause, resume, stop, onPlayer,
        active: () => !!cur,
        owns: (id) => id >= FIRST_ID,
        status: () => JSON.parse(JSON.stringify(st)),
        close() { stop(); if (server) { try { server.close(); } catch (e) { /* closed */ } } },
    };
}

module.exports = { createFilm, FIRST_ID };
