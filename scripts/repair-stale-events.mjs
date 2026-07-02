#!/usr/bin/env node
// One-off: triggers the worker's /admin/repair-stale-events route, which
// finds fixtures stuck showing a stale bench marker (min:0/rating:null)
// after already exhausting their normal grace-polls, and re-fetches just
// those — no full rebuild, no other data touched. See
// repairStaleFixtures() in scripts/live-worker/poll.mjs for why this is
// needed (a fixture can exhaust its retries while API-Football is still
// finishing its box score, permanently locking in a wrong "benched" read).

const WORKER_URL = process.env.LIVE_WORKER_URL || 'https://footystock.fly.dev';

async function main() {
  const resp = await fetch(`${WORKER_URL}/admin/repair-stale-events`, { method: 'POST' });
  const data = await resp.json();
  if (!resp.ok) { console.error('ERROR:', JSON.stringify(data)); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
