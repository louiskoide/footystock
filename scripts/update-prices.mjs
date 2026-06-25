#!/usr/bin/env node
// Daily data pipeline (see /data-sources.md, step 1 of the build order):
// pulls real 2026 World Cup results + goal events from football-data.org,
// computes WC-driven price inputs, and writes prices.json. The frontend only
// ever reads that file — this script is the one place allowed to call the
// external API (see CLAUDE.md: never fetch data APIs from the browser).
//
// football-data.org's free tier doesn't reliably expose assists, minutes, or
// a per-player match rating — only goals (and sometimes the assisting player
// on a goal). That's fine: CLAUDE.md already requires computing our own
// rating from raw events rather than using a third-party one. Players who
// didn't score still get a team-result-based event via the existing
// `inSquad` fallback in buildDB().
//
// Run: FOOTBALL_DATA_KEY=xxx node scripts/update-prices.mjs
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'FootyStock_dc.html');
const OUT_PATH = path.join(ROOT, 'prices.json');

const API_KEY = process.env.FOOTBALL_DATA_KEY;
const SEASON = process.env.WC_SEASON || '2026';
const COMPETITION = 'WC'; // football-data.org code for the FIFA World Cup
const API_BASE = 'https://api.football-data.org/v4';
const MIN_REQUEST_GAP_MS = 6500; // free tier: 10 req/min

if (!API_KEY) {
  console.error('FOOTBALL_DATA_KEY not set — skipping fetch, leaving prices.json untouched.');
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

// football-data.org sometimes names a country differently than our DATA().
// Map API name -> the nation key we use internally.
const NATION_ALIASES = {
  'usa': 'USA', 'united states': 'USA',
  'ivory coast': 'Ivory Coast', "cote d'ivoire": 'Ivory Coast', 'côte d’ivoire': 'Ivory Coast',
  'dr congo': 'DR Congo', 'congo dr': 'DR Congo', 'congo democratic republic': 'DR Congo',
  'south korea': 'South Korea', 'korea republic': 'South Korea', 'korea south': 'South Korea',
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

let lastRequestAt = 0;
async function apiGet(endpoint, params) {
  const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  const url = new URL(API_BASE + endpoint);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

  let res = await fetch(url, { headers: { 'X-Auth-Token': API_KEY } });
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 60000));
    res = await fetch(url, { headers: { 'X-Auth-Token': API_KEY } });
  }
  lastRequestAt = Date.now();
  if (!res.ok) throw new Error(`football-data.org ${endpoint} -> HTTP ${res.status}`);
  return res.json();
}

function roundLabel(stage, group) {
  if (stage === 'GROUP_STAGE') {
    const g = (group || '').match(/([A-Z])$/);
    return g ? `Group ${g[1]}` : 'Group stage';
  }
  return (stage || '').replace(/_/g, ' ').toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

async function main() {
  const players = loadCrosswalk();
  const trackedNations = new Set(players.map(p => p.nation));
  console.log(`Tracking ${players.length} players across ${trackedNations.size} nations.`);

  const matchesResp = await apiGet(`/competitions/${COMPETITION}/matches`, { season: SEASON });
  const matches = matchesResp.matches || [];
  console.log(`Fetched ${matches.length} WC ${SEASON} matches.`);

  const finished = matches.filter(m => m.status === 'FINISHED');
  console.log(`${finished.length} finished matches.`);

  const byNormName = {};
  for (const p of players) {
    const key = normName(p.name) + '|' + p.nation;
    byNormName[key] = p;
  }
  if (process.env.DEBUG_MATCH) console.log('SAMPLE_KEYS', JSON.stringify(Object.keys(byNormName).slice(0, 10)));

  const teams = {};
  const playerEvents = {};

  for (const match of finished) {
    const home = canonNation(match.homeTeam.name);
    const away = canonNation(match.awayTeam.name);
    const gf = match.score.fullTime.home;
    const ga = match.score.fullTime.away;
    const date = match.utcDate.slice(5, 10); // MM-DD
    const round = roundLabel(match.stage, match.group);
    const isKnockout = match.stage !== 'GROUP_STAGE';

    for (const [me, opp, myGoals, oppGoals] of [
      [home, away, gf, ga],
      [away, home, ga, gf],
    ]) {
      if (!trackedNations.has(me)) continue;
      teams[me] = teams[me] || { fixtures: [], _knockout: false, _lastRound: round };
      teams[me].fixtures.push({ d: date, opp, gf: myGoals, ga: oppGoals });
      if (isKnockout) teams[me]._knockout = true;
      teams[me]._lastRound = round;
    }

    // per-player goal events — only call /matches/{id} for matches involving
    // a tracked nation, to stay within the free tier's rate limit
    if (!trackedNations.has(home) && !trackedNations.has(away)) continue;

    let detail;
    try {
      detail = await apiGet(`/matches/${match.id}`);
    } catch (e) {
      console.error(`Skipping match ${match.id}: ${e.message}`);
      continue;
    }
    const goals = detail.match?.goals || detail.goals || [];
    if (process.env.DEBUG_MATCH && !global.__debugDumped) {
      global.__debugDumped = 0;
    }
    if (process.env.DEBUG_MATCH && global.__debugDumped < 3) {
      global.__debugDumped++;
      console.log('DETAIL_KEYS', JSON.stringify(Object.keys(detail)));
      console.log('DETAIL_GOALS_LEN', goals.length, 'hasMatchKey', !!detail.match, 'hasGoalsKey', !!detail.goals);
      console.log('DETAIL_SAMPLE', JSON.stringify(detail).slice(0, 1500));
    }
    const tally = {}; // id -> {g,a}
    for (const goal of goals) {
      const teamName = canonNation(goal.team?.name || '');
      if (process.env.DEBUG_MATCH) console.log('GOAL_RAW', JSON.stringify({ rawTeam: goal.team?.name, teamName, scorer: goal.scorer?.name, assist: goal.assist?.name, tracked: trackedNations.has(teamName) }));
      if (!trackedNations.has(teamName)) continue;
      const scorerKey = goal.scorer?.name ? normName(goal.scorer.name) + '|' + teamName : null;
      const scorer = scorerKey ? byNormName[scorerKey] : null;
      if (process.env.DEBUG_MATCH) console.log('SCORER_LOOKUP', JSON.stringify({ scorerKey, found: !!scorer }));
      if (scorer) (tally[scorer.id] = tally[scorer.id] || { g: 0, a: 0 }).g++;

      const assistKey = goal.assist?.name ? normName(goal.assist.name) + '|' + teamName : null;
      const assister = assistKey ? byNormName[assistKey] : null;
      if (assister) (tally[assister.id] = tally[assister.id] || { g: 0, a: 0 }).a++;
    }

    for (const [me, opp, myGoals, oppGoals] of [
      [home, away, gf, ga],
      [away, home, ga, gf],
    ]) {
      if (!trackedNations.has(me)) continue;
      for (const p of players.filter(pl => pl.nation === me)) {
        const t = tally[p.id];
        if (!t) continue;
        const diff = Math.max(-1, Math.min(1, (myGoals - oppGoals) * 0.3));
        const rating = parseFloat((6.9 + diff + t.g * 0.5 + t.a * 0.3).toFixed(2));
        const st = [];
        if (t.g) st.push(`${t.g}G`); if (t.a) st.push(`${t.a}A`);
        const note = `vs ${opp} (${myGoals}-${oppGoals}) — ${st.join(' ')}`;
        (playerEvents[p.id] = playerEvents[p.id] || []).push({
          d: date, opp, g: t.g, a: t.a, rating, note,
        });
      }
    }
  }

  for (const nation of Object.keys(teams)) {
    const t = teams[nation];
    t.status = t._knockout ? `Through to the ${t._lastRound}` : `${t._lastRound}`;
    delete t._knockout; delete t._lastRound;
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
