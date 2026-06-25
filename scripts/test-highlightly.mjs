#!/usr/bin/env node
// Throwaway diagnostic script — NOT part of the pipeline. Probes Highlightly's
// real API shape (param names, WC 2026 coverage, per-player stat depth) so we
// can decide whether to build update-prices.mjs against it. Delete after use.
const KEY = process.env.HIGHLIGHTLY_API_KEY;
const HOST = 'sport-highlights-api.p.rapidapi.com';
const BASE = `https://${HOST}/football`;

if (!KEY) { console.error('HIGHLIGHTLY_API_KEY not set'); process.exit(1); }

async function get(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  console.log(`\n=== GET ${url.pathname}?${url.searchParams} ===`);
  try {
    const res = await fetch(url, { headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST } });
    const text = await res.text();
    console.log(`status: ${res.status}`);
    console.log(text.slice(0, 4000));
    return res.ok ? JSON.parse(text) : null;
  } catch (e) {
    console.log('fetch error:', e.message);
    return null;
  }
}

async function main() {
  // 1. find the World Cup league id — try a few plausible search param names
  let leagues = await get('/leagues', { name: 'World Cup' });
  if (!leagues?.data?.length) leagues = await get('/leagues', { search: 'World Cup' });
  if (!leagues?.data?.length) leagues = await get('/leagues', { country: 'World' });

  const wc = leagues?.data?.find(l => /world cup/i.test(l.name) && !/u-?20|u-?17|women/i.test(l.name));
  if (!wc) { console.log('\nCould not find FIFA World Cup in /leagues response.'); return; }
  console.log(`\nFound league: ${wc.name} (id=${wc.id}), seasons:`, JSON.stringify(wc.seasons));

  // 2. matches for that league, season 2026 — try plausible filter param names
  let matches = await get('/matches', { leagueId: wc.id, season: '2026' });
  if (!matches?.data?.length) matches = await get('/matches', { league: wc.id, season: 2026 });

  const finished = matches?.data?.find(m => /finished|ft|ended/i.test(m.status?.long || m.status || ''));
  if (!finished) { console.log('\nNo finished 2026 WC match found in /matches response.'); return; }
  console.log('\nUsing match:', JSON.stringify(finished).slice(0, 500));
  const matchId = finished.id;

  // 3. stats + players for that match
  await get(`/statistics/${matchId}`);
  await get('/players', { matchId });
  await get(`/players/${matchId}`);
}

main();
