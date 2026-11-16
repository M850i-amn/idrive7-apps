'use strict';
/**
 * camprobe.js - where a camera picture could come from on this head unit. READ-ONLY: it lists directories
 * and reads small text files (/dev, /sys/class/video4linux, /proc/<pid>/cmdline), nothing else.
 *
 * Side View's whole idea rests on one unknown: does any camera picture reach the head unit while driving?
 * The windshield camera's (KAFAS) only with Augmented View, the mirror cameras' only with Surround View and
 * maybe only at parking speed. This answers what can be answered from inside an app: capture devices, their
 * names, and the processes that look like camera or video handlers. The full answer (HMI video surfaces,
 * SOME/IP camera services) needs the read-only SSH probe, tools/sideview_probe.sh.
 *
 * Node 8. Never throws.
 */
const fs = require('fs');
const path = require('path');

const WORDS = /camera|kamera|cam_|_cam|rvc|tvm|trsvc|kafas|surround|topview|sideview|augment|videoar|video_ar|cameraplayer|gstream|v4l2/i;

const ls = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
const read = (f, n) => { try { return fs.readFileSync(f).slice(0, n || 4096).toString('utf8'); } catch (e) { return null; } };

/** { devices: [{ dev, name }], media: [..], procs: [{ pid, cmd }], at } */
function probe(root) {
    const R = root || '';
    const out = { devices: [], media: [], procs: [], at: Date.now() };
    ls(R + '/dev').forEach((f) => {
        if (/^video\d+$/.test(f)) out.devices.push({ dev: '/dev/' + f, name: (read(R + '/sys/class/video4linux/' + f + '/name') || '').trim() });
        else if (/^(media\d+|v4l-subdev\d+)$/.test(f)) out.media.push('/dev/' + f);
    });
    ls(R + '/proc').forEach((pid) => {
        if (!/^\d+$/.test(pid)) return;
        const c = read(R + '/proc/' + pid + '/cmdline', 512);
        if (!c) return;
        const cmd = c.split('\0').filter(Boolean).join(' ');
        if (WORDS.test(cmd)) out.procs.push({ pid: +pid, cmd: cmd.length > 140 ? cmd.slice(0, 137) + '...' : cmd });
    });
    out.procs.sort((a, b) => a.pid - b.pid);
    return out;
}

/** The probe in lines for the screen and the log. */
function lines(p) {
    const L = [];
    L.push(p.devices.length ? 'Capture devices: ' + p.devices.map((d) => d.dev + (d.name ? ' (' + d.name + ')' : '')).join(', ') : 'Capture devices: none visible to the app');
    if (p.media.length) L.push('Media devices: ' + p.media.join(', '));
    L.push(p.procs.length ? 'Camera / video processes: ' + p.procs.length : 'Camera / video processes: none found');
    p.procs.slice(0, 8).forEach((x) => L.push('  ' + path.basename(x.cmd.split(' ')[0]) + '  ' + x.cmd.split(' ').slice(1).join(' ')));
    return L;
}

module.exports = { probe, lines, WORDS };
