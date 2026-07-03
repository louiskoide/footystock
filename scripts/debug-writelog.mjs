#!/usr/bin/env node
// One-off diagnostic: dumps the worker's global write-audit trail
// (/debug/writelog) — every write to any player's event, from both the
// normal poll loop ('poll-finished'/'poll-live') and manual repairs
// ('repair'), tagged with source + timestamp. Used to catch a concurrent
// poll cycle overwriting a repair's write for the same player right after
// it lands, which a single function's own before/after check can't see.
//
// Usage: node debug-writelog.mjs [playerId]  (blank = full log)

const WORKER_URL = process.env.LIVE_WORKER_URL || 'https://footystock.fly.dev';
const id = process.argv[2];

async function main() {
  const qs = id ? `?id=${encodeURIComponent(id)}` : '';
  const resp = await fetch(`${WORKER_URL}/debug/writelog${qs}`);
  const data = await resp.json();
  if (!resp.ok) { console.error('ERROR:', JSON.stringify(data)); process.exit(1); }
  console.log(`count: ${data.count}`);
  for (const w of data.entries || []) {
    console.log(`${w.ts}  source=${w.source.padEnd(14)} branch=${w.branch.padEnd(6)} fid=${w.fid} id=${w.id} nation=${w.nation} min=${w.min} rating=${w.rating}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
