#!/usr/bin/env node
// One-off diagnostic: confirm what API-Football actually returns for WC2026 —
// fixture coverage, per-player stats (tackles/duels/dribbles), and whether xG
// is present — before building the live worker on top of it.
// Run: API_FOOTBALL_KEY=xxx node scripts/test-api-football.mjs
const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) { console.error('API_FOOTBALL_KEY not set'); process.exit(1); }

const BASE = 'https://v3.football.api-sports.io';
const WC_LEAGUE_ID = 1; // World Cup
const SEASON = 2026;

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': KEY } });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}: ${JSON.stringify(body).slice(0, 500)}`);
  if (body.errors && Object.keys(body.errors).length) {
    console.error('API errors:', JSON.stringify(body.errors));
  }
  return body;
}

async function main() {
  console.log('--- /leagues coverage for World Cup', SEASON, '---');
  const leagues = await get(`/leagues?id=${WC_LEAGUE_ID}`);
  const season = (leagues.response?.[0]?.seasons || []).find(s => s.year === SEASON);
  console.log('SEASON_COVERAGE', JSON.stringify(season?.coverage, null, 2));

  console.log('\n--- /fixtures for WC', SEASON, '---');
  const fixtures = await get(`/fixtures?league=${WC_LEAGUE_ID}&season=${SEASON}`);
  const all = fixtures.response || [];
  console.log('total fixtures:', all.length);
  const finished = all.filter(f => f.fixture.status.short === 'FT');
  console.log('finished (FT):', finished.length);
  if (!finished.length) { console.log('No finished matches yet — nothing more to probe.'); return; }

  const sample = finished[0];
  const fid = sample.fixture.id;
  console.log(`\nSample fixture: ${sample.teams.home.name} vs ${sample.teams.away.name} (id ${fid})`);

  console.log('\n--- /fixtures/statistics?fixture=', fid, '---');
  const stats = await get(`/fixtures/statistics?fixture=${fid}`);
  for (const teamBlock of stats.response || []) {
    console.log(teamBlock.team.name, JSON.stringify(teamBlock.statistics));
  }

  console.log('\n--- /fixtures/players?fixture=', fid, '---');
  const players = await get(`/fixtures/players?fixture=${fid}`);
  const firstTeam = players.response?.[0];
  console.log('teams returned:', (players.response || []).length);
  const firstPlayer = firstTeam?.players?.[0];
  console.log('SAMPLE_PLAYER_STATS', JSON.stringify(firstPlayer, null, 2));

  console.log('\n--- /fixtures/events?fixture=', fid, '(goals/cards timeline) ---');
  const events = await get(`/fixtures/events?fixture=${fid}`);
  console.log('event count:', (events.response || []).length);
  console.log('SAMPLE_EVENTS', JSON.stringify((events.response || []).slice(0, 5), null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
