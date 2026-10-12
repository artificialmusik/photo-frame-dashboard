#!/usr/bin/env node
'use strict';
// Watches the frame hub for a "refresh" request from the Agents screen (tap the refresh button, or open the tab when
// the numbers are stale) and runs push-claude.js when one is waiting. It only asks the hub a tiny question every
// 15 seconds; nothing is sent unless a refresh is wanted.
//
//   node watch-claude.js
//
// Uses the same settings as push-claude.js (config.local.json, or FRAME_HUB_URL / FRAME_AGENTS_TOKEN).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8')); } catch (e) { /* env only */ }
const HUB = (process.env.FRAME_HUB_URL || cfg.hubUrl || '').replace(/\/$/, '');
const POLL_MS = 15000;
if (!HUB) { console.error('No hub address: set hubUrl in config.local.json or FRAME_HUB_URL'); process.exit(1); }

const stamp = () => new Date().toLocaleTimeString();
let running = false, downSince = 0;

function runCollector(why) {
  running = true;
  console.log(stamp() + '  ' + why + ' -> running push-claude.js');
  execFile(process.execPath, [path.join(__dirname, 'push-claude.js')], { env: process.env, timeout: 120000 }, (err, out, errOut) => {
    running = false;
    if (err) console.log(stamp() + '  collector failed: ' + (errOut || err.message).trim().split('\n').pop());
    else console.log(stamp() + '  ' + out.trim().split('\n').pop());
  });
}

async function poll() {
  if (running) return;
  try {
    const r = await fetch(HUB + '/api/agents', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const a = await r.json();
    if (downSince) { console.log(stamp() + '  hub is back'); downSince = 0; }
    const claude = (a.services || []).find((s) => s.id === 'claude');
    const updated = claude ? Date.parse(claude.updated) || 0 : 0;
    const requested = Date.parse(a.requestedAt || '') || 0;
    if (!claude) runCollector('no data on the hub yet');
    else if (requested > updated) runCollector('refresh requested from the frame');
  } catch (e) {
    if (!downSince) { downSince = Date.now(); console.log(stamp() + '  cannot reach the hub (' + e.message + '), will keep trying'); }
  }
}

console.log(stamp() + '  watching ' + HUB + ' every ' + POLL_MS / 1000 + 's (Ctrl+C to stop)');
poll();
setInterval(poll, POLL_MS);
