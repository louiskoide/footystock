#!/usr/bin/env node
// Daily data pipeline (see /data-sources.md, step 1 of the build order):
// pulls real 2026 World Cup results from football-data.org, computes
// WC-driven price inputs, and writes prices.json. The frontend only ever
// reads that file — this script is the one place allowed to call the
// external API (see CLAUDE.md: never fetch data APIs from the browser).
//
// football-data.org's free tier does NOT expose per-player goals/assists on
// /matches/{id} for this account (confirmed: the response has no `goals`
// field at all, just area/competition/score/odds/referees). So this script
// only writes team-level results (teams[nation].fixtures) — every squad
// player still gets a team-result-based price event via the existing
// `inSquad` fallback in buildDB(), just without individual goal attribution.
//
// Run: FOOTBALL_DATA_KEY=xxx node scripts/update-prices.mjs
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { loadCrosswalk, canonNation } from './lib/crosswalk.mjs';

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
  const players = loadCrosswalk(HTML_PATH);
  const trackedNations = new Set(players.map(p => p.nation));
  console.log(`Tracking ${players.length} players across ${trackedNations.size} nations.`);

  const matchesResp = await apiGet(`/competitions/${COMPETITION}/matches`, { season: SEASON });
  const matches = matchesResp.matches || [];
  console.log(`Fetched ${matches.length} WC ${SEASON} matches.`);

  const finished = matches.filter(m => m.status === 'FINISHED');
  console.log(`${finished.length} finished matches.`);

  const teams = {};

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
    players: {},
  };
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${OUT_PATH}: ${Object.keys(teams).length} nations with results (team-level fallback drives player prices via buildDB()'s inSquad branch).`);
}

main().catch(e => { console.error(e); process.exit(1); });
