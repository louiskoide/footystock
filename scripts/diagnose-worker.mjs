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

  const unmatched = await fetch(`${WORKER_URL}/debug/unmatched`).then(r => r.json()).catch(e => ({ error: e.message }));
  const unmatchedCount = Object.keys(unmatched).length;
  console.log(`\nunmatched squad names: ${unmatchedCount}`);
  const byNation = {};
  for (const [name, nation] of Object.entries(unmatched)) (byNation[nation] ||= []).push(name);
  const nationsShown = Object.keys(byNation).slice(0, 8);
  for (const n of nationsShown) console.log(`  ${n}: ${byNation[n].slice(0, 5).join(', ')}${byNation[n].length > 5 ? ` (+${byNation[n].length - 5} more)` : ''}`);

  console.log('\nSupabase price_history:');
  // Supabase/PostgREST caps every response at db-max-rows (commonly 1000)
  // REGARDLESS of a client-supplied ?limit — a plain GET with limit=100000
  // silently truncates instead of erroring, which previously made this
  // script report "total rows: 1000" even when the table held 77k+ rows.
  // Use a HEAD request with Prefer: count=exact to get the real total
  // cheaply (no row cap applies to the count, only to returned rows).
  const countResp = await fetch(`${SUPABASE_URL}/rest/v1/price_history?select=player_id`, {
    method: 'HEAD',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'count=exact' },
  });
  const totalRows = parseInt((countResp.headers.get('content-range') || '').split('/')[1] || '0', 10);
  console.log(`total rows: ${totalRows}`);

  // Distinct-day/flatness check: query specific known players directly
  // (small, well under the row cap) rather than trying to page through the
  // whole table. Mix of a transfer-window player and a couple of others.
  const sampleIds = ['anthony-gordon-barcelona', 'ismael-saibari-bayern', 'elliot-anderson-man-city']
    .concat(players.filter(([, p]) => (p.events || []).length > 0).slice(0, 5).map(([id]) => id));
  for (const id of sampleIds) {
    const hist = await fetch(
      `${SUPABASE_URL}/rest/v1/price_history?player_id=eq.${encodeURIComponent(id)}&select=day_key,price&order=day_key.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    ).then(r => r.json()).catch(() => []);
    if (!Array.isArray(hist) || !hist.length) { console.log(`  ${id}: no rows`); continue; }
    const uniquePrices = new Set(hist.map(h => Math.round(parseFloat(h.price) * 100)));
    console.log(`  ${id}: ${hist.length} days (${hist[0].day_key} .. ${hist[hist.length - 1].day_key}), ${uniquePrices.size} distinct prices, last 5: ${hist.slice(-5).map(h => h.price).join(', ')}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
