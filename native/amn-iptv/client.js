'use strict';
/**
 * client.js - the Xtream client, a child of service.js running as the tool's internet uid (component.json "uids":
 * mgu-uplink routes it, never root). It holds no file of its own: the account comes from the parent over IPC, and
 * everything it learns goes back the same way. From aurelm-tvhplayer's client.js (GPL-3.0-or-later), changed for
 * Xtream: an account has tens of thousands of channels, so nothing is listed whole unless asked (search).
 *
 *   parent -> { op: 'run', account } | { op: 'signin', id, server, user, password } | { op: 'signout' } | { op: 'stop' }
 *             | { op: 'play', channel } | { op: 'playback-stop' } | { op: 'prefs', prefs } | { op: 'refresh' }
 *             | { op: 'player', id, ev } (the player's events)
 *             | { op: 'ask', id, what: 'channels', cat } | { what: 'search', q } | { what: 'now', ids } | { what: 'epg', sid }
 *             | { what: 'logo', icon }
 *   child  -> { ev: 'status', status } | { ev: 'signin', id, ok, account | error } | { ev: 'categories', at, categories }
 *             | { ev: 'playback', status } | { ev: 'player-start', id } | { ev: 'player-ctl', id, line } | { ev: 'player-stop', id }
 *             | { ev: 'signed-out', why } | { ev: 'log', line } | { ev: 'ready', uid } | { ev: 'answer', id, ok, value | error }
 *
 * The channel's stream goes to the parent on fd 4 (the parent hands it to tvh-player's stdin), in frames: a stream
 * id (u32 LE), a length (u32 LE; 0xffffffff: that stream ended), the bytes (playback.js, unchanged).
 *
 * Connected: the account (every 10 minutes: its state and expiry) and the categories (every 30 minutes). A category's
 * channels are kept 10 minutes, what is on now per channel until its programme ends, every channel (search) 30 minutes.
 * A failure is tried again after 5 s, doubling to a minute.
 */
const net = require('net');
const { createNet } = require('./netx');
const { createXtream } = require('./xtream');
const { createPlayback, ascii } = require('./playback');

const send = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* the parent is gone */ } };
const log = (line) => send({ ev: 'log', line });

const nx = createNet({ leasePath: process.env.TVH_LEASE || undefined, systemDns: process.env.TVH_SYSTEM_DNS === '1' });
const xt = createXtream({ nx, log });

/* ---------- the stream to the parent (fd 4) ---------- */
let pipe = null;
try { pipe = new net.Socket({ fd: 4, readable: false, writable: true }); pipe.on('error', (e) => log('stream pipe: ' + e.message)); }
catch (e) { log('no stream pipe: ' + e.message); }
function frame(id, len) { const h = Buffer.alloc(8); h.writeUInt32LE(id >>> 0, 0); h.writeUInt32LE(len >>> 0, 4); return h; }
const sink = {
    start(id) { send({ ev: 'player-start', id }); },
    data(id, buf) { if (!pipe) return true; pipe.write(frame(id, buf.length)); return pipe.write(buf); },
    end(id) { if (pipe) pipe.write(frame(id, 0xffffffff)); },
    drain(id, fn) { if (pipe) pipe.once('drain', fn); else fn(); },
    ctl(id, line) { send({ ev: 'player-ctl', id, line }); },
    stop(id) { send({ ev: 'player-stop', id }); },
};

/* ---------- the account ---------- */
const INFO_MS = 10 * 60000, CATS_MS = 30 * 60000, LIST_MS = 10 * 60000, ALL_MS = 30 * 60000;
const RETRY_MIN = Number(process.env.TVH_RETRY_MS) || 5000;
const st = { state: 'signed-out', error: null, server: null, categories: 0, since: Date.now(), retries: 0 };
let running = false, timer = null, backoff = RETRY_MIN, catsAt = 0, infoAt = 0, cats = [];

const pb = createPlayback({ tvh: xt, log, sink, profiles: () => null, retryMs: process.env.TVH_STREAM_RETRY_MS != null ? Number(process.env.TVH_STREAM_RETRY_MS) : undefined,
    adaptUpMs: Number(process.env.TVH_ADAPT_UP_MS) || undefined, outageMs: Number(process.env.TVH_OUTAGE_MS) || undefined,
    dataMs: Number(process.env.TVH_STREAM_DATA_MS) || undefined });

function status() { send({ ev: 'status', status: JSON.parse(JSON.stringify(st)) }); }
function setState(state, error) { st.state = state; st.error = error || null; st.since = Date.now(); status(); }
let lastSent = '';
function playbackStatus() {
    const j = JSON.stringify(pb.status());
    if (j !== lastSent) { lastSent = j; send({ ev: 'playback', status: JSON.parse(j) }); }
}
setInterval(playbackStatus, 1000);

/* ---------- what the app asks for (kept here, never on disk) ---------- */
const lists = new Map();      // cat id -> { at, channels }
const nowKept = new Map();    // stream id -> { until, value: { now, next } }
let all = null, allLoading = null;

async function refresh(force) {
    clearTimeout(timer);
    if (!running) return;
    try {
        if (st.state !== 'connected') setState('connecting');
        if (force || !st.server || Date.now() - infoAt > INFO_MS) { st.server = await xt.info(); infoAt = Date.now(); }
        if (force || !cats.length || Date.now() - catsAt > CATS_MS) {
            cats = (await xt.categories()).map((c) => ({ id: c.id, name: ascii(c.name) }));
            catsAt = Date.now();
            st.categories = cats.length;
            log(cats.length + ' categories');
            send({ ev: 'categories', at: catsAt, categories: cats });
        }
        backoff = RETRY_MIN;
        st.retries = 0;
        // every channel for search, loaded quietly once connected (about 15 s on a large account): the first search is then instant
        if (st.state !== 'connected' && !all && !allLoading) setTimeout(() => { if (running && !all) everything().catch((e) => log('search list: ' + e.message)); }, 20000);
        if (st.state !== 'connected') setState('connected'); else status();
        timer = setTimeout(() => refresh(false), INFO_MS);
    } catch (e) {
        if (!running) return;
        st.retries++;
        setState(e.code === 'EAUTH' ? 'refused' : 'error', e.message);
        log('server: ' + e.message + ' (again in ' + Math.round(backoff / 1000) + ' s)');
        timer = setTimeout(() => refresh(true), backoff);
        backoff = Math.min(60000, backoff * 2);
    }
}
function forget() { cats = []; catsAt = 0; infoAt = 0; lists.clear(); nowKept.clear(); all = null; }
function run(account) {
    xt.use(account);
    running = true;
    st.server = null;
    forget();
    refresh(true);
}
function stop() { running = false; clearTimeout(timer); pb.stop(); }

const view = (c) => ({ id: c.id, name: ascii(c.name), icon: c.icon, cat: c.cat, num: c.num, hevc: c.hevc });

async function channelsOf(cat) {
    const k = lists.get(cat);
    if (k && Date.now() - k.at < LIST_MS) return k.channels;
    const list = (await xt.channels(cat)).map(view);
    lists.set(cat, { at: Date.now(), channels: list });
    if (lists.size > 40) lists.delete(lists.keys().next().value);
    return list;
}
function everything() {
    if (all && Date.now() - all.at < ALL_MS) return Promise.resolve(all.channels);
    if (!allLoading) {
        log('loading every channel for search');
        allLoading = xt.allChannels().then((list) => {
            const chans = list.map(view);
            chans.forEach((c) => { c.key = c.name.toLowerCase(); });
            all = { at: Date.now(), channels: chans };
            log(chans.length + ' channels for search');
            allLoading = null;
            return chans;
        }, (e) => { allLoading = null; throw e; });
    }
    return allLoading;
}
async function search(q) {
    const words = ascii(q).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const list = await everything();
    // whole words first ("rds" finds RDS before Thunderbirds), then a name that starts with them, then anywhere
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const whole = words.map((w) => new RegExp('(^|[^a-z0-9])' + esc(w) + '($|[^a-z0-9])'));
    const hits = [];
    for (let i = 0; i < list.length; i++) {
        const k = list[i].key;
        if (!words.every((w) => k.indexOf(w) >= 0)) continue;
        const rank = whole.every((re) => re.test(k)) ? (whole[0].test(k.replace(/^\s*[a-z]{2,4}\s+/, '').slice(0, words[0].length + 1)) ? 0 : 1) : 2;
        hits.push({ c: list[i], rank });
    }
    hits.sort((x, y) => x.rank - y.rank || x.c.name.length - y.c.name.length);
    return hits.slice(0, 80).map((h) => view(h.c));
}
/** what is on now and next, per channel: asked 4 at a time, kept until the programme on now ends */
async function nowOf(ids) {
    const t = Date.now() / 1000, out = {};
    const todo = [];
    (Array.isArray(ids) ? ids : []).slice(0, 30).map(String).filter((id) => /^\d+$/.test(id)).forEach((id) => {
        const k = nowKept.get(id);
        if (k && k.until > t) out[id] = k.value; else todo.push(id);
    });
    const pick = (x) => (x ? { title: ascii(x.title), start: x.start, stop: x.stop, isNew: !!x.isNew } : null);
    for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map((id) => xt.shortEpg(id, 3).then((list) => {
            const cur = list.filter((x) => x.start <= t && x.stop > t)[0] || null;
            const next = list.filter((x) => (cur ? x.start >= cur.stop : x.start > t))[0] || null;
            const value = { now: pick(cur), next: pick(next) };
            nowKept.set(id, { until: cur ? cur.stop : t + 600, value });
            out[id] = value;
        }, () => { out[id] = { now: null, next: null, error: true }; })));
    }
    if (nowKept.size > 2000) nowKept.clear();
    return out;
}
async function guide(sid) {
    if (!/^\d+$/.test(sid)) throw new Error('not a channel');
    const list = await xt.shortEpg(sid, 24);
    return list.map((x) => ({ start: x.start, stop: x.stop, title: ascii(x.title), text: ascii(x.text), isNew: !!x.isNew }));
}
function answer(m) {
    const reply = (p) => p.then((value) => send({ ev: 'answer', id: m.id, ok: true, value }), (e) => send({ ev: 'answer', id: m.id, ok: false, error: e.message }));
    if (!xt.account()) return reply(Promise.reject(new Error('not signed in')));
    if (m.what === 'channels') return reply(channelsOf(String(m.cat || '')));
    if (m.what === 'search') return reply(search(String(m.q || '')));
    if (m.what === 'now') return reply(nowOf(m.ids));
    if (m.what === 'epg') return reply(guide(String(m.sid || '')));
    if (m.what === 'logo') return reply(xt.logo(m.icon).then((b) => b.toString('base64')));
    return reply(Promise.reject(new Error('unknown question')));
}

process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'run') run(m.account);
    else if (m.op === 'stop') stop();
    else if (m.op === 'refresh') refresh(true);
    else if (m.op === 'player') { pb.onPlayer(m.id, m.ev); if (m.ev && m.ev.ev !== 'tick') playbackStatus(); }
    else if (m.op === 'play') { pb.play(m.channel); playbackStatus(); }
    else if (m.op === 'playback-stop') { pb.stop(); playbackStatus(); }
    else if (m.op === 'prefs') { pb.setPrefs(m.prefs); playbackStatus(); }
    else if (m.op === 'ask') answer(m);
    else if (m.op === 'signout') { stop(); xt.use(null); forget(); setState('signed-out'); send({ ev: 'signed-out', why: 'signed out' }); }
    else if (m.op === 'signin') {
        xt.signIn(m.server, m.user, m.password)
            .then((account) => send({ ev: 'signin', id: m.id, ok: true, account }))
            .catch((e) => send({ ev: 'signin', id: m.id, ok: false, error: e.message }));
    }
});
// the parent went: so do we (a message sent as it went fails with EPIPE: nothing to report it to)
process.on('disconnect', () => { stop(); process.exit(0); });
process.on('error', () => { stop(); process.exit(0); });
send({ ev: 'ready', uid: process.getuid ? process.getuid() : null });
