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
// playerComponents()'s sampleWeight (minutes/900) already shrinks a
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
  // Deliberately tiny (±~3%): age is a soft tiebreaker between otherwise-similar
  // seasons, never a real driver — a historic season at 31/32 must not be docked.
  if (age <= 21) return 1.03;
  if (age <= 24) return 1.015;
  if (age <= 29) return 1.00;
  if (age <= 32) return 0.98;
  return 0.95;
}

const LEAGUES = { EPL: 39, LAL: 140, SEA: 135, BUN: 78, LI1: 61 };
// UEFA Champions League. A player's /players?team= response already carries one
// statistics entry per competition, so we fold UCL output into the season total
// for free (no extra requests) — a deep European run is real market-value signal
// (CLAUDE.md ask: "league stats and ucl if applicable"). Only the UCL itself
// (id 2), not domestic cups or the Europa League.
const UCL_LEAGUE = 2;

// Combine a player's domestic-league and UCL statistics into one season total:
// sum the raw counting stats, add the minutes, and pass-weight the accuracy %
// (it's a per-competition percentage, not a count). Either side may be missing.
function mergeStats(domestic, ucl) {
  if (!domestic) return ucl;
  if (!ucl) return domestic;
  const n = (a, b) => (a || 0) + (b || 0);
  const dPass = domestic.passes?.total || 0, uPass = ucl.passes?.total || 0;
  const dAcc = domestic.passes?.accuracy != null ? +domestic.passes.accuracy : null;
  const uAcc = ucl.passes?.accuracy != null ? +ucl.passes.accuracy : null;
  let accuracy = dAcc ?? uAcc;
  if (dAcc != null && uAcc != null && dPass + uPass > 0) {
    accuracy = Math.round((dAcc * dPass + uAcc * uPass) / (dPass + uPass));
  }
  return {
    games: { minutes: n(domestic.games?.minutes, ucl.games?.minutes),
             position: domestic.games?.position || ucl.games?.position },
    goals: { total: n(domestic.goals?.total, ucl.goals?.total),
             assists: n(domestic.goals?.assists, ucl.goals?.assists),
             conceded: n(domestic.goals?.conceded, ucl.goals?.conceded),
             saves: n(domestic.goals?.saves, ucl.goals?.saves) },
    shots: { on: n(domestic.shots?.on, ucl.shots?.on) },
    passes: { total: dPass + uPass, key: n(domestic.passes?.key, ucl.passes?.key), accuracy },
    tackles: { total: n(domestic.tackles?.total, ucl.tackles?.total),
               interceptions: n(domestic.tackles?.interceptions, ucl.tackles?.interceptions),
               blocks: n(domestic.tackles?.blocks, ucl.tackles?.blocks) },
    duels: { won: n(domestic.duels?.won, ucl.duels?.won) },
    dribbles: { success: n(domestic.dribbles?.success, ucl.dribbles?.success) },
  };
}

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
//
// A single goals/assists-weighted sum systematically crashes elite players
// whose value is defensive or progression-based (Bernardo Silva, Saliba,
// Rodri) while inflating anyone who scores at all. Instead this computes
// three separate per-90 signals — attack, defense, buildup/progression —
// and a player is credited for whichever one he's actually elite at (via a
// max-of-three blend below), so a deep ball-retainer like Pedri/Vitinha who
// neither scores nor tackles much still gets full credit through buildup.
function playerComponents(stat) {
  const minutes = stat.games?.minutes || 0;
  if (minutes < 1) return null;
  const per90 = 90 / minutes;

  const goals = stat.goals?.total || 0;
  const assists = stat.goals?.assists || 0;
  const shotsOn = stat.shots?.on || 0;
  const keyPasses = stat.passes?.key || 0;
  const tackles = stat.tackles?.total || 0;
  const interceptions = stat.tackles?.interceptions || 0;
  const blocks = stat.tackles?.blocks || 0;
  const duelsWon = stat.duels?.won || 0;
  const passesTotal = stat.passes?.total || 0;
  const passAccuracy = stat.passes?.accuracy != null ? +stat.passes.accuracy : null;
  const dribbleSuccess = stat.dribbles?.success || 0;
  const conceded = stat.goals?.conceded || 0;
  const saves = stat.goals?.saves || 0;

  // Assists weighted ABOVE goals: creation is the rarer, more valuable skill and
  // the old goals-led weighting buried elite playmakers (Bruno's 21-assist
  // season, Olise's 25). Key passes also up — chance creation is the signal.
  const attack = (goals * 0.9 + assists * 1.0 + shotsOn * 0.05 + keyPasses * 0.06) * per90;
  const defense = (tackles * 0.04 + interceptions * 0.05 + blocks * 0.05 + duelsWon * 0.02) * per90;
  // Volume * accuracy so a high-pass-count player only gets credit for
  // passes that actually go somewhere; accuracy falls back to a neutral
  // 75% when API-Football doesn't report it for a given player.
  const passQualityVolume = passesTotal * ((passAccuracy ?? 75) / 100);
  const buildup = (passQualityVolume * 0.01 + dribbleSuccess * 0.05 + duelsWon * 0.015) * per90;
  const gk = (saves * 0.06 - conceded * 0.10) * per90;

  // Shrink small samples toward 0 (mean) rather than letting a 2-game cameo
  // swing the anchor as hard as a full season, and — per CLAUDE.md's
  // injury-status ask — toward "no change from prior anchor" for a player
  // who barely played (e.g. recovering from injury) rather than crashing
  // their price for a partial, unrepresentative season.
  const sampleWeight = Math.min(1, minutes / 900); // full credit at ~10 full matches
  return { attack: attack * sampleWeight, defense: defense * sampleWeight,
    buildup: buildup * sampleWeight, gk: gk * sampleWeight, minutes,
    // Raw season totals carried through to the report so weights/cap/age can be
    // re-tuned offline from the JSON without re-hitting the API.
    raw: { goals, assists, shotsOn, keyPasses, tackles, interceptions, blocks,
      duelsWon, passesTotal, passAccuracy, dribbleSuccess, conceded, saves } };
}

function mean(xs) { return xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0; }
function std(xs, m) {
  if (xs.length < 2) return 1;
  const v = xs.reduce((a, c) => a + (c - m) ** 2, 0) / xs.length;
  return Math.sqrt(v) || 1;
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
        const domestic = (pl.statistics || []).find(s => s.league?.id === leagueId);
        const ucl = (pl.statistics || []).find(s => s.league?.id === UCL_LEAGUE);
        const stat = mergeStats(domestic, ucl);
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
      const comp = playerComponents(hit.stat);
      if (!comp) { results.push({ ...ourPlayer, found: false, reason: 'no minutes' }); continue; }
      results.push({ ...ourPlayer, found: true, bucket, comp, minutes: comp.minutes,
        goals: hit.stat.goals?.total || 0, assists: hit.stat.goals?.assists || 0, age: ourPlayer.age });
    }
  }

  const found = results.filter(r => r.found);

  // Z-score each of attack/defense/buildup within its own position bucket
  // (pricing-model.md's mean-centering rule, but per-signal so a bucket's
  // own typical scoring/tackling/passing volume sets the baseline). GK uses
  // its own single signal. A player's idx is then a max+avg blend across
  // the signals he's available for — crediting whichever dimension he's
  // actually elite at, rather than needing to also score or tackle to earn
  // credit for elite progression play (Pedri/Vitinha/Mainoo's case).
  const SIGNALS = { GK: ['gk'], DEF: ['attack', 'defense', 'buildup'], MID: ['attack', 'defense', 'buildup'], FWD: ['attack', 'defense', 'buildup'] };
  const zStats = {};
  for (const b of ['GK', 'DEF', 'MID', 'FWD']) {
    zStats[b] = {};
    const peers = found.filter(r => r.bucket === b);
    for (const sig of SIGNALS[b]) {
      const vals = peers.map(r => r.comp[sig]);
      const m = mean(vals);
      zStats[b][sig] = { mean: m, std: std(vals, m) };
    }
  }
  for (const r of found) {
    const sigs = SIGNALS[r.bucket];
    const zs = sigs.map(sig => (r.comp[sig] - zStats[r.bucket][sig].mean) / zStats[r.bucket][sig].std);
    r.idx = sigs.length > 1 ? 0.6 * Math.max(...zs) + 0.4 * mean(zs) : zs[0];
  }
  const bucketAvg = { GK: 0, DEF: 0, MID: 0, FWD: 0 }; // idx is already z-scored (mean 0) within its bucket

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

  // idx is now a z-score blend (typically -2..+2, occasional outliers to ~3),
  // not the old raw-stat scale, so K is recalibrated against z rather than
  // raw production units: a ~1-std-above-average season (idx=1) yields
  // roughly +80%, a ~2-std elite season clips close to the cap.
  const K = 0.6;
  // Cap widened 2.5x -> 4x: at 2.5x too many elite seasons clipped the SAME
  // ceiling and collapsed to one value (Raphinha/Kvara/Dembélé all landing
  // identical), so the cap — not the season — set the price and age broke the
  // ties. 4x lets a genuinely elite season (idx~2.3) pull clear of a merely
  // good one (idx~1.5). Bounds: 0.25x–4x.
  const CAP = Math.log(4);

  const out = [];
  for (const r of found) {
    const oldVal = valMap[r.name];
    if (oldVal == null) continue;
    const delta = Math.max(-CAP, Math.min(CAP, K * (r.idx - bucketAvg[r.bucket])));
    // Performance first, then a modest age tilt (±15%, see ageMultiplier).
    // It's intentionally dominated by the performance delta so a historic
    // season at 31/32 (Kane, Bruno) still clips near the top — age only
    // separates otherwise-similar seasons (upside-young / decline-risk-old).
    const newVal = Math.max(4, Math.round(oldVal * Math.exp(delta) * ageMultiplier(r.age) / 5) * 5);
    out.push({ name: r.name, team: r.team, bucket: r.bucket, minutes: r.minutes, age: r.age,
      goals: r.goals, assists: r.assists, idx: +r.idx.toFixed(3), bucketAvg: +bucketAvg[r.bucket].toFixed(3),
      oldVal, newVal, pctChange: +((newVal / oldVal - 1) * 100).toFixed(1), raw: r.comp.raw });
  }
  out.sort((a, b) => b.pctChange - a.pctChange);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), season: SEASON, players: out,
    notFound: results.filter(r => !r.found).map(r => r.name) }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
