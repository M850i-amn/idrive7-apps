'use strict';
/**
 * HUD Lyrics (amn_hudlyrics), step 1: synced lyrics for the song the car plays, shown on the centre screen
 * as a status page, to prove on the car that the track, the time in it and the lyrics lookup work. The HUD
 * comes in step 2 (music_cluster.js from G's Music); nothing is drawn on the HUD or the cluster yet.
 *
 * Built from arefahmad's Car Lyrics (MIT): car/nowplaying.js (the track from BMW's MediaPlayer, CarPlay's
 * instance CarPlayMedia), stage/lyrics.js (LRCLIB, from nickgcode's G's Music), net/http.js (the Store's
 * uplink). The clock that follows the car's time in the song is Car Lyrics' own, unchanged.
 *
 * Read-only toward the car: it subscribes to and reads fields, never calls a method or writes a value.
 * One internet host: lrclib.net (net/http.js refuses any other). The log holds only the track's title,
 * artist and timing, and the lyrics lookup's result.
 *
 * Node 8 only (the car's version): no ?. ?? import, object spread, class fields, optional catch binding.
 * Nothing may throw out of a callback: every callback goes through guard().
 */
const mgu = require('./kit/mgu');
const NP = require('./nowplaying');
const LyricsLib = require('./lyrics');
const http = require('./http');

const VERSION = '0.1.0';
const W = 1600, H = 520;
const IFACES = [
    { iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', instances: ['CarPlayManagerInst1'] },
    { iface: 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', instances: [] },
    { iface: 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState', instances: [] },
    { iface: 'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer', instances: [] },
];
const LEAD_MS = 250;              // a line shows this much before its time (reading takes a moment)
const NUDGE = 0.3;                // share of the gap to a new time from the car that the clock takes at once
const SNAP_MS = 1500;             // a gap bigger than this (a seek, a skip back) is jumped, not glided
const HOLD_MS = 4000;             // the clock runs at most this far past the car's last time

const mmss = (ms) => { const s2 = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s2 / 60) + ':' + (s2 % 60 < 10 ? '0' : '') + (s2 % 60); };

/** Cut s to fit width w at size (an ellipsis when cut). */
function fit(cv, s, size, w, opt) {
    s = LyricsLib.fold(String(s || ''));
    const o = Object.assign({ literal: true }, opt || {});
    if (cv.textWidth(s, size, o) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, mid) + '...', size, o) <= w) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo).replace(/\s+$/, '') + '...';
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            const net = http.client(ctx.dataDir);
            const request = (m, h, p, hd) => net.request(m, h, p, hd);
            const lyrics = new LyricsLib.Lyrics(request, log, 'HUDLyrics/' + VERSION + ' (iDrive 7 head-unit app)');
            const np = new NP.NowPlaying(ctx.signals, log, IFACES);
            let toast = null;
            const say = (text, ms) => { toast = { text: text, until: Date.now() + (ms || 3000) }; };

            /* ---------- the track, and the clock that follows the car's time in it (Car Lyrics') ---------- */
            let cur = null;           // { key, title, artist, album, duration, playing }
            let clk = null;           // { pos, at, playing, last }: the song's time pos (ms) at at (ms epoch)
            let startAt = Date.now(); // a source with no time of its own: when the song (probably) began
            let lastState = '';
            const clockAt = (now) => clk.pos + (clk.playing ? Math.min(now - clk.at, HOLD_MS) : 0);
            const follow = () => {
                const t = np.track();
                if (!t) return;
                const key = t.title + '|' + t.artist;
                if (!cur || cur.key !== key) {
                    cur = { key: key, title: t.title, artist: t.artist, album: t.album, duration: t.duration || 0, playing: true };
                    clk = null; startAt = Date.now(); lastState = '';
                    log.info('track: "' + t.title + '" by "' + t.artist + '" (' + Math.round((t.duration || 0) / 1000) + ' s)');
                }
                if (t.duration) cur.duration = t.duration;
                if (t.album) cur.album = t.album;
                const playing = t.direct ? !!t.playing : true;
                cur.playing = playing;
                if (t.position === null || t.position === undefined) return;
                const at = t.positionAt || Date.now();
                if (!clk) { clk = { pos: t.position, at: at, playing: playing, last: t.position }; log.info('time: from the car'); return; }
                if (t.position === clk.last && playing === clk.playing) return;
                const predicted = clockAt(at), gap = t.position - predicted;
                // a seek, a skip back, a pause or a resume: jump; else glide toward the car's time
                if (!playing || !clk.playing || Math.abs(gap) > SNAP_MS) clk.pos = t.position;
                else clk.pos = predicted + gap * NUDGE;
                clk.at = at; clk.playing = playing; clk.last = t.position;
            };
            np.onChange(guard('change', follow));
            const offset = () => Number(settings.get('offset')) || 0;
            const position = (now) => (clk ? clockAt(now || Date.now()) : (now || Date.now()) - startAt) + offset();
            ui.onClick('BTN_SYNC', guard('sync', () => { startAt = Date.now(); say('Synced: the song starts now'); log.info('time: synced by button'); }));

            /** What lyrics.js knows for the song, in words for the page. */
            const STATE = {
                loading: 'Finding the lyrics...', synced: 'Synced lyrics', plain: 'Lyrics without timing (not shown on the HUD)',
                instrumental: 'Instrumental', none: 'No lyrics on LRCLIB for this song', undrawable: 'Lyrics in letters this app cannot draw',
                error: 'Cannot reach LRCLIB',
            };

            /* ---------- the page: a plain status screen (step 1) ---------- */
            ctx.loop('MAIN', 4, guard('draw', async () => {
                const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), L = { literal: true }, B = { font: 'bold', literal: true };
                const X = 60, TW = W - 2 * X;
                if (!cur) follow();
                const online = net.online();
                cv.text('HUD LYRICS  ' + VERSION + '  ·  STEP 1: CENTRE SCREEN ONLY', X, 46, 16, t.dim, { literal: true, spacing: 1.5 });
                cv.text('Internet: ' + (online ? 'online' : 'offline (Store uplink: phone hotspot or Wi-Fi)'), W - X, 46, 16, online ? t.dim : t.warn, { literal: true, align: 'right' });
                if (!cur) {
                    cv.text('Play a song on your phone', X, 200, 44, t.text, B);
                    cv.text('Apple Music or Spotify over CarPlay. The song and its lyrics show up here.', X, 250, 24, t.dim, L);
                } else {
                    const now = Date.now(), pos = Math.max(0, position(now) - offset()), dur = cur.duration || 0;
                    cv.text(fit(cv, cur.title, 40, TW, B), X, 118, 40, t.text, B);
                    cv.text(fit(cv, cur.artist || '(no artist)', 24, TW, L), X, 156, 24, t.dim, L);
                    const time = mmss(pos) + (dur ? ' / ' + mmss(dur) : '') + '   ·   ' + (!cur.playing ? 'Paused' : clk ? 'Time from the car' : 'No time from the car: tap Song just started');
                    cv.text(time, X, 196, 20, clk || !cur.playing ? t.dim : t.warn, L);
                    const lyr = lyrics.get({ title: cur.title, artist: cur.artist, album: cur.album, duration: cur.duration });
                    if (lyr.state !== lastState) { lastState = lyr.state; log.info('lyrics state: ' + lyr.state); }
                    let msg = STATE[lyr.state] || lyr.state;
                    if (lyr.state === 'synced') msg += ' (' + lyr.lines.length + ' lines)';
                    cv.text(msg, X, 236, 20, lyr.state === 'synced' ? t.accent2 || t.text : t.dim, L);
                    if (lyr.state === 'synced' && lyr.lines.length) {
                        const p = position(now) + LEAD_MS, i = LyricsLib.lineAt(lyr.lines, p);
                        const line = i >= 0 ? lyr.lines[i].text : '';
                        let n = i + 1;
                        while (n < lyr.lines.length && !lyr.lines[n].text) n++;
                        const next = n < lyr.lines.length ? lyr.lines[n].text : '';
                        cv.text(fit(cv, line || '·  ·  ·', 48, TW, B), X, 330, 48, t.text, B);
                        if (settings.get('lines') === '2' && next) cv.text(fit(cv, next, 30, TW, L), X, 384, 30, t.dim, L);
                    }
                }
                cv.text('HUD: not drawn yet (step 2)   ·   Lines shown: ' + (settings.get('lines') === '2' ? 'two' : 'one'), X, H - 24, 16, t.dim, L);
                if (toast && Date.now() < toast.until) cv.text(toast.text, W - X, H - 24, 18, t.accent2 || t.text, { literal: true, align: 'right' });
                await ui.image('MAIN_GFX', cv);
            }));

            np.start().then(() => log.info('subscribed: ' + JSON.stringify(np.status())), (e) => log.error('nowplaying start: ' + (e && e.stack || e)));
            log.info('started ' + VERSION);
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
