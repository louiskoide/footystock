#!/usr/bin/env node
// One-off diagnostic: does TheSportsDB expose per-player goal scorer data
// for WC2026 matches? Not wired into the real pipeline — just dumps raw
// API shapes so we can decide whether to build on this source.
// Run: SPORTSDB_KEY=xxx node scripts/test-sportsdb.mjs
const KEY = process.env.SPORTSDB_KEY || '3'; // '3' is TheSportsDB's public test key
const BASE = `https://www.thesportsdb.com/api/v1/json/${KEY}`;
const WC_LEAGUE_ID = '4429'; // FIFA World Cup

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

async function main() {
  console.log('--- eventsseason.php (WC2026 fixture list) ---');
  const season = await get(`/eventsseason.php?id=${WC_LEAGUE_ID}&s=2026`);
  const events = season.events || [];
  console.log('total events:', events.length);
  console.log('SAMPLE_EVENT', JSON.stringify(events[0]));

  const finished = events.filter(e => e.intHomeScore != null && e.intAwayScore != null);
  console.log('finished (have scores):', finished.length);

  for (const ev of finished.slice(0, 3)) {
    console.log(`\n--- eventresults.php for ${ev.strHomeTeam} vs ${ev.strAwayTeam} (id ${ev.idEvent}) ---`);
    try {
      const results = await get(`/eventresults.php?id=${ev.idEvent}`);
      console.log('RESULTS_KEYS', JSON.stringify(Object.keys(results)));
      console.log('RESULTS_SAMPLE', JSON.stringify(results).slice(0, 2000));
    } catch (e) {
      console.error('eventresults.php failed:', e.message);
    }

    console.log(`--- lookupevent.php for id ${ev.idEvent} ---`);
    try {
      const lookup = await get(`/lookupevent.php?id=${ev.idEvent}`);
      console.log('LOOKUP_SAMPLE', JSON.stringify(lookup).slice(0, 2000));
    } catch (e) {
      console.error('lookupevent.php failed:', e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
