#!/usr/bin/env node
/**
 * Manual-only diagnostic (see .github/workflows/diagnose-worker.yml): reports
 * how much World Cup fixture/event data the live worker has recovered after
 * a redeploy, and how much real (non-flat) price history Supabase holds.
 * Read-only — zero API-Football calls, zero writes. Run from CI, not this
 * sandbox, since footystock.fly.dev and Supabase aren't reachable here.
 *
 * Usage: node scripts/diagnose-worker.mjs
 */

const WORKER_URL = process.env.LIVE_WORKER_URL || 'https://footystock.fly.dev';
const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';

async function main() {
  console.log(`Worker: ${WORKER_URL}`);
  const health = await fetch(`${WORKER_URL}/health`).then(r => r.json()).catch(e => ({ error: e.message }));
  console.log('health:', JSON.stringify(health));

  const prices = await fetch(`${WORKER_URL}/prices.json`).then(r => r.json());
  const teamCount = Object.keys(prices.teams || {}).length;
  const players = Object.entries(prices.players || {});
  let withEvents = 0, totalEvents = 0, ratedEvents = 0;
  for (const [, p] of players) {
    const evs = p.events || [];
    if (evs.length) withEvents++;
    totalEvents += evs.length;
    ratedEvents += evs.filter(e => e.rating != null).length;
  }
  const fixturesPlayed = Object.values(prices.teams || {}).reduce((s, t) => s + (t.fixtures || []).length, 0);
  console.log(`teams: ${teamCount}, team-fixture-entries: ${fixturesPlayed}`);
  console.log(`players tracked: ${players.length}, players with events: ${withEvents}`);
  console.log(`total events: ${totalEvents}, rated (played) events: ${ratedEvents}`);
  console.log(`worker priceHist keys: ${Object.keys(prices.priceHist || {}).length}`);

  const sample = players.filter(([, p]) => (p.events || []).length > 0).slice(0, 3);
  for (const [id, p] of sample) {
    console.log(`  sample ${id}: ${p.events.length} events, nation=${p.nation}`);
  }

  console.log('\nSupabase price_history:');
  const rows = await fetch(
    `${SUPABASE_URL}/rest/v1/price_history?select=player_id,day_key,price&order=day_key.asc&limit=100000`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  ).then(r => r.json());
  console.log(`total rows: ${rows.length}`);
  const dayKeys = new Set(rows.map(r => r.day_key));
  const playerIds = new Set(rows.map(r => r.player_id));
  console.log(`distinct day_keys: ${dayKeys.size} (${[...dayKeys].sort().slice(0, 3).join(', ')} ... ${[...dayKeys].sort().slice(-3).join(', ')})`);
  console.log(`distinct players: ${playerIds.size}`);

  // Flatness check: for a sample of players with WC events, how many distinct
  // prices do they have across their stored days?
  const byPlayer = {};
  for (const r of rows) (byPlayer[r.player_id] ||= []).push(r);
  let flatCount = 0, checked = 0;
  for (const [id, p] of players.slice(0, 200)) {
    if (!(p.events || []).length) continue;
    const hist = byPlayer[id];
    if (!hist || hist.length < 3) continue;
    checked++;
    const uniquePrices = new Set(hist.map(h => Math.round(parseFloat(h.price))));
    if (uniquePrices.size <= 1) flatCount++;
  }
  console.log(`WC players checked for flat history: ${checked}, completely flat: ${flatCount}`);
}

main().catch(e => { console.error(e); process.exit(1); });
