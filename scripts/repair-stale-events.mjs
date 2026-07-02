#!/usr/bin/env node
// One-off: triggers the worker's /admin/repair-stale-events route, which
// finds fixtures stuck showing a stale bench marker (min:0/rating:null)
// after already exhausting their normal grace-polls, and re-fetches just
// those — no full rebuild, no other data touched. See
// repairStaleFixtures() in scripts/live-worker/poll.mjs for why this is
// needed (a fixture can exhaust its retries while API-Football is still
// finishing its box score, permanently locking in a wrong "benched" read).

// Optional args: --full to widen the sweep to every finished tracked-nation
// fixture (not just ones flagged with a stale 0/null bench marker) — needed
// to catch the matchPlayer-collision outcome that lands on a wrong-but-
// nonzero value, which looks like an ordinary played event from stored
// state alone. Remaining args: player ids to highlight from the full
// `details` list (the response can cover 100+ players; passing ids prints
// just those in full plus the overall summary, instead of dumping
// everything). `details` is empty in --full mode (see repairStaleFixtures).
const args = process.argv.slice(2);
const full = args.includes('--full');
const watchIds = new Set(args.filter(a => a !== '--full'));

const WORKER_URL = process.env.LIVE_WORKER_URL || 'https://footystock.fly.dev';

async function main() {
  const resp = await fetch(`${WORKER_URL}/admin/repair-stale-events${full ? '?full=1' : ''}`, { method: 'POST' });
  const data = await resp.json();
  if (!resp.ok) { console.error('ERROR:', JSON.stringify(data)); process.exit(1); }
  const details = data.details || [];
  const written = details.filter(d => d.writtenThisCall);
  const reverted = details.filter(d => d.reverted);
  console.log(JSON.stringify({
    checked: data.checked,
    repaired: data.repaired,
    detailsCount: details.length,
    writtenThisCall: written.length,
    revertedCount: reverted.length,
  }, null, 2));
  if (reverted.length) {
    console.log(`\n--- REVERTED (${reverted.length} of ${written.length} written) — immediate write differs from final read ---`);
    console.log(JSON.stringify(reverted, null, 2));
  }
  if (watchIds.size) {
    const matches = details.filter(d => watchIds.has(d.id));
    console.log(`\n--- watched ids (${matches.length} match(es)) ---`);
    console.log(JSON.stringify(matches, null, 2));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
