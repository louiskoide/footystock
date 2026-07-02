#!/usr/bin/env node
// One-off diagnostic: inspect a specific player's events + unmatched-name
// list to explain a coverage discrepancy (e.g. Bellingham vs Kane). Zero
// API-Football calls — reads the worker's already-polled /prices.json.

const WORKER_URL = process.env.LIVE_WORKER_URL || 'https://footystock.fly.dev';
const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: node debug-player-events.mjs <id> [id...]'); process.exit(1); }

async function main() {
  const prices = await fetch(`${WORKER_URL}/prices.json`).then(r => r.json());
  for (const id of ids) {
    const p = prices.players[id];
    console.log(`\n=== ${id} ===`);
    if (!p) { console.log('NOT FOUND in worker players'); continue; }
    console.log('nation:', p.nation);
    console.log('events:', JSON.stringify(p.events, null, 2));
  }

  const engFixtures = (prices.teams['England'] || {}).fixtures || [];
  console.log('\nEngland fixtures on file:', JSON.stringify(engFixtures));
  console.log('England status:', (prices.teams['England'] || {}).status);

  const unmatched = await fetch(`${WORKER_URL}/debug/unmatched`).then(r => r.json());
  const englandUnmatched = Object.entries(unmatched).filter(([, nation]) => nation === 'England');
  console.log('\nEngland unmatched squad names:', JSON.stringify(englandUnmatched));
}

main().catch(e => { console.error(e); process.exit(1); });
