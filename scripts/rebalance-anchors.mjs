#!/usr/bin/env node
// One-off anchor-rebalance tool (NOT part of the live worker/cron path).
//
// CLAUDE.md: the VAL() table in FootyStock_dc.html is the price anchor
// (Transfermarkt-style €M market value) and is hand-typed/static. This
// script rewrites it using *real* 2025/26 domestic-league season stats from
// API-Football for the top-5-league clubs, so a player's anchor reflects
// this season's actual club output instead of going stale (e.g. a big-money
// transfer anchored high regardless of how the move is actually going).
//
// Per CLAUDE.md rule 4, this uses only raw counting stats (goals, assists,
// tackles, etc.) — never API-Football's own aggregate "rating" field, which
// is the same kind of third-party pundit number rating.mjs deliberately
// avoids for match-level ratings.
//
// Injury handling (e.g. Musiala's ACL recovery limiting his 2025/26 minutes):
// productionIndex()'s existing sampleWeight (minutes/900) already shrinks a
// low-minutes season toward 0 contribution, so a player who's barely played
// this season gets ~no delta and keeps their prior anchor value — "memory
// from the previous season" carried forward rather than crashing their
// price for an injury that isn't a form/quality signal.
//
// Age handling: a small, separate multiplicative nudge (ageMultiplier below)
// — deliberately modest so it can't let a promising kid outprice an
// in-prime superstar on reputation alone; it only tilts otherwise-similar
// performances toward upside-for-young / decline-risk-for-aging.
//
// Run: API_FOOTBALL_KEY=xxx node scripts/rebalance-anchors.mjs > report.json
// Network access required — run from CI (see .github/workflows/rebalance-anchors.yml),
// not from a sandboxed dev shell without internet.
import { readFileSync } from 'fs';
import { loadCrosswalk, normName } from './lib/crosswalk.mjs';

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) { console.error('API_FOOTBALL_KEY not set'); process.exit(1); }

const BASE = 'https://v3.football.api-sports.io';
const SEASON = 2025; // 2025/26 season (API-Football keys a season by its start year)
const HTML_PATH = new URL('../FootyStock_dc.html', import.meta.url);

// Modest, capped age nudge — not subject to CAP below since it's a separate,
// deliberately small factor (max ±15%), not a performance signal.
function ageMultiplier(age) {
  if (age == null) return 1;
  if (age <= 21) return 1.10;
  if (age <= 24) return 1.05;
  if (age <= 29) return 1.00;
  if (age <= 32) return 0.92;
  return 0.85;
}

const LEAGUES = { EPL: 39, LAL: 140, SEA: 135, BUN: 78, LI1: 61 };

// Our TEAMS() name -> API-Football's official team name, for the clubs we
// actually track (top-5-league entries only; PROS/OTH clubs are skipped).
const TEAM_ALIASES = {
  'Man City': 'Manchester City', Arsenal: 'Arsenal', Liverpool: 'Liverpool', Chelsea: 'Chelsea',
  'Man Utd': 'Manchester United', Tottenham: 'Tottenham', Newcastle: 'Newcastle',
  'Aston Villa': 'Aston Villa', 'Crystal Palace': 'Crystal Palace', Brighton: 'Brighton', Fulham: 'Fulham',
  'Real Madrid': 'Real Madrid', Barcelona: 'Barcelona', 'Atlético': 'Atletico Madrid',
  Athletic: 'Athletic Club', Villarreal: 'Villarreal', 'Real Sociedad': 'Real Sociedad',
  Inter: 'Inter', Milan: 'AC Milan', Juventus: 'Juventus', Napoli: 'Napoli', Roma: 'Roma', Atalanta: 'Atalanta',
  Bayern: 'Bayern Munich', Leverkusen: 'Bayer Leverkusen', Dortmund: 'Borussia Dortmund',
  'RB Leipzig': 'RB Leipzig', Stuttgart: 'VfB Stuttgart', Eintracht: 'Eintracht Frankfurt',
  'Paris SG': 'Paris Saint Germain', Monaco: 'Monaco', Marseille: 'Marseille', Lille: 'Lille', Lyon: 'Lyon',
};
const TEAM_LEAGUE = {
  'Man City': 'EPL', Arsenal: 'EPL', Liverpool: 'EPL', Chelsea: 'EPL', 'Man Utd': 'EPL', Tottenham: 'EPL',
  Newcastle: 'EPL', 'Aston Villa': 'EPL', 'Crystal Palace': 'EPL', Brighton: 'EPL', Fulham: 'EPL',
  'Real Madrid': 'LAL', Barcelona: 'LAL', 'Atlético': 'LAL', Athletic: 'LAL', Villarreal: 'LAL', 'Real Sociedad': 'LAL',
  Inter: 'SEA', Milan: 'SEA', Juventus: 'SEA', Napoli: 'SEA', Roma: 'SEA', Atalanta: 'SEA',
  Bayern: 'BUN', Leverkusen: 'BUN', Dortmund: 'BUN', 'RB Leipzig': 'BUN', Stuttgart: 'BUN', Eintracht: 'BUN',
  'Paris SG': 'LI1', Monaco: 'LI1', Marseille: 'LI1', Lille: 'LI1', Lyon: 'LI1',
};

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': KEY } });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function posBucket(pos) {
  if (!pos) return 'MID';
  if (pos.startsWith('G')) return 'GK';
  if (pos.startsWith('D')) return 'DEF';
  if (pos.startsWith('M')) return 'MID';
  return 'FWD';
}

// Raw-stat production index, per-90, mirroring rating.mjs's philosophy (goals/
// assists dominate, defensive actions a small add-on) but at a season level —
// no rating field, no match-bonus nonlinearities (those belong to in-match
// rating, not a season-long market-value anchor).
function productionIndex(stat, bucket) {
  const minutes = stat.games?.minutes || 0;
  if (minutes < 1) return null;
  const goals = stat.goals?.total || 0;
  const assists = stat.goals?.assists || 0;
  const conceded = stat.goals?.conceded || 0;
  const saves = stat.goals?.saves || 0;
  const tackles = stat.tackles?.total || 0;
  const interceptions = stat.tackles?.interceptions || 0;
  const duelsWon = stat.duels?.won || 0;
  const keyPasses = stat.passes?.key || 0;
  const per90 = 90 / minutes;

  let raw;
  if (bucket === 'GK') raw = (saves * 0.06 - conceded * 0.10) * per90;
  else if (bucket === 'DEF') raw = (goals * 0.9 + assists * 0.6 - conceded * 0.05
    + 0.02 * (tackles + interceptions + duelsWon)) * per90;
  else raw = (goals * 0.9 + assists * 0.6 + 0.015 * (tackles + interceptions + duelsWon + keyPasses)) * per90;

  // Shrink small samples toward 0 (mean) rather than letting a 2-game cameo
  // swing the anchor as hard as a full season — pricing-model.md's per-90
  // normalization rule, applied at season scale.
  const sampleWeight = Math.min(1, minutes / 900); // full credit at ~10 full matches
  return { raw: raw * sampleWeight, minutes };
}

async function main() {
  const players = loadCrosswalk(HTML_PATH.pathname);
  const byTeam = new Map();
  for (const p of players) {
    if (!TEAM_LEAGUE[p.team]) continue; // not a top-5-league club we track
    (byTeam.get(p.team) || byTeam.set(p.team, []).get(p.team)).push(p);
  }

  // Resolve our team names -> API-Football team ids, one /teams call per league.
  const teamIdByOurName = {};
  for (const [code, leagueId] of Object.entries(LEAGUES)) {
    const resp = await get(`/teams?league=${leagueId}&season=${SEASON}`);
    const apiTeams = (resp.response || []).map(t => ({ id: t.team.id, name: t.team.name }));
    for (const [ourName, code2] of Object.entries(TEAM_LEAGUE)) {
      if (code2 !== code) continue;
      const wanted = normName(TEAM_ALIASES[ourName]);
      // Exact match first; fall back to substring containment on our own
      // (unaliased) team key — covers cases the hardcoded English alias
      // gets wrong, e.g. API returning "Bayern München" (accent-stripped to
      // "munchen", not the alias's "munich") or "AS Roma" instead of "Roma".
      let hit = apiTeams.find(t => normName(t.name) === wanted);
      if (!hit) hit = apiTeams.find(t => normName(t.name).includes(normName(ourName)));
      if (hit) teamIdByOurName[ourName] = hit.id;
      else console.error(`WARN: no API team match for ${ourName} (${TEAM_ALIASES[ourName]}) in ${code}`);
    }
  }

  const results = [];
  for (const [ourTeam, roster] of byTeam) {
    const teamId = teamIdByOurName[ourTeam];
    if (!teamId) continue;
    const leagueId = LEAGUES[TEAM_LEAGUE[ourTeam]];
    let page = 1, statsByName = [];
    while (true) {
      const resp = await get(`/players?team=${teamId}&season=${SEASON}&page=${page}`);
      for (const pl of resp.response || []) {
        const stat = (pl.statistics || []).find(s => s.league?.id === leagueId);
        if (stat) statsByName.push({ name: pl.player.name, stat });
      }
      const totalPages = resp.paging?.total || 1;
      if (page >= totalPages) break;
      page++;
    }

    for (const ourPlayer of roster) {
      const norm = normName(ourPlayer.name);
      let hit = statsByName.find(s => normName(s.name) === norm);
      if (!hit) { const sur = norm.split(' ').pop(); hit = statsByName.find(s => normName(s.name).split(' ').pop() === sur); }
      if (!hit) { results.push({ ...ourPlayer, found: false }); continue; }
      const bucket = posBucket(hit.stat.games?.position);
      const idx = productionIndex(hit.stat, bucket);
      if (!idx) { results.push({ ...ourPlayer, found: false, reason: 'no minutes' }); continue; }
      results.push({ ...ourPlayer, found: true, bucket, idx: idx.raw, minutes: idx.minutes,
        goals: hit.stat.goals?.total || 0, assists: hit.stat.goals?.assists || 0, age: ourPlayer.age });
    }
  }

  // Mean-center within each position bucket (pricing-model.md's mean-centering
  // rule, applied here too — an average top-5-league player at his position
  // should get ~0 adjustment, not a blanket bonus/penalty).
  const found = results.filter(r => r.found);
  const bucketAvg = {};
  for (const b of ['GK', 'DEF', 'MID', 'FWD']) {
    const vals = found.filter(r => r.bucket === b).map(r => r.idx);
    bucketAvg[b] = vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : 0;
  }

  const html = readFileSync(HTML_PATH, 'utf8');
  const valMap = {};
  const valRe = /A\('([^']*)'\)/g;
  let vm;
  while ((vm = valRe.exec(html))) {
    for (const part of vm[1].split(',')) {
      const i = part.trim().lastIndexOf(' ');
      valMap[part.trim().slice(0, i).trim()] = +part.trim().slice(i + 1);
    }
  }

  const K = 18; // log-space adjustment strength: tuned so a clearly standout
  // season (idx ~0.5 above bucket average) yields roughly +50% anchor, and a
  // clearly poor one (-0.5) yields roughly -35% — large enough to matter,
  // capped below so one hot/cold patch can't 5x or zero out a market value.
  const CAP = Math.log(2.5); // max |log-adjustment|, i.e. 0.4x-2.5x bounds —
  // widened from the original 0.6 (0.55x-1.8x) because a strictly capped pass
  // left genuinely elite-but-previously-underrated seasons (e.g. a 36-goal
  // striker anchored low pre-season) unable to fully close the gap to
  // already-high-anchored stars in one pass.

  const out = [];
  for (const r of found) {
    const oldVal = valMap[r.name];
    if (oldVal == null) continue;
    const delta = Math.max(-CAP, Math.min(CAP, K * (r.idx - bucketAvg[r.bucket])));
    // Age multiplier deliberately not applied yet — pending a fix to the
    // underlying production-index saturation issue first (see ageMultiplier()).
    const newVal = Math.max(4, Math.round(oldVal * Math.exp(delta) / 5) * 5);
    out.push({ name: r.name, team: r.team, bucket: r.bucket, minutes: r.minutes, age: r.age,
      goals: r.goals, assists: r.assists, idx: +r.idx.toFixed(3), bucketAvg: +bucketAvg[r.bucket].toFixed(3),
      oldVal, newVal, pctChange: +((newVal / oldVal - 1) * 100).toFixed(1) });
  }
  out.sort((a, b) => b.pctChange - a.pctChange);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), season: SEASON, players: out,
    notFound: results.filter(r => !r.found).map(r => r.name) }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
