#!/usr/bin/env node
// One-off: triggers the worker's /admin/repair-stale-events route, which
// finds fixtures stuck showing a stale bench marker (min:0/rating:null)
// after already exhausting their normal grace-polls, and re-fetches just
// those — no full rebuild, no other data touched. See
// repairStaleFixtures() in scripts/live-worker/poll.mjs for why this is
// needed (a fixture can exhaust its retries while API-Football is still
// finishing its box score, permanently locking in a wrong "benched" read).

// Optional args: player ids to highlight from the full `details` list (the
// response can cover 100+ players; passing ids prints just those in full
// plus the overall summary, instead of dumping everything).
const watchIds = new Set(process.argv.slice(2));

const WORKER_URL = process.env.LIVE_WORKER_URL || 'https://footystock.fly.dev';

async function main() {
  const resp = await fetch(`${WORKER_URL}/admin/repair-stale-events`, { method: 'POST' });
  const data = await resp.json();
  if (!resp.ok) { console.error('ERROR:', JSON.stringify(data)); process.exit(1); }
  console.log(JSON.stringify({ checked: data.checked, repaired: data.repaired, detailsCount: data.details?.length }, null, 2));
  if (watchIds.size) {
    const matches = (data.details || []).filter(d => watchIds.has(d.id));
    console.log(`\n--- watched ids (${matches.length} match(es)) ---`);
    console.log(JSON.stringify(matches, null, 2));
  } else {
    console.log('\n--- full details ---');
    console.log(JSON.stringify(data.details, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
