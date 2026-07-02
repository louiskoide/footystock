#!/usr/bin/env node
// One-off diagnostic: hits the worker's /debug/rawstats route (added
// alongside this script) to see exactly what API-Football reports
// (games.substitute/minutes/rating) for every player on a nation's side in a
// given player's most recent fixture — used to check whether a "benched"
// event (min:0/rating:null) reflects real API data for the whole roster
// (an upstream population artifact) or is isolated to one/few players (a
// matching bug). Zero writes; the route itself makes one extra API-Football
// call per id passed.

const WORKER_URL = process.env.LIVE_WORKER_URL || 'https://footystock.fly.dev';
const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: node debug-rawstats.mjs <id> [id...]'); process.exit(1); }

async function main() {
  for (const id of ids) {
    console.log(`\n=== ${id} ===`);
    const resp = await fetch(`${WORKER_URL}/debug/rawstats?id=${encodeURIComponent(id)}`);
    const data = await resp.json();
    if (!resp.ok) { console.log('ERROR:', JSON.stringify(data)); continue; }
    console.log('fixture id:', data.fid, '| nation:', data.nation, '| team block found:', data.teamBlockFound);
    for (const pl of data.players || []) {
      console.log(`  ${pl.name.padEnd(28)} substitute=${String(pl.games?.substitute).padEnd(6)} minutes=${String(pl.games?.minutes).padEnd(5)} rating=${pl.games?.rating}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
