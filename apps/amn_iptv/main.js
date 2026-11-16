'use strict';
/**
 * IPTV (amn_iptv): the live channels of your own Xtream Codes account on the centre screen, in the style of UHF.
 *
 * The IPTV service (native/amn-iptv, a root tool from the same repository) holds the account, talks to the provider
 * and plays a channel: tvh-player decodes it on the GPU into /dev/shm/mgu-video-amn-iptv and plays its sound into
 * SmartXbar's CarLife input. This app is the screen: it asks the service (lib/svc.js), draws the pages, shows the
 * video file through the kit's renderer connection (Recorder.video), routes the sound to the speakers
 * (lib/car_audio.js) and changes the channel on the steering wheel's skip (lib/wheel.js).
 *
 * Pages (a rail on the left, as UHF's tab bar turned on its side for the wide screen):
 *   home      the playlist pill and search, Favourites (logo plates, what is on now, a progress line), TV Guide rows
 *   live      every category on the left, its channels on the right
 *   search    an on-screen keyboard (lib/keyboard.js) and the results
 *   player    the picture full screen; a tap shows the channel, the programme, the next, and Guide / Channels /
 *             Favourite / Stop over it for 6 s
 *   signin    the QR code of the service's sign-in page (on the car Wi-Fi): the login goes from the phone to the
 *             head unit, never through this app
 *   soon      Series and Movies (a later version)
 *
 * The picture shows while parked (lib/parkgate.js: under 1 km/h and in P); the setting "Video while driving" lets a
 * passenger watch. The sound plays either way. Favourites are kept in the app's data folder (favourites.json).
 *
 * Node 8 only: no ?. ?? object spread, class fields or optional catch binding. Every callback goes through guard().
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const FS = require('./kit/fullscreen');
const G = require('./kit/gauges');
const record = require('./kit/record');
const fonts = require('./kit/fonts');
const pack = require('./kit/pack');
const svc = require('./svc');
const park = require('./parkgate');
const { createCarAudio } = require('./car_audio');
const WHEEL = require('./wheel');
const LOGO = require('./logos');
const KB = require('./keyboard');
const qrcodegen = require('./qrcodegen');

const VERSION = '0.1.1';
const W = 1600, H = 520;
const VID = 7, VIDEO_FILE = '/dev/shm/mgu-video-amn-iptv';
const C = {
    bg: '#000000', card: '#1c1c1e', pill: '#26262a', rail: '#161618', text: '#ffffff', grey: '#98989f', dim: '#636366',
    accent: '#ef4a2c', accentDim: '#3a1a14', navy: '#1e2c3e', navyText: '#bfcadb', green: '#30d158', amber: '#ff9f0a', red: '#ff453a',
};
const PLATE = { card: [236, 112], guide: [150, 70], player: [190, 104] };
const LOGO_SLOTS = 72, LOGO_ID0 = 200;
const PLAYING = ['loading', 'playing', 'buffering'];

const A_ = (c, a) => { const s = String(c).replace('#', '').slice(0, 6); return '#' + s + ('0' + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16)).slice(-2); };
const mix = (a, b, f) => {
    const p = (c) => [0, 2, 4].map((k) => parseInt(String(c).replace('#', '').slice(k, k + 2), 16));
    const x = p(a), y = p(b);
    return '#' + x.map((v, i) => ('0' + Math.round(v + (y[i] - v) * f).toString(16)).slice(-2)).join('');
};
const hhmm = (t) => { const d = new Date(t * 1000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); };
/** a channel's name without the panel's country prefix ("CAF  TVA GATINEAU" -> "TVA GATINEAU") */
const short = (n) => String(n || '').replace(/^\s*[A-Z]{2,4}\s*[|:-]?\s+(?=\S)/, '').replace(/\s+/g, ' ').trim();
/** a category's name as shown ("CA  QUEBEC" -> "CA · QUEBEC") */
const catName = (n) => String(n || '').replace(/^\s*([A-Z]{2,4})\s+/, '$1 · ').replace(/\s+/g, ' ').trim();

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            /* ---------- fonts: Inter (OFL), as HUD Lyrics ---------- */
            let F_BOLD = 'bold', F_MED = 'label';
            try {
                const dirs = [path.join(__dirname, 'fonts'), path.join(__dirname, 'data', 'fonts')];
                const src = pack.open(fs.existsSync(dirs[0] + '.pack') || fs.existsSync(dirs[0]) ? dirs[0] : dirs[1]);
                if (fonts.register('cl_bold', src.json('cl_bold.json'))) F_BOLD = 'cl_bold';
                if (fonts.register('cl_med', src.json('cl_med.json'))) F_MED = 'cl_med';
            } catch (e) { log.warn('fonts: ' + e.message); }
            const B = { font: F_BOLD, literal: true }, M = { font: F_MED, literal: true };
            const fit = (cv, s, size, w, o) => {
                s = String(s || '');
                const opt = o || M;
                if (cv.textWidth(s, size, opt) <= w) return s;
                let lo = 0, hi = s.length;
                while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, mid) + '...', size, opt) <= w) lo = mid; else hi = mid - 1; }
                return s.slice(0, lo).replace(/\s+$/, '') + '...';
            };

            /* ---------- state ---------- */
            let st = null, svcErr = null, svcErrCode = null;        // the service's status, or why there is none
            let cats = [], catsAt = 0, catSel = null;
            const lists = {};                                       // cat id -> { at, channels } | { error }
            const now = {};                                         // stream id -> { now, next } (from the service)
            const wantNow = new Set();
            let page = 'home', toast = null, overlayUntil = 0, panel = null, guideFor = null;
            let playingCh = null, zapList = [];
            const scroll = { cats: 0, chans: 0, favs: 0, results: 0, guide: 0 };
            const say = (text, ms) => { toast = { text, until: Date.now() + (ms || 3000) }; };
            const settingsGet = (k) => settings.get(k);

            /* favourites: the app's data folder */
            const FAV_FILE = path.join(ctx.dataDir, 'favourites.json');
            let favs = [];
            try { favs = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')).filter((c) => c && c.id); } catch (e) { favs = []; }
            const isFav = (id) => favs.some((c) => c.id === id);
            function toggleFav(c) {
                if (!c) return;
                if (isFav(c.id)) { favs = favs.filter((x) => x.id !== c.id); say('Removed from favourites'); }
                else { favs.push({ id: c.id, name: c.name, icon: c.icon || '', cat: c.cat || '' }); say('Added to favourites'); }
                try { fs.writeFileSync(FAV_FILE, JSON.stringify(favs)); } catch (e) { log.warn('favourites: ' + e.message); }
            }

            /* ---------- the service ---------- */
            const signedIn = () => !!(st && st.account);
            const playing = () => !!(st && st.playback && PLAYING.indexOf(st.playback.state) >= 0);
            let polling = false;
            async function poll() {
                if (polling) return;
                polling = true;
                try {
                    st = await svc.ask({ cmd: 'status' });
                    svcErr = null; svcErrCode = null;
                    if (signedIn() && st.client && st.client.state === 'connected' && (!cats.length || (st.categories && st.categories.at !== catsAt))) {
                        const r = await svc.ask({ cmd: 'categories' });
                        cats = r.categories || []; catsAt = r.at;
                        if (catSel === null && cats.length) { const o = orderedCats(); catSel = (favs.length ? o[0] : cats.filter((c) => /qu[eé]bec/i.test(c.name))[0] || o[0]).id; }
                    }
                    if (!signedIn() && page !== 'signin' && page !== 'soon') page = 'signin';
                    if (signedIn() && page === 'signin') { page = 'home'; say('Signed in'); }
                } catch (e) {
                    svcErr = e.message; svcErrCode = e.code || null;
                }
                polling = false;
                audioSync();
            }
            setInterval(guard('poll', poll), 1500);
            poll();
            // what the service plays: sound and picture settings
            const sendPrefs = () => svc.ask({ cmd: 'prefs', gain: Number(settingsGet('gain')) || 0, subs: true, even: false }).catch(() => {});
            setTimeout(sendPrefs, 1500);
            settings.onChange(guard('settings', (k) => {
                if (k === 'gain') sendPrefs();
                if (k === 'signout' && settingsGet('signout') === 'yes') {
                    settings.set('signout', 'no');
                    svc.ask({ cmd: 'stop' }).then(() => svc.ask({ cmd: 'signout' })).then(() => { cats = []; Object.keys(lists).forEach((k2) => { delete lists[k2]; }); page = 'signin'; say('Signed out: the login is deleted from this car'); }, () => {});
                }
            }));

            /** the categories your favourites come from first, then the provider's order */
            function orderedCats() {
                const mine = {};
                favs.forEach((f) => { mine[String(f.cat)] = true; });
                return cats.filter((c) => mine[String(c.id)]).concat(cats.filter((c) => !mine[String(c.id)]));
            }
            let catsPlaced = false;
            function loadList(cat) {
                if (!cat || (lists[cat] && (lists[cat].loading || Date.now() - lists[cat].at < 10 * 60000))) return;
                lists[cat] = { loading: true, at: Date.now(), channels: (lists[cat] && lists[cat].channels) || [] };
                svc.ask({ cmd: 'channels', cat }, 40000).then((r) => {
                    lists[cat] = r.error ? { at: Date.now(), error: r.error, channels: [] } : { at: Date.now(), channels: r.channels || [] };
                }, (e) => { lists[cat] = { at: Date.now(), error: e.message, channels: [] }; });
            }
            const shownList = (list) => (settingsGet('hevc') ? list : list.filter((c) => !c.hevc));
            // what is on now: the ids drawn this frame, asked in one go every 1.5 s
            let nowBusy = false;
            setInterval(guard('now', () => {
                if (nowBusy || !signedIn()) return;
                const t = Date.now() / 1000;
                const ids = Array.from(wantNow).filter((id) => { const v = now[id]; return !v || (v.now && v.now.stop < t) || (!v.now && Date.now() - (v.at || 0) > 600000); }).slice(0, 24);
                wantNow.clear();
                if (!ids.length) return;
                nowBusy = true;
                svc.ask({ cmd: 'now', ids }, 40000).then((r) => {
                    ids.forEach((id) => { const v = (r.now || {})[id]; now[id] = Object.assign({ at: Date.now() }, v || { now: null, next: null }); });
                }, () => {}).then(() => { nowBusy = false; });
            }), 1500);
            const nowOf = (id) => { wantNow.add(id); return now[id] || null; };

            /* ---------- logos: fetched by the service, made into plates here ---------- */
            const logos = {};          // key "id|w" -> { slot, plate, at } | { none } | { loading }
            const slotUse = [];        // slot -> key (least recently drawn reused)
            const logoQueue = [];
            let logoBusy = 0;
            function logoOf(c, size) {
                if (!c) return null;
                const key = c.id + '|' + size[0];
                const e = logos[key];
                if (e) { if (e.slot != null) e.at = Date.now(); return e.slot != null ? e : null; }
                logos[key] = { loading: true };
                logoQueue.push({ c, size, key });
                pumpLogos();
                return null;
            }
            function pumpLogos() {
                while (logoBusy < 2 && logoQueue.length) {
                    const q = logoQueue.shift();
                    if (!q.c.icon) { logos[q.key] = { none: true }; continue; }
                    logoBusy++;
                    svc.ask({ cmd: 'logo', id: q.c.id, icon: q.c.icon }, 30000).then((r) => {
                        const pic = r && r.img ? LOGO.make(Buffer.from(r.img, 'base64'), q.size[0], q.size[1]) : null;
                        if (!pic) { logos[q.key] = { none: true }; return; }
                        // a slot: a free one, or the least recently drawn
                        let slot = slotUse.length < LOGO_SLOTS ? slotUse.length : -1;
                        if (slot < 0) {
                            let oldest = Infinity;
                            slotUse.forEach((k, i) => { const e = logos[k]; const at = e && e.at || 0; if (at < oldest) { oldest = at; slot = i; } });
                            const old = slotUse[slot]; if (old) delete logos[old];
                        }
                        slotUse[slot] = q.key;
                        record.setImage(LOGO_ID0 + slot, pic.w, pic.h, pic.rgba);
                        logos[q.key] = { slot, id: LOGO_ID0 + slot, plate: pic.plate, colour: pic.colour, at: Date.now() };
                    }, () => { logos[q.key] = { none: true }; }).then(() => { logoBusy--; pumpLogos(); });
                }
            }

            /* ---------- playing ---------- */
            const audio = createCarAudio(ctx.signals, log, path.join(ctx.dataDir, 'audio.json'));
            function audioSync() { audio.want(playing()); }
            process.once('exit', () => { try { audio.want(false); } catch (e) { /* ending */ } });
            function play(c, list) {
                if (!c) return;
                playingCh = { id: c.id, name: c.name, icon: c.icon || '', cat: c.cat || '' };
                if (list) zapList = list;
                page = 'player'; panel = null; overlayUntil = Date.now() + 6000;
                svc.ask({ cmd: 'play', id: c.id, name: c.name }).then(poll, (e) => say(e.message));
            }
            function stopPlay() { svc.ask({ cmd: 'stop' }).then(poll, () => {}); playingCh = null; if (page === 'player') page = 'home'; }
            function zap(dir) {
                if (!playingCh || !zapList.length) return;
                const i = zapList.findIndex((c) => c.id === playingCh.id);
                const n = zapList[((i < 0 ? 0 : i) + dir + zapList.length) % zapList.length];
                if (n) { play(n, null); say((dir > 0 ? 'Next: ' : 'Previous: ') + short(n.name)); }
            }
            const wheel = WHEEL.createWheel({ zap: guard('zap', zap), active: () => !!settingsGet('wheel') && playing() });
            if (ctx.signals && ctx.signals.watch) {
                const h = {}; h[WHEEL.FIELD] = guard('wheel', (v) => wheel.onSwitch(v));
                ctx.signals.watch(WHEEL.IFACE, '1', h, log).catch(() => {});
            }
            try { park.start(ctx.signals, log); } catch (e) { log.warn('park: ' + e.message); }
            const pictureAllowed = () => !!settingsGet('motion') || park.isParked();
            // the video file named to the renderer once it can show video (again after a reconnect: renderd.js keeps it)
            let videoNamed = false;
            function videoReady() {
                const g = ctx.display && ctx.display.gpu;
                if (!g || !g.ready || !g.native || !g.info || !g.info.video) return false;
                if (!videoNamed) { videoNamed = g.video(VID, VIDEO_FILE) !== false; if (videoNamed) log.info('video: ' + VIDEO_FILE + ' named to the renderer'); }
                return videoNamed;
            }

            /* ---------- scrolling (a finger dragged on a list) ---------- */
            let drag = null, dragged = 0;
            const regions = [];          // drawn each frame: { key, x, y, w, h, max (px) }
            if (typeof ctx.onTouch === 'function') ctx.onTouch(guard('touch', (phase, x, y) => {
                if (phase === 1) {
                    const r = regions.filter((g) => x >= g.x && x < g.x + g.w && y >= g.y && y < g.y + g.h)[0];
                    drag = r ? { key: r.key, y0: y, s0: scroll[r.key], max: r.max, moved: false } : null;
                    return false;
                }
                if (!drag) return false;
                if (phase === 2) {
                    const dy = drag.y0 - y;
                    if (Math.abs(dy) > 12) drag.moved = true;
                    if (drag.moved) { scroll[drag.key] = Math.max(0, Math.min(drag.max, drag.s0 + dy)); dragged = Date.now(); }
                    return drag.moved;
                }
                const took = drag.moved;
                drag = null;
                return took;
            }));
            const tap = (fn) => () => { if (Date.now() - dragged < 250) return; fn(); };
            const btn = (cv, key, x, y, w, h, fn, r) => FS.button(cv, key, x, y, w, h, guard(key, tap(fn)), { r: r != null ? r : 16, slop: 4 });

            /* ---------- drawing pieces ---------- */
            function glass(cv, x, y, w, h, r, fill) { cv.roundRect(x, y, w, h, r, fill || C.card); }
            function plate(cv, c, x, y, size, r, corners) {
                const lg = logoOf(c, size);
                if (lg) {
                    cv.image(lg.id, x, y, size[0], size[1]);
                    // the kit draws pictures square: each corner given back to the page, then rounded in the plate's colour
                    const rr = r || 14, w = size[0], h = size[1];
                    const cs = corners === 'top' ? [[x, y, 270], [x + w - rr, y, 0]] : corners === 'all'
                        ? [[x, y, 270], [x + w - rr, y, 0], [x + w - rr, y + h - rr, 90], [x, y + h - rr, 180]] : [];
                    cs.forEach((k) => {
                        cv.fillRect(k[0], k[1], rr, rr, C.bg);
                        const cx = k[2] === 270 || k[2] === 180 ? k[0] + rr : k[0], cy = k[2] === 270 || k[2] === 0 ? k[1] + rr : k[1];
                        cv.arc(cx, cy, 0, rr, k[2], k[2] + 90, lg.plate);
                    });
                    return lg;
                }
                cv.roundRect(x, y, size[0], size[1], r || 14, '#2c2c30');
                cv.text(fit(cv, short(c.name), 18, size[0] - 20, B), x + size[0] / 2, y + size[1] / 2 + 7, 18, C.grey, Object.assign({ align: 'center' }, B));
                return null;
            }
            function progress(cv, x, y, w, n) {
                const t = Date.now() / 1000;
                if (!n || !n.now) return;
                const f = Math.max(0, Math.min(1, (t - n.now.start) / Math.max(1, n.now.stop - n.now.start)));
                cv.fillRect(x, y, w, 4, '#46464c');
                cv.fillRect(x, y, Math.round(w * f), 4, C.text);
            }
            function rail(cv, A) {
                const x = A.x, w = 108;
                cv.roundRect(x, A.y, w, A.h, 28, C.rail);
                const items = [['home', 'Home'], ['live', 'Live TV'], ['search', 'Search'], ['series', 'Series'], ['movies', 'Movies']];
                const step = Math.min(96, (A.h - 40) / items.length);
                items.forEach((it, i) => {
                    const cy = A.y + 24 + i * step + step / 2;
                    const on = page === it[0] || (it[0] === 'live' && page === 'player' && false) || (page === 'soon' && soonWhat === it[0]);
                    if (on) cv.roundRect(x + 8, cy - step / 2 + 6, w - 16, step - 12, 20, C.accentDim);
                    const col = on ? C.accent : '#e8e8ec';
                    icon(cv, it[0], x + w / 2, cy - 12, col);
                    cv.text(it[1], x + w / 2, cy + 26, 15, col, Object.assign({ align: 'center' }, on ? B : M));
                    btn(cv, 'rail_' + it[0], x + 6, cy - step / 2 + 4, w - 12, step - 8, () => go(it[0]), 20);
                });
            }
            let soonWhat = '';
            function go(p) {
                panel = null;
                if (p === 'series' || p === 'movies') { soonWhat = p; page = 'soon'; return; }
                page = p;
                if (p === 'search') { search.kb = search.kb || new KB.Keyboard('abc'); }
            }
            function icon(cv, kind, cx, cy, col) {
                if (kind === 'home') {
                    cv.line(cx - 15, cy + 1, cx, cy - 13, 3.5, col); cv.line(cx, cy - 13, cx + 15, cy + 1, 3.5, col);
                    cv.strokeRoundRect(cx - 11, cy - 2, 22, 17, 3, 3.5, col); cv.fillRect(cx - 3, cy + 6, 6, 9, col);
                } else if (kind === 'live') {
                    cv.circle(cx, cy - 2, 3.5, col);
                    cv.arc(cx, cy - 2, 9, 12.5, 210, 330, col); cv.arc(cx, cy - 2, 16, 19.5, 210, 330, col);
                    cv.line(cx, cy + 2, cx, cy + 15, 3.5, col);
                } else if (kind === 'search') {
                    cv.arc(cx - 3, cy - 3, 9, 12.5, 0, 360, col); cv.line(cx + 5, cy + 5, cx + 14, cy + 14, 4, col);
                } else if (kind === 'series') {
                    cv.strokeRoundRect(cx - 16, cy - 12, 32, 21, 4, 3.5, col); cv.line(cx - 8, cy + 15, cx + 8, cy + 15, 3.5, col);
                } else if (kind === 'movies') {
                    cv.strokeRoundRect(cx - 16, cy - 13, 32, 27, 4, 3.5, col); cv.line(cx - 8, cy - 13, cx - 8, cy + 14, 3, col); cv.line(cx + 8, cy - 13, cx + 8, cy + 14, 3, col);
                }
            }
            function topBar(cv, A, x0) {
                const y = A.y, h = 52;
                cv.roundRect(x0, y, 210, h, h / 2, C.pill);
                cv.circle(x0 + 30, y + h / 2, 17, C.accent);
                [-5, 4].forEach((o) => { cv.line(x0 + 26 + o, y + h / 2 - 7, x0 + 33 + o, y + h / 2, 2.6, C.text); cv.line(x0 + 33 + o, y + h / 2, x0 + 26 + o, y + h / 2 + 7, 2.6, C.text); });
                cv.text('Main', x0 + 58, y + h / 2 + 11, 30, C.text, B);
                const sx = x0 + 228, sw = Math.min(560, A.right - sx - 10);
                cv.roundRect(sx, y, sw, h, h / 2, C.pill);
                icon(cv, 'search', sx + 30, y + h / 2, C.grey);
                cv.text('Search channels', sx + 56, y + h / 2 + 8, 22, '#7a7a82', M);
                btn(cv, 'top_search', sx, y, sw, h, () => go('search'), h / 2);
                if (playing() && playingCh && page !== 'player') {
                    const bx = sx + sw + 18, bw = A.right - bx;
                    if (bw > 220) {
                        cv.roundRect(bx, y, bw, h, h / 2, C.accentDim);
                        cv.circle(bx + 24, y + h / 2, 6, C.accent);
                        cv.text(fit(cv, 'Now playing  ' + short(playingCh.name), 20, bw - 150, B), bx + 40, y + h / 2 + 7, 20, C.text, B);
                        cv.text('Watch', bx + bw - 24, y + h / 2 + 7, 20, C.accent, Object.assign({ align: 'right' }, B));
                        btn(cv, 'top_watch', bx, y, bw, h, () => { page = 'player'; overlayUntil = Date.now() + 6000; }, h / 2);
                    }
                }
            }
            function section(cv, x, y, title, right, more) {
                cv.text(title, x, y, 24, '#aeaeb4', B);
                if (more) { cv.text('view all', right, y, 19, C.text, Object.assign({ align: 'right' }, B)); btn(cv, 'more_' + title, right - 90, y - 24, 90, 32, more, 8); }
            }
            /** a channel card: the plate, a progress line, what is on now, the channel */
            function card(cv, c, x, y, list) {
                const [pw, ph] = PLATE.card, n = nowOf(c.id);
                glass(cv, x, y, pw, ph + 70, 18);
                plate(cv, c, x, y, PLATE.card, 18, 'top');
                cv.fillRect(x, y + ph - 8, pw, 8, C.card);
                progress(cv, x, y + ph - 4, pw, n);
                cv.text(fit(cv, n && n.now ? n.now.title : short(c.name), 19, pw - 30, B), x + 16, y + ph + 30, 19, C.text, B);
                cv.text(fit(cv, short(c.name), 16, pw - 30, M), x + 16, y + ph + 56, 16, C.grey, M);
                if (list !== favs && isFav(c.id)) { cv.circle(x + pw - 20, y + 20, 9, C.bg); cv.circle(x + pw - 20, y + 20, 6, C.accent); }
                btn(cv, 'card_' + c.id, x, y, pw, ph + 70, () => play(c, list), 18);
            }
            /** a TV guide row: the plate, the bar tinted by the logo's colour (what has played lighter), the next in navy */
            function guideRow(cv, c, x, y, w, list) {
                const [pw, ph] = PLATE.guide, n = nowOf(c.id), lg = plate(cv, c, x, y, PLATE.guide, 16, 'all');
                const col = lg && lg.colour ? lg.colour : '#5a5a62';
                const bar = mix(mix(col, '#5a5a60', 0.35), '#000000', 0.74), lit = mix(mix(col, '#5a5a60', 0.35), '#000000', 0.58);
                const bx = x + pw + 10, nextW = Math.min(360, Math.round(w * 0.28)), bw = w - pw - 10 - nextW - 10;
                cv.roundRect(bx, y, bw, ph, 16, bar);
                const t = Date.now() / 1000;
                if (n && n.now) {
                    const f = Math.max(0, Math.min(1, (t - n.now.start) / Math.max(1, n.now.stop - n.now.start)));
                    if (f > 0.02) cv.roundRect(bx, y, Math.max(32, Math.round(bw * f)), ph, 16, lit);
                }
                cv.text(fit(cv, short(c.name).toUpperCase() + (n && n.now ? '   ' + hhmm(n.now.start) : ''), 15, bw - 40, M), bx + 22, y + 26, 15, '#cdcdd2', M);
                cv.text(fit(cv, n && n.now ? n.now.title : (n ? 'No guide for this channel' : '...'), 22, bw - 90, B), bx + 22, y + 56, 22, C.text, B);
                if (n && n.now && n.now.isNew) cv.text('NEW', bx + bw - 18, y + 56, 13, '#e6e6ea', Object.assign({ align: 'right' }, B));
                const nx = bx + bw + 10;
                cv.roundRect(nx, y, nextW, ph, 16, C.navy);
                if (n && n.next) {
                    cv.text(hhmm(n.next.start), nx + 20, y + 26, 15, C.navyText, M);
                    cv.text(fit(cv, n.next.title, 20, nextW - 40, B), nx + 20, y + 56, 20, C.text, B);
                }
                btn(cv, 'row_' + c.id, x, y, w, ph, () => play(c, list), 16);
            }

            /* ---------- pages ---------- */
            function drawHome(cv, A, x0) {
                topBar(cv, A, x0);
                const right = A.right, y1 = A.y + 96;
                if (favs.length) {
                    section(cv, x0, y1, 'Favourites', right, null);
                    const cw = PLATE.card[0] + 18, fitN = Math.floor((right - x0 + 18) / cw);
                    const maxS = Math.max(0, (favs.length - fitN) * cw);
                    cv.clip(x0, y1 + 8, right - x0, PLATE.card[1] + 74);
                    const first = Math.floor(scroll.favs / cw);
                    favs.slice(first, first + fitN + 1).forEach((c, i) => card(cv, c, x0 + (first + i) * cw - scroll.favs, y1 + 12, favs));
                    cv.noclip();
                    if (favs.length > fitN) {
                        if (scroll.favs > 0) arrowBtn(cv, 'fav_l', x0 - 4, y1 + 60, -1, () => { scroll.favs = Math.max(0, scroll.favs - cw * (fitN - 1)); });
                        if (scroll.favs < maxS) arrowBtn(cv, 'fav_r', right - 44, y1 + 60, 1, () => { scroll.favs = Math.min(maxS, scroll.favs + cw * (fitN - 1)); });
                    }
                } else {
                    section(cv, x0, y1, 'Favourites', right, null);
                    glass(cv, x0, y1 + 12, right - x0, 120, 18);
                    cv.text('No favourites yet', x0 + 28, y1 + 60, 24, C.text, B);
                    cv.text('Play a channel, tap the picture, then Favourite. Your favourites and their TV guide show here.', x0 + 28, y1 + 96, 18, C.grey, M);
                }
                // the TV guide: the favourites, else the chosen category's first channels
                const gy = favs.length ? y1 + PLATE.card[1] + 120 : y1 + 182;
                const src = favs.length ? favs : shownList((lists[catSel] || { channels: [] }).channels);
                if (!favs.length) loadList(catSel);
                section(cv, x0, gy, 'TV Guide', right, () => go('live'));
                const rows = Math.max(1, Math.floor((A.bottom - gy - 12) / (PLATE.guide[1] + 10)));
                src.slice(0, rows).forEach((c, i) => guideRow(cv, c, x0, gy + 14 + i * (PLATE.guide[1] + 10), right - x0, src));
            }
            function arrowBtn(cv, key, x, y, dir, fn) {
                cv.circle(x + 22, y + 22, 22, A_('#000000', 0.7));
                cv.strokeRoundRect(x, y, 44, 44, 22, 1.5, A_('#ffffff', 0.3));
                const cx = x + 22, cy = y + 22;
                if (dir > 0) { cv.line(cx - 4, cy - 8, cx + 5, cy, 3, C.text); cv.line(cx + 5, cy, cx - 4, cy + 8, 3, C.text); }
                else { cv.line(cx + 4, cy - 8, cx - 5, cy, 3, C.text); cv.line(cx - 5, cy, cx + 4, cy + 8, 3, C.text); }
                btn(cv, key, x, y, 44, 44, fn, 22);
            }
            function drawLive(cv, A, x0) {
                topBar(cv, A, x0);
                const y0 = A.y + 70, colW = 340, rowH = 46;
                // categories
                glass(cv, x0, y0, colW, A.bottom - y0, 18, C.rail);
                const visRows = Math.floor((A.bottom - y0 - 16) / rowH);
                const oc = orderedCats();
                const maxC = Math.max(0, (oc.length - visRows) * rowH);
                if (!catsPlaced && oc.length) { catsPlaced = true; const i = oc.findIndex((c) => c.id === catSel); if (i >= visRows - 1) scroll.cats = (i - 1) * rowH; }
                scroll.cats = Math.min(scroll.cats, maxC);
                regions.push({ key: 'cats', x: x0, y: y0, w: colW, h: A.bottom - y0, max: maxC });
                cv.clip(x0, y0 + 6, colW, A.bottom - y0 - 12);
                const first = Math.floor(scroll.cats / rowH);
                if (!cats.length) cv.text(st && st.client && st.client.state !== 'connected' ? 'Connecting to your provider...' : 'Loading categories...', x0 + 20, y0 + 40, 18, C.grey, M);
                oc.slice(first, first + visRows + 2).forEach((c, i) => {
                    const y = y0 + 8 + (first + i) * rowH - scroll.cats, on = c.id === catSel;
                    if (on) cv.roundRect(x0 + 8, y, colW - 16, rowH - 6, 12, C.accentDim);
                    cv.text(fit(cv, catName(c.name), 18, colW - 44, on ? B : M), x0 + 22, y + 28, 18, on ? C.accent : '#e8e8ec', on ? B : M);
                    btn(cv, 'cat_' + c.id, x0 + 8, y, colW - 16, rowH - 6, () => { catSel = c.id; scroll.chans = 0; }, 12);
                });
                cv.noclip();
                // the category's channels: cards in a grid
                const gx = x0 + colW + 18, gw = A.right - gx;
                loadList(catSel);
                const L = lists[catSel], list = shownList(L ? L.channels : []);
                const cw = PLATE.card[0] + 16, chH = PLATE.card[1] + 70 + 16, cols = Math.max(1, Math.floor((gw + 16) / cw));
                const rowsV = Math.ceil((A.bottom - y0) / chH) + 1, maxS = Math.max(0, Math.ceil(list.length / cols) * chH - (A.bottom - y0));
                scroll.chans = Math.min(scroll.chans, maxS);
                regions.push({ key: 'chans', x: gx, y: y0, w: gw, h: A.bottom - y0, max: maxS });
                if (!L || L.loading && !list.length) cv.text('Loading the channels...', gx, y0 + 40, 20, C.grey, M);
                else if (L.error) cv.text(fit(cv, 'Could not load this category: ' + L.error, 18, gw, M), gx, y0 + 40, 18, C.red, M);
                else if (!list.length) cv.text('No channel the head unit can play in this category.', gx, y0 + 40, 18, C.grey, M);
                cv.clip(gx, y0, gw, A.bottom - y0);
                const r0 = Math.floor(scroll.chans / chH);
                for (let r = r0; r < r0 + rowsV; r++) {
                    for (let k = 0; k < cols; k++) {
                        const c = list[r * cols + k];
                        if (c) card(cv, c, gx + k * cw, y0 + r * chH - scroll.chans, list);
                    }
                }
                cv.noclip();
            }
            const search = { kb: null, field: { value: '', caret: 0, mask: false, max: 60 }, results: null, busy: false, at: 0, asked: '' };
            Object.defineProperty(search, 'text', { get: () => search.field.value });
            function runSearch() {
                const q = search.text.trim();
                if (q.length < 2 || q === search.asked || search.busy) return;
                search.busy = true; search.asked = q; scroll.results = 0;
                svc.ask({ cmd: 'search', q }, 130000).then((r) => {
                    search.busy = false;
                    if (search.text.trim() !== q) { search.asked = ''; return; }
                    search.results = r.error ? { error: r.error, channels: [] } : { channels: r.channels || [] };
                }, (e) => { search.busy = false; search.results = { error: e.message, channels: [] }; });
            }
            setInterval(guard('search', () => { if (page === 'search' && Date.now() - search.at > 700) runSearch(); }), 300);
            function drawSearch(cv, A, x0) {
                const kb = search.kb || (search.kb = new KB.Keyboard('abc'));
                const y = A.y, h = 52, right = A.right;
                cv.roundRect(x0, y, right - x0, h, h / 2, C.pill);
                icon(cv, 'search', x0 + 30, y + h / 2, C.text);
                cv.text(search.text ? fit(cv, search.text, 24, right - x0 - 120, B) + (Math.floor(Date.now() / 500) % 2 ? '|' : '') : 'Type a channel name', x0 + 56, y + h / 2 + 9, 24, search.text ? C.text : '#7a7a82', search.text ? B : M);
                // the results, beside the keyboard
                const kbW = Math.min(720, Math.round((right - x0) * 0.52)), rx = x0 + kbW + 20, rw = right - rx, ry = y + h + 18;
                const res = search.results, list = res ? shownList(res.channels) : [];
                if (search.busy) cv.text(cats.length ? 'Searching every channel (the first search takes about 15 s)...' : 'Searching...', rx, ry + 30, 18, C.grey, M);
                else if (res && res.error) cv.text(fit(cv, res.error, 18, rw, M), rx, ry + 30, 18, C.red, M);
                else if (res && !list.length) cv.text('No channel found.', rx, ry + 30, 18, C.grey, M);
                else if (!res) cv.text('Results show here as you type.', rx, ry + 30, 18, C.grey, M);
                const rowH = PLATE.guide[1] + 10, vis = Math.floor((A.bottom - ry) / rowH);
                const maxS = Math.max(0, (list.length - vis) * rowH);
                scroll.results = Math.min(scroll.results, maxS);
                regions.push({ key: 'results', x: rx, y: ry, w: rw, h: A.bottom - ry, max: maxS });
                cv.clip(rx, ry, rw, A.bottom - ry);
                const f0 = Math.floor(scroll.results / rowH);
                list.slice(f0, f0 + vis + 2).forEach((c, i) => {
                    const yy = ry + (f0 + i) * rowH - scroll.results, n = nowOf(c.id);
                    plate(cv, c, rx, yy, PLATE.guide, 14, 'all');
                    glass(cv, rx + PLATE.guide[0] + 10, yy, rw - PLATE.guide[0] - 10, PLATE.guide[1], 14);
                    cv.text(fit(cv, short(c.name), 20, rw - PLATE.guide[0] - 50, B), rx + PLATE.guide[0] + 30, yy + 30, 20, C.text, B);
                    cv.text(fit(cv, n && n.now ? n.now.title : catName((cats.filter((k) => k.id === c.cat)[0] || {}).name || ''), 16, rw - PLATE.guide[0] - 50, M), rx + PLATE.guide[0] + 30, yy + 56, 16, C.grey, M);
                    btn(cv, 'res_' + c.id, rx, yy, rw, PLATE.guide[1], () => play(c, list), 14);
                });
                cv.noclip();
                // the keyboard
                const rows = kb.rows(), ky = ry, kh = Math.min(64, Math.floor((A.bottom - ky - 3 * 8) / 4)), gap = 8;
                rows.forEach((row, r) => {
                    const units = row.reduce((s, id) => s + (id === '#space' ? 4 : /^#/.test(id) ? 1.5 : 1), 0);
                    const kw = (kbW - gap * (row.length - 1)) / units;
                    let x = x0;
                    row.forEach((id) => {
                        const w = kw * (id === '#space' ? 4 : /^#/.test(id) ? 1.5 : 1), yy = ky + r * (kh + gap);
                        const label = { '#shift': kb.layer === 'ABC' ? 'abc' : 'ABC', '#layer': kb.layer === '123' ? 'abc' : '123', '#back': 'Del', '#space': 'Space', '#enter': 'Done', '#left': '<', '#right': '>', '#clear': 'Clear' }[id] || id;
                        cv.roundRect(x, yy, w - 0.5, kh, 12, /^#/.test(id) ? '#3a3a40' : C.pill);
                        cv.text(label, x + w / 2, yy + kh / 2 + 8, /^#/.test(id) ? 18 : 24, C.text, Object.assign({ align: 'center' }, /^#/.test(id) ? M : B));
                        btn(cv, 'key_' + r + '_' + id + '_' + x, x, yy, w, kh, () => {
                            const res2 = kb.apply(id, search.field);
                            if (res2 && res2.action === 'enter') { search.at = 0; runSearch(); } else search.at = Date.now();
                        }, 12);
                        x += w + gap;
                    });
                });
            }
            function drawPlayer(cv, A, fullH) {
                cv.fillRect(0, 0, W, fullH, '#000000');
                const pb = (st && st.playback) || {}, ch = playingCh;
                const pic = videoReady() && typeof cv.video === 'function';
                const allowed = pictureAllowed();
                if (ch && pic && allowed && pb.state !== 'idle') cv.video(VID, 0, 0, W, fullH);
                // what the picture cannot say: loading, an error, the park rule
                const mid = fullH / 2;
                let msg = null, sub = null;
                if (!ch || pb.state === 'idle') { msg = 'Nothing playing'; sub = 'Choose a channel on Home, Live TV or Search.'; }
                else if (pb.state === 'error') { msg = 'This channel did not play'; sub = pb.error || ''; }
                else if (pb.state === 'loading') { msg = 'Tuning ' + short(ch.name) + '...'; sub = pb.error ? 'Reconnecting: ' + pb.error : ''; }
                else if (!allowed) { msg = 'The picture shows while parked'; sub = 'The sound goes on. A passenger can watch while driving: Settings, Video while driving.'; }
                else if (!pic) { msg = 'Waiting for the GPU renderer'; sub = 'Install a renderer from the Store (mgu-render), then restart the head unit.'; }
                if (msg && !panel) {
                    cv.text(msg, W / 2, mid - 10, 34, C.text, Object.assign({ align: 'center' }, B));
                    if (sub) cv.text(fit(cv, sub, 19, W - 200, M), W / 2, mid + 30, 19, C.grey, Object.assign({ align: 'center' }, M));
                }
                const show = msg || Date.now() < overlayUntil || panel;
                // a tap anywhere shows the controls (or hides them)
                btn(cv, 'pic', 0, A.y, W, fullH - A.y, () => { if (Date.now() < overlayUntil && !panel) overlayUntil = 0; else overlayUntil = Date.now() + 6000; panel = null; }, 0);
                if (!show || !ch) return;
                // the top: back, LIVE
                cv.gradientRect(0, 0, W, 140, [[0, A_('#000000', 0.6)], [1, A_('#000000', 0)]]);
                cv.roundRect(A.x, A.y, 56, 56, 28, A_('#ffffff', 0.18));
                cv.line(A.x + 33, A.y + 16, A.x + 21, A.y + 28, 3.5, C.text); cv.line(A.x + 21, A.y + 28, A.x + 33, A.y + 40, 3.5, C.text);
                btn(cv, 'p_back', A.x, A.y, 56, 56, () => { page = 'home'; panel = null; }, 28);
                cv.roundRect(A.right - 96, A.y + 6, 92, 42, 21, C.accent);
                cv.text('LIVE', A.right - 50, A.y + 35, 20, C.text, Object.assign({ align: 'center' }, B));
                // the bottom: the channel, the programme, the next, the actions
                const by = fullH - 200;
                cv.gradientRect(0, by - 60, W, fullH - by + 60, [[0, A_('#000000', 0)], [0.45, A_('#000000', 0.7)], [1, A_('#000000', 0.88)]]);
                const n = nowOf(ch.id);
                plate(cv, ch, A.x, by, PLATE.player, 18);
                const tx = A.x + PLATE.player[0] + 26;
                cv.text(short(ch.name).toUpperCase(), tx, by + 26, 17, '#d2d2d6', B);
                cv.text(fit(cv, n && n.now ? n.now.title : short(ch.name), 36, 820, B), tx, by + 68, 36, C.text, B);
                if (n && n.now) cv.text(hhmm(n.now.start) + ' - ' + hhmm(n.now.stop), tx, by + 98, 18, '#c8c8cc', M);
                const pw = A.right - 4 * 150 - A.x - 30;
                cv.roundRect(A.x, by + 130, pw, 6, 3, A_('#ffffff', 0.3));
                if (n && n.now) {
                    const f = Math.max(0, Math.min(1, (Date.now() / 1000 - n.now.start) / Math.max(1, n.now.stop - n.now.start)));
                    cv.roundRect(A.x, by + 130, Math.max(6, Math.round(pw * f)), 6, 3, C.accent);
                }
                if (n && n.next) cv.text(fit(cv, 'Next   ' + hhmm(n.next.start) + '   ' + n.next.title, 19, pw, M), A.x, by + 172, 19, '#dcdce0', M);
                const acts = [['Stop', () => stopPlay(), false], ['Guide', () => { panel = panel === 'guide' ? null : 'guide'; loadGuide(ch.id); }, panel === 'guide'],
                    ['Channels', () => { panel = panel === 'channels' ? null : 'channels'; }, panel === 'channels'], ['Favourite', () => toggleFav(ch), isFav(ch.id)]];
                let ax = A.right;
                acts.forEach((a) => {
                    const w = 150; ax -= w;
                    cv.roundRect(ax, by + 112, w - 12, 50, 25, a[2] ? C.accent : A_('#ffffff', 0.2));
                    cv.text(a[0], ax + (w - 12) / 2, by + 144, 19, C.text, Object.assign({ align: 'center' }, B));
                    btn(cv, 'act_' + a[0], ax, by + 112, w - 12, 50, () => { a[1](); overlayUntil = Date.now() + 6000; }, 25);
                });
                if (panel === 'guide') drawGuidePanel(cv, A, ch, by);
                if (panel === 'channels') drawChannelsPanel(cv, A, by);
            }
            const guides = {};
            function loadGuide(id) {
                if (guides[id] && Date.now() - guides[id].at < 180000) return;
                guides[id] = { at: Date.now(), loading: true, events: [] };
                svc.ask({ cmd: 'epg', id }, 30000).then((r) => { guides[id] = { at: Date.now(), events: r.events || [], error: r.error }; }, (e) => { guides[id] = { at: Date.now(), events: [], error: e.message }; });
            }
            function drawGuidePanel(cv, A, ch, by) {
                const x = A.right - 620, y = A.y + 70, w = 616, h = by - y - 20;
                cv.roundRect(x, y, w, h, 22, A_('#111114', 0.94));
                cv.text('Guide  ·  ' + short(ch.name), x + 24, y + 38, 20, C.text, B);
                const g = guides[ch.id];
                if (!g || g.loading) { cv.text('Loading...', x + 24, y + 80, 18, C.grey, M); return; }
                if (!g.events.length) { cv.text(g.error || 'No guide for this channel.', x + 24, y + 80, 18, C.grey, M); return; }
                const rowH = 44, vis = Math.floor((h - 60) / rowH), maxS = Math.max(0, (g.events.length - vis) * rowH);
                scroll.guide = Math.min(scroll.guide, maxS);
                regions.push({ key: 'guide', x, y: y + 54, w, h: h - 54, max: maxS });
                cv.clip(x, y + 54, w, h - 60);
                const t = Date.now() / 1000;
                g.events.forEach((e, i) => {
                    const yy = y + 60 + i * rowH - scroll.guide;
                    if (yy < y + 30 || yy > y + h) return;
                    const on = e.start <= t && e.stop > t;
                    cv.text(hhmm(e.start), x + 24, yy + 24, 17, on ? C.accent : C.grey, on ? B : M);
                    cv.text(fit(cv, e.title, 19, w - 130, on ? B : M), x + 100, yy + 24, 19, C.text, on ? B : M);
                });
                cv.noclip();
            }
            function drawChannelsPanel(cv, A, by) {
                const x = A.right - 620, y = A.y + 70, w = 616, h = by - y - 20;
                cv.roundRect(x, y, w, h, 22, A_('#111114', 0.94));
                cv.text('Channels', x + 24, y + 38, 20, C.text, B);
                const list = zapList, rowH = PLATE.guide[1] / 1.4 + 10, ph = Math.round(PLATE.guide[1] / 1.4);
                const vis = Math.floor((h - 60) / rowH), maxS = Math.max(0, (list.length - vis) * rowH);
                scroll.guide = Math.min(scroll.guide, maxS);
                regions.push({ key: 'guide', x, y: y + 54, w, h: h - 54, max: maxS });
                cv.clip(x, y + 54, w, h - 60);
                const f0 = Math.floor(scroll.guide / rowH);
                list.slice(f0, f0 + vis + 2).forEach((c, i) => {
                    const yy = y + 60 + (f0 + i) * rowH - scroll.guide, on = playingCh && c.id === playingCh.id, n = nowOf(c.id);
                    if (on) cv.roundRect(x + 10, yy - 4, w - 20, ph + 8, 12, C.accentDim);
                    cv.text(fit(cv, short(c.name), 19, w - 60, B), x + 24, yy + 22, 19, on ? C.accent : C.text, B);
                    cv.text(fit(cv, n && n.now ? n.now.title : '', 15, w - 60, M), x + 24, yy + 44, 15, C.grey, M);
                    btn(cv, 'zap_' + c.id, x + 10, yy - 4, w - 20, ph + 8, () => { play(c, null); panel = 'channels'; }, 12);
                });
                cv.noclip();
            }
            function drawSignin(cv, A, x0) {
                const right = A.right, cx = x0 + (right - x0) / 2;
                if (svcErrCode === 'ENOSVC') {
                    cv.text('The IPTV service is not installed', cx, A.y + 150, 32, C.text, Object.assign({ align: 'center' }, B));
                    cv.text('In the Store, install "IPTV service" from this source, then restart the head unit once.', cx, A.y + 194, 20, C.grey, Object.assign({ align: 'center' }, M));
                    return;
                }
                if (svcErr) {
                    cv.text('Cannot reach the IPTV service', cx, A.y + 150, 32, C.text, Object.assign({ align: 'center' }, B));
                    cv.text(fit(cv, svcErr, 20, right - x0 - 80, M), cx, A.y + 194, 20, C.grey, Object.assign({ align: 'center' }, M));
                    return;
                }
                const pg = st && st.page;
                const lx = x0 + 20, tw = Math.round((right - x0) * 0.55);
                cv.text('Sign in to your IPTV', lx, A.y + 60, 36, C.text, B);
                const lines = ['Your login goes from your phone to this car only.',
                    'It is never stored in the app or sent anywhere else.', '',
                    '1.  Connect the iPhone to the car with wireless CarPlay (the car Wi-Fi).',
                    '2.  Tap Sign in, then scan the code with the phone\'s camera.',
                    '3.  Enter the server, the user name and the password your provider gave you.'];
                lines.forEach((l, i) => cv.text(fit(cv, l, 19, tw, M), lx, A.y + 110 + i * 32, 19, i < 2 ? C.grey : C.text, M));
                const by = A.y + 110 + lines.length * 32 + 20;
                cv.roundRect(lx, by, 220, 56, 28, C.accent);
                cv.text(pg && pg.open ? 'Code shown' : 'Sign in', lx + 110, by + 37, 22, C.text, Object.assign({ align: 'center' }, B));
                btn(cv, 'signin', lx, by, 220, 56, () => svc.ask({ cmd: 'signin-open' }).then(poll, (e) => say(e.message)), 28);
                if (st && st.client && st.client.state === 'refused') cv.text(fit(cv, st.client.error || '', 18, tw, M), lx + 240, by + 34, 18, C.red, M);
                // the QR code
                const qx = right - 360, qy = A.y + 20, qs = 320;
                cv.roundRect(qx, qy, qs, qs, 24, pg && pg.open && pg.url ? '#ffffff' : '#1c1c1e');
                if (pg && pg.open && pg.url) {
                    const qr = qrOf(pg.url), n = qr.size + 6, m = (qs - 24) / n;
                    for (let y = 0; y < qr.size; y++) {
                        for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) cv.fillRect(qx + 12 + (x + 3) * m, qy + 12 + (y + 3) * m, m + 0.6, m + 0.6, '#000000');
                    }
                    cv.text('Open with the phone\'s camera  ·  ' + Math.ceil((pg.left || 0) / 60) + ' min left', qx + qs / 2, qy + qs + 30, 16, C.grey, Object.assign({ align: 'center' }, M));
                } else if (pg && pg.open) {
                    cv.text('No car Wi-Fi yet', qx + qs / 2, qy + qs / 2 - 6, 22, C.text, Object.assign({ align: 'center' }, B));
                    cv.text('Connect wireless CarPlay', qx + qs / 2, qy + qs / 2 + 24, 17, C.grey, Object.assign({ align: 'center' }, M));
                } else {
                    cv.text('The code shows here', qx + qs / 2, qy + qs / 2 + 6, 20, C.grey, Object.assign({ align: 'center' }, M));
                }
            }
            let qrMemo = null;
            function qrOf(url) { if (!qrMemo || qrMemo.url !== url) qrMemo = { url, qr: qrcodegen.QrCode.encodeText(url, qrcodegen.QrCode.Ecc.MEDIUM) }; return qrMemo.qr; }
            function drawSoon(cv, A, x0) {
                topBar(cv, A, x0);
                const cx = x0 + (A.right - x0) / 2;
                cv.text(soonWhat === 'series' ? 'Series' : 'Movies', cx, A.y + 200, 36, C.text, Object.assign({ align: 'center' }, B));
                cv.text('Coming in a later version: films and series need a player that opens their file types.', cx, A.y + 244, 20, C.grey, Object.assign({ align: 'center' }, M));
            }

            /* ---------- the frame ---------- */
            FS.setup(ctx);
            ui.onClick('BTN_HOME', guard('home', () => go('home')));
            ui.onClick('BTN_LIVE', guard('live', () => go('live')));
            ui.onClick('BTN_WATCH', guard('watch', () => { if (playingCh) { page = 'player'; overlayUntil = Date.now() + 6000; } }));
            ui.onClick('BTN_STOP', guard('stop', stopPlay));
            ui.onClick('BTN_SIGNIN', guard('signin', () => { go('signin'); svc.ask({ cmd: 'signin-open' }).then(poll, () => {}); }));
            ctx.loop('MAIN', 10, guard('draw', async () => {
                const cv = ctx.canvas(W, H), A = FS.area(cv), fullH = H + (cv.extra || 0);
                if (cv.chrome) G.frame(cv, ctx.theme(), ['IPTV'], 0, []);
                regions.length = 0;
                cv.fillRect(0, 0, W, fullH, C.bg);
                if (page === 'player') drawPlayer(cv, A, fullH);
                else {
                    rail(cv, A);
                    const x0 = A.x + 128;
                    if (page === 'signin' || (!signedIn() && page !== 'soon')) drawSignin(cv, A, x0);
                    else if (page === 'home') drawHome(cv, A, x0);
                    else if (page === 'live') drawLive(cv, A, x0);
                    else if (page === 'search') drawSearch(cv, A, x0);
                    else drawSoon(cv, A, x0);
                }
                if (toast && Date.now() < toast.until) {
                    const s = fit(cv, toast.text, 19, 800, B), tw = cv.textWidth(s, 19, B) + 52;
                    cv.roundRect((W - tw) / 2, A.bottom - 64, tw, 46, 23, A_('#2c2c30', 0.96));
                    cv.text(s, W / 2, A.bottom - 34, 19, C.text, Object.assign({ align: 'center' }, B));
                }
                await ui.image('MAIN_GFX', cv);
            }));
            log.info('started ' + VERSION + ', fonts ' + F_BOLD + '/' + F_MED);
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
