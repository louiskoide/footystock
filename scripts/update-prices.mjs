#!/usr/bin/env node
// Daily data pipeline (see /data-sources.md, step 1 of the build order):
// pulls real 2026 World Cup results + per-player events from API-Football,
// computes WC-driven price inputs, and writes prices.json. The frontend only
// ever reads that file — this script is the one place allowed to call the
// external API (see CLAUDE.md: never fetch data APIs from the browser).
//
// Run: API_FOOTBALL_KEY=xxx node scripts/update-prices.mjs
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'FootyStock_dc.html');
const OUT_PATH = path.join(ROOT, 'prices.json');

const API_KEY = process.env.API_FOOTBALL_KEY;
const SEASON = process.env.WC_SEASON || '2026';
const LEAGUE_ID = 1; // API-Football: FIFA World Cup
const API_BASE = 'https://v3.football.api-sports.io';

if (!API_KEY) {
  console.error('API_FOOTBALL_KEY not set — skipping fetch, leaving prices.json untouched.');
  process.exit(0);
}

function slug(name) {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function normName(name) {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, '').trim();
}

// API-Football sometimes names a country differently than our DATA(). Map
// API name -> the nation key we use internally.
const NATION_ALIASES = {
  'usa': 'USA', 'united states': 'USA',
  'ivory coast': 'Ivory Coast', "cote d'ivoire": 'Ivory Coast', 'côte d’ivoire': 'Ivory Coast',
  'dr congo': 'DR Congo', 'congo dr': 'DR Congo',
  'south korea': 'South Korea', 'korea republic': 'South Korea',
  'cape verde': 'Cape Verde', 'cape verde islands': 'Cape Verde',
};
function canonNation(apiName) {
  const n = normName(apiName);
  return NATION_ALIASES[n] || apiName;
}

// ---------- pull ROSTER / NATION / EXCLUDED straight out of the app source,
// so the crosswalk never drifts out of sync with the live roster ----------
function loadCrosswalk() {
  const html = readFileSync(HTML_PATH, 'utf8');

  const rosterBlock = html.match(/ROSTER\(\)\{ return `([\s\S]*?)`; \}/);
  if (!rosterBlock) throw new Error('Could not find ROSTER() block in FootyStock_dc.html');
  const rosterByName = {};
  for (const line of rosterBlock[1].trim().split('\n')) {
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const name = parts[0].replace(/ dummy$/, '');
    rosterByName[name] = parts[1]; // club team
  }

  const natBlock = html.match(/const nat=\{\};([\s\S]*?)\/\/ Confirmed absentees/);
  if (!natBlock) throw new Error('Could not find NATION add() calls in FootyStock_dc.html');
  const nationByName = {};
  const addRe = /add\('([^']+)','([^']+)'\)/g;
  let m;
  while ((m = addRe.exec(natBlock[1]))) {
    const [, country, names] = m;
    for (const n of names.split(',')) nationByName[n.trim()] = country;
  }

  const exBlock = html.match(/const EXCLUDED=new Set\(\[([^\]]*)\]\)/);
  const excluded = new Set();
  if (exBlock) {
    for (const m2 of exBlock[1].matchAll(/'([^']+)'/g)) excluded.add(m2[1]);
  }

  const players = [];
  for (const name of Object.keys(nationByName)) {
    if (excluded.has(name)) continue;
    const team = rosterByName[name];
    if (!team) continue; // nation-tagged but not in club roster — skip, no slug to attach to
    players.push({ name, team, nation: nationByName[name], id: slug(name + '-' + team) });
  }
  return players;
}

async function apiGet(endpoint, params) {
  const url = new URL(API_BASE + endpoint);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API-Football ${endpoint} -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`API-Football ${endpoint} -> ${JSON.stringify(json.errors)}`);
  }
  return json.response || [];
}

function roundLabel(round) {
  // API-Football round strings look like "Group Stage - 1" or "Round of 16"
  if (/group/i.test(round)) {
    const g = round.match(/Group ([A-Z])/i);
    return g ? `Group ${g[1].toUpperCase()}` : 'Group stage';
  }
  return round;
}

async function main() {
  const players = loadCrosswalk();
  const trackedNations = new Set(players.map(p => p.nation));
  console.log(`Tracking ${players.length} players across ${trackedNations.size} nations.`);

  const fixtures = await apiGet('/fixtures', { league: LEAGUE_ID, season: SEASON });
  console.log(`Fetched ${fixtures.length} WC ${SEASON} fixtures.`);

  // group fixtures per tracked nation, finished matches only
  const teams = {};
  const fixturesToPull = [];
  for (const f of fixtures) {
    const status = f.fixture.status.short;
    if (!['FT', 'AET', 'PEN'].includes(status)) continue;
    const home = canonNation(f.teams.home.name);
    const away = canonNation(f.teams.away.name);
    const date = f.fixture.date.slice(5, 10); // MM-DD
    const round = roundLabel(f.league.round || '');
    const isKnockout = !/group/i.test(round);

    for (const [me, opp, gf, ga] of [
      [home, away, f.goals.home, f.goals.away],
      [away, home, f.goals.away, f.goals.home],
    ]) {
      if (!trackedNations.has(me)) continue;
      teams[me] = teams[me] || { fixtures: [], _knockout: false, _lastRound: round };
      teams[me].fixtures.push({ d: date, opp, gf, ga });
      if (isKnockout) teams[me]._knockout = true;
      teams[me]._lastRound = round;
      fixturesToPull.push(f.fixture.id);
    }
  }
  for (const nation of Object.keys(teams)) {
    const t = teams[nation];
    t.status = t._knockout ? `Through to the ${t._lastRound}` : `${t._lastRound}`;
    delete t._knockout; delete t._lastRound;
  }

  const uniqueFixtureIds = [...new Set(fixturesToPull)];
  console.log(`Pulling player stats for ${uniqueFixtureIds.length} fixtures (API-Football free tier: ~100 req/day).`);

  const byNormName = {};
  for (const p of players) {
    const key = normName(p.name) + '|' + p.nation;
    byNormName[key] = p;
  }

  const playerEvents = {};
  for (const fixtureId of uniqueFixtureIds) {
    let resp;
    try {
      resp = await apiGet('/fixtures/players', { fixture: fixtureId });
    } catch (e) {
      console.error(`Skipping fixture ${fixtureId}: ${e.message}`);
      continue;
    }
    const fixtureMeta = fixtures.find(f => f.fixture.id === fixtureId);
    const date = fixtureMeta.fixture.date.slice(5, 10);
    for (const teamBlock of resp) {
      const nation = canonNation(teamBlock.team.name);
      if (!trackedNations.has(nation)) continue;
      const oppName = canonNation(
        teamBlock.team.name === fixtureMeta.teams.home.name ? fixtureMeta.teams.away.name : fixtureMeta.teams.home.name
      );
      const gf = teamBlock.team.name === fixtureMeta.teams.home.name ? fixtureMeta.goals.home : fixtureMeta.goals.away;
      const ga = teamBlock.team.name === fixtureMeta.teams.home.name ? fixtureMeta.goals.away : fixtureMeta.goals.home;
      for (const pl of teamBlock.players) {
        const key = normName(pl.player.name) + '|' + nation;
        const tracked = byNormName[key];
        if (!tracked) continue;
        const stat = pl.statistics[0] || {};
        const minutes = stat.games?.minutes || 0;
        if (!minutes) continue; // didn't play
        const g = stat.goals?.total || 0;
        const a = stat.goals?.assists || 0;
        const apiRating = parseFloat(stat.games?.rating);
        const diff = Math.max(-1, Math.min(1, (gf - ga) * 0.3));
        const rating = Number.isFinite(apiRating) ? apiRating
          : parseFloat((6.9 + diff + g * 0.5 + a * 0.3).toFixed(2));
        const st = [];
        if (g) st.push(`${g}G`); if (a) st.push(`${a}A`); if (!g && !a) st.push('—');
        const note = `${minutes}' vs ${oppName} (${gf}-${ga})${g || a ? ` — ${st.join(' ')}` : ''}`;

        (playerEvents[tracked.id] = playerEvents[tracked.id] || []).push({
          d: date, opp: oppName, g, a, rating, note,
        });
      }
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    season: SEASON,
    teams,
    players: Object.fromEntries(Object.entries(playerEvents).map(([id, events]) => [id, { events }])),
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${OUT_PATH}: ${Object.keys(teams).length} nations, ${Object.keys(playerEvents).length} players with events.`);
}

main().catch(e => { console.error(e); process.exit(1); });
