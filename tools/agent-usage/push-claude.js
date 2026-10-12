#!/usr/bin/env node
'use strict';
// Reads Claude Code's local usage logs (~/.claude/projects/**/*.jsonl), adds up TOKEN COUNTS per day, and sends
// those numbers to the frame hub. Only the numeric `usage` fields, the model name and the timestamp are read from
// each line; message text is never stored or sent.
//
//   node push-claude.js --dry-run     show what would be sent
//   node push-claude.js               send it to the hub
//
// Settings come from tools/agent-usage/config.local.json (not committed):  { "hubUrl": "http://hub.local:8099", "token": "..." }
// or the environment variables FRAME_HUB_URL and FRAME_AGENTS_TOKEN. Optional: "timezone" (default: this computer's timezone).
const fs = require('fs');
const os = require('os');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const cfgFile = path.join(__dirname, 'config.local.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { /* optional */ }
const HUB = (process.env.FRAME_HUB_URL || cfg.hubUrl || '').replace(/\/$/, '');
const TOKEN = process.env.FRAME_AGENTS_TOKEN || cfg.token || '';
const TZ = cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAYS = 14;                      // days of history to send
const pricing = JSON.parse(fs.readFileSync(path.join(__dirname, 'pricing.json'), 'utf8'));

const roots = [path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.config', 'claude', 'projects')]
  .filter((p) => fs.existsSync(p));
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.name.endsWith('.jsonl')) yield p;
  }
}
const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });   // YYYY-MM-DD in the household's timezone

// 1) read every assistant line that carries usage; the same message can be logged more than once, keep the last copy
const seen = new Map();
let files = 0, lines = 0, bad = 0;
for (const root of roots) {
  for (const f of walk(root)) {
    files++;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      lines++;
      let o; try { o = JSON.parse(line); } catch (e) { bad++; continue; }
      const m = o.message, u = m && m.usage;
      if (!u || !o.timestamp) continue;
      const key = (m.id || '') + '|' + (o.requestId || '') + (m.id ? '' : '|' + o.uuid);
      seen.set(key, { ts: o.timestamp, model: m.model || 'unknown', u });
    }
  }
}

// 2) add up per day and per model
const days = {};
const unknownModels = new Set();
for (const { ts, model, u } of seen.values()) {
  if (model === '<synthetic>') continue;
  const d = dayOf(ts);
  const slot = (days[d] = days[d] || { date: d, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, models: {} });
  const input = u.input_tokens || 0, output = u.output_tokens || 0, cacheRead = u.cache_read_input_tokens || 0;
  const cc = u.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : (u.cache_creation_input_tokens || 0);
  const w1 = cc.ephemeral_1h_input_tokens || 0;
  slot.input += input; slot.output += output; slot.cacheRead += cacheRead; slot.cacheWrite += w5 + w1;
  const mm = (slot.models[model] = slot.models[model] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
  mm.input += input; mm.output += output; mm.cacheRead += cacheRead; mm.cacheWrite += w5 + w1; mm.messages++;
  const p = pricing[model];
  if (p) slot.cost += (input * p.input + output * p.output + cacheRead * p.cache_read + w5 * p.cache_write_5m + w1 * p.cache_write_1h) / 1e6;
  else unknownModels.add(model);
}

const cutoff = dayOf(new Date(Date.now() - (DAYS - 1) * 864e5).toISOString());
const list = Object.values(days).filter((d) => d.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date))
  .map((d) => Object.assign(d, { cost: Math.round(d.cost * 100) / 100 }));

const payload = {
  source: os.hostname(),
  generated: new Date().toISOString(),
  timezone: TZ,
  services: [{
    id: 'claude', name: 'Claude', plan: 'Claude Code', color: '#D97757',
    costNote: 'API-equivalent estimate from list prices' + (unknownModels.size ? '; no price for ' + [...unknownModels].join(', ') : ''),
    days: list
  }]
};

console.log('read ' + files + ' log file(s), ' + lines + ' lines (' + bad + ' unreadable), ' + seen.size + ' unique messages');
for (const d of list) {
  console.log(d.date + '  new tokens ' + String(d.input + d.output + d.cacheWrite).padStart(10) + '  output ' + String(d.output).padStart(9) +
    '  cache reads ' + String(d.cacheRead).padStart(11) + '  est. cost $' + d.cost.toFixed(2) + '  models: ' + Object.keys(d.models).join(', '));
}
if (unknownModels.size) console.log('WARNING: no price for ' + [...unknownModels].join(', ') + ' (add it to pricing.json)');

if (DRY) { console.log('dry run, nothing sent'); process.exit(0); }
if (!HUB) { console.error('No hub address: set hubUrl in config.local.json or FRAME_HUB_URL'); process.exit(1); }
fetch(HUB + '/api/agents', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-Agent-Token': TOKEN },
  body: JSON.stringify(payload)
}).then(async (r) => {
  const t = await r.text();
  if (!r.ok) { console.error('hub said ' + r.status + ': ' + t); process.exit(1); }
  console.log('sent to ' + HUB + ' (' + r.status + ')');
}).catch((e) => { console.error('could not reach the hub: ' + e.message); process.exit(1); });
