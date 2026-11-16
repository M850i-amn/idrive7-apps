'use strict';
/**
 * xtream.js - an Xtream Codes IPTV account (player_api.php), as the signed-in user: the account, the live
 * categories, a category's channels, every channel (for search), what is on now and next, a channel's guide, a logo,
 * and a channel's live stream (MPEG-TS). Runs in the client (client.js, the tool's internet uid). It takes the place
 * of aurelm-tvhplayer's tvh.js (Tvheadend) and keeps the shape playback.js uses: stream(id, profile) -> { status, res, abort }.
 *
 *   const x = createXtream({ nx, log, now });
 *   await x.signIn(serverText, user, password) -> account { server, user, password, serverName, expires, maxConnections, at }
 *   x.use(account)
 *   await x.info()             { name, status, expires, maxConnections, activeConnections, timezone }
 *   await x.categories()       [{ id, name, count? }]
 *   await x.channels(catId)    [{ id, name, icon, cat, num, hevc }] (live streams of one category)
 *   await x.allChannels()      the same for every live stream (search); large: kept by the client
 *   await x.shortEpg(id, n)    [{ start, stop, title, text }] (seconds since 1970), from now
 *   await x.stream(id)         -> { status, res, abort }: /live/<user>/<password>/<id>.ts, redirects followed (netx)
 *   await x.logo(url)          a logo's bytes (PNG or JPEG), at most 1 MiB
 *   x.profiles()               null: Xtream has no stream profiles (playback.js then keeps one)
 *
 * Privacy: the user and the password are in the API's query string and the stream's path. Nothing here logs a URL,
 * and errors are reported without one (the server's host at most). The password is kept by the service (state,
 * 0600, root's), never in this repository.
 *
 * Plain Node 8.
 */
const qs = require('querystring');

const UA = 'VLC/3.0.20 LibVLC/3.0.20';     // Xtream panels commonly refuse unknown players
const API_TIMEOUT = 20000;
const ALL_TIMEOUT = 90000;
const ALL_MAX = 64 * 1024 * 1024;           // every live stream of a large account: ~22,000 entries
const LOGO_MAX = 1024 * 1024;
// channels the head unit's decoder cannot play (H.264 only): HEVC / H.265, and what panels label 4K / UHD
const HEVC = /\b(hevc|h\.?265|x265|4k|uhd|2160p)\b/i;

/** "example.com:8080/" -> ['http://example.com:8080', 'https://example.com:8080']; a scheme given is kept */
function candidates(text) {
    const s = String(text || '').trim().replace(/\/+$/, '').replace(/\/(player_api|get|xmltv)\.php.*$/i, '');
    if (!s) return [];
    if (/^https?:\/\//i.test(s)) return [s.replace(/^HTTPS?/i, (m) => m.toLowerCase())];
    return ['http://' + s, 'https://' + s];
}
/** the server's host, for messages (never the path or the query) */
function hostOf(u) { const m = /^https?:\/\/([^/?#]+)/i.exec(String(u || '')); return m ? m[1] : '?'; }
/** Xtream's base64 EPG text */
function b64(s) { try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch (e) { return String(s || ''); } }
/** an EPG title without the panels' superscript "New" (ᴺᵉʷ), which the fonts cannot draw */
function cleanTitle(s) { return String(s || '').replace(/[ᴺᵉʷᵂ]+/g, '').replace(/\s+/g, ' ').trim(); }

function createXtream(o) {
    const nx = o.nx, log = o.log || (() => {}), now = o.now || Date.now;
    let acc = null;

    function use(account) { acc = account || null; }
    function need() { if (!acc) { const e = new Error('not signed in'); e.code = 'EAUTH'; throw e; } }

    async function api(base, user, password, params, opts) {
        const q = qs.stringify(Object.assign({ username: user, password }, params || {}));
        let r;
        try {
            r = await nx.request({ method: 'GET', url: base + '/player_api.php?' + q, headers: { 'User-Agent': UA, Accept: 'application/json' },
                timeoutMs: (opts && opts.timeoutMs) || API_TIMEOUT, maxBytes: (opts && opts.maxBytes) || undefined });
        } catch (e) {
            const x = new Error((e.code === 'EOFFLINE' ? 'no internet (phone hotspot or Wi-Fi in the Store)' : 'no answer from ' + hostOf(base)) +
                (e.code && e.code !== 'EOFFLINE' ? ' (' + e.code + ')' : ''));
            x.code = e.code;
            throw x;
        }
        if (r.status === 401 || r.status === 403) { const e = new Error('the server refused the user (' + r.status + ')'); e.code = 'EAUTH'; throw e; }
        if (r.status !== 200) throw new Error(hostOf(base) + ' answered HTTP ' + r.status);
        let j;
        try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { throw new Error(hostOf(base) + ' did not answer as an Xtream server'); }
        return j;
    }
    const call = (params, opts) => { need(); return api(acc.server, acc.user, acc.password, params, opts); };

    /** proves the user and the password, and finds the address that answers */
    async function signIn(serverText, user, password) {
        const list = candidates(serverText);
        if (!list.length) throw new Error('enter the server address');
        if (!user || !password) throw new Error('enter the user name and the password');
        let last = null;
        for (let i = 0; i < list.length; i++) {
            try {
                const j = await api(list[i], user, password, null);
                const ui = j && j.user_info, si = (j && j.server_info) || {};
                if (!ui || Number(ui.auth) !== 1) { const e = new Error('wrong user name or password'); e.code = 'EAUTH'; throw e; }
                if (ui.status && String(ui.status).toLowerCase() !== 'active') { const e = new Error('the account is ' + ui.status); e.code = 'EAUTH'; throw e; }
                log('signed in at ' + hostOf(list[i]));
                return { server: list[i], user, password, serverName: si.url || hostOf(list[i]), expires: Number(ui.exp_date) || null,
                    maxConnections: Number(ui.max_connections) || null, at: now() };
            } catch (e) {
                last = e;
                if (e.code === 'EAUTH') throw e;      // the server answered: another address will not change that
            }
        }
        throw last || new Error('no answer');
    }

    async function info() {
        const j = await call(null);
        const ui = (j && j.user_info) || {}, si = (j && j.server_info) || {};
        if (Number(ui.auth) !== 1) { const e = new Error('the server no longer accepts the user'); e.code = 'EAUTH'; throw e; }
        return { name: si.url || hostOf(acc.server), status: ui.status || null, expires: Number(ui.exp_date) || null,
            maxConnections: Number(ui.max_connections) || null, activeConnections: Number(ui.active_cons) || 0, timezone: si.timezone || null };
    }

    async function categories() {
        const j = await call({ action: 'get_live_categories' });
        return (Array.isArray(j) ? j : []).map((c) => ({ id: String(c.category_id), name: String(c.category_name || '') }));
    }
    const slim = (s) => ({ id: Number(s.stream_id), name: String(s.name || ''), icon: /^https?:\/\//i.test(s.stream_icon || '') ? String(s.stream_icon) : '',
        cat: String(s.category_id || ''), num: Number(s.num) || null, hevc: HEVC.test(String(s.name || '')) });
    async function channels(catId) {
        const j = await call({ action: 'get_live_streams', category_id: String(catId) });
        return (Array.isArray(j) ? j : []).filter((s) => s && s.stream_id).map(slim);
    }
    async function allChannels() {
        const j = await call({ action: 'get_live_streams' }, { timeoutMs: ALL_TIMEOUT, maxBytes: ALL_MAX });
        return (Array.isArray(j) ? j : []).filter((s) => s && s.stream_id).map(slim);
    }

    async function shortEpg(id, limit) {
        const j = await call({ action: 'get_short_epg', stream_id: String(id), limit: String(limit || 4) });
        const list = (j && Array.isArray(j.epg_listings)) ? j.epg_listings : [];
        return list.map((x) => ({ start: Number(x.start_timestamp) || 0, stop: Number(x.stop_timestamp) || 0,
            title: cleanTitle(b64(x.title)), text: b64(x.description).slice(0, 1200), isNew: /ᴺ/.test(b64(x.title)) }))
            .filter((x) => x.stop > now() / 1000 - 60).sort((a, b) => a.start - b.start);
    }

    function stream(id) {
        need();
        const sid = String(id);
        if (!/^\d+$/.test(sid)) return Promise.reject(new Error('not a channel'));
        const u = acc.server + '/live/' + encodeURIComponent(acc.user) + '/' + encodeURIComponent(acc.password) + '/' + sid + '.ts';
        return nx.stream({ url: u, headers: { 'User-Agent': UA, Accept: '*/*' }, timeoutMs: 30000 }).catch((e) => {
            const x = new Error('the stream did not open (' + (e.code || 'no answer from ' + hostOf(acc.server)) + ')');
            x.code = e.code;
            throw x;
        });
    }

    async function logo(url) {
        if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('no logo');
        const r = await nx.request({ method: 'GET', url: String(url), headers: { 'User-Agent': UA }, timeoutMs: 15000, maxBytes: LOGO_MAX });
        if (r.status !== 200) throw new Error('logo: HTTP ' + r.status);
        const b = r.body;
        const png = b.length > 8 && b[0] === 0x89 && b[1] === 0x50, jpg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
        if (!png && !jpg) throw new Error('logo: not a PNG or JPEG');
        return b;
    }

    return { signIn, use, info, categories, channels, allChannels, shortEpg, stream, logo, profiles: () => null, account: () => acc };
}

module.exports = { createXtream, candidates, hostOf, cleanTitle, HEVC, UA };
