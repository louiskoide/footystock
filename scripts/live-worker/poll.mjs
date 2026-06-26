// Polling loop: pulls WC2026 fixtures from API-Football, computes our own
// player ratings from raw events (CLAUDE.md rule 4), and keeps an in-memory
// prices.json-shaped state object up to date. server.mjs just serves it.
import { canonNation, normName } from '../lib/crosswalk.mjs';
import { computeRating } from './rating.mjs';

const WC_LEAGUE_ID = 1;
const LIVE_STATUSES = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'INT']);
const FINAL_GRACE_POLLS = 3; // re-check a finished fixture this many extra times for late stat corrections

function buildNationIndex(crosswalkPlayers) {
  const byNation = {};
  for (const p of crosswalkPlayers) {
    byNation[p.nation] = byNation[p.nation] || [];
    byNation[p.nation].push({ id: p.id, name: p.name, norm: normName(p.name) });
  }
  return byNation;
}

function matchPlayer(nationIndex, nation, apiName) {
  const candidates = nationIndex[nation];
  if (!candidates) return null;
  const norm = normName(apiName);
  let hit = candidates.find(c => c.norm === norm);
  if (hit) return hit.id;
  // Fall back to surname match (API-Football sometimes returns a short
  // display name like "Mbappé" where our roster has "Kylian Mbappé").
  const surname = norm.split(' ').pop();
  hit = candidates.find(c => c.norm.split(' ').pop() === surname);
  return hit ? hit.id : null;
}

function isKnockout(round) {
  return !/group/i.test(round || '');
}

function resultFor(myGoals, oppGoals) {
  if (myGoals > oppGoals) return 'win';
  if (myGoals < oppGoals) return 'loss';
  return 'draw';
}

function roundLabel(round) {
  return (round || '').replace(/^Group Stage - /i, 'Group ').trim() || 'World Cup';
}

async function processFixture(client, fixture, nationIndex, trackedNations, state, log) {
  const fid = fixture.fixture.id;
  const home = canonNation(fixture.teams.home.name);
  const away = canonNation(fixture.teams.away.name);
  const homeTracked = trackedNations.has(home);
  const awayTracked = trackedNations.has(away);
  if (!homeTracked && !awayTracked) return;

  const gf = fixture.goals.home;
  const ga = fixture.goals.away;
  const date = (fixture.fixture.date || '').slice(5, 10); // MM-DD
  const round = roundLabel(fixture.league.round);
  const knockout = isKnockout(fixture.league.round);

  for (const [nation, tracked, me, opp, myGoals, oppGoals] of [
    [home, homeTracked, home, away, gf, ga],
    [away, awayTracked, away, home, ga, gf],
  ]) {
    if (!tracked) continue;
    state.teams[me] = state.teams[me] || { fixtures: [] };
    const t = state.teams[me];
    const result = resultFor(myGoals, oppGoals);
    const existing = t.fixtures.find(f => f._fid === fid);
    const entry = { d: date, opp, gf: myGoals, ga: oppGoals, _fid: fid };
    if (existing) Object.assign(existing, entry); else t.fixtures.push(entry);
    t.status = knockout ? `Through to the ${round}` : round;

    let playersResp;
    try { playersResp = await client.fixturePlayers(fid); } catch (e) { log(`fixturePlayers ${fid} failed: ${e.message}`); continue; }
    const teamBlock = (playersResp || []).find(tb => canonNation(tb.team.name) === me);
    if (!teamBlock) continue;

    for (const pl of teamBlock.players || []) {
      const stats = pl.statistics?.[0];
      if (!stats) continue;
      const id = matchPlayer(nationIndex, me, pl.player.name);
      if (!id) continue;

      const minutes = stats.games?.minutes || 0;
      state.players[id] = state.players[id] || { events: [] };
      const evs = state.players[id].events;
      const existingEv = evs.find(e => e._fid === fid);

      if (minutes <= 0) {
        // Named in the matchday squad but never came on — a genuine bench
        // appearance, distinct from not being in the squad for this match
        // at all (which never reaches this loop, since they're absent from
        // teamBlock.players entirely).
        const ev = { d: date, opp, rating: null, g: 0, a: 0, yellow: false, red: false, min: 0, note: null, _fid: fid };
        if (existingEv) Object.assign(existingEv, ev); else evs.push(ev);
        continue;
      }

      const rating = computeRating(stats, { knockout, result });
      if (rating == null) continue;

      const goals = stats.goals?.total || 0;
      const assists = stats.goals?.assists || 0;
      const yellow = stats.cards?.yellow || 0;
      const red = stats.cards?.red || 0;
      let note = null;
      if (goals >= 3) note = 'Hat-trick';
      else if (goals === 2) note = 'Brace';
      else if (red) note = 'Sent off';
      else if (yellow) note = 'Booked';
      else if (goals === 1 && assists >= 1) note = 'Goal & assist';
      else if (goals === 1) note = 'Scored';
      else if (assists >= 2) note = `${assists} assists`;
      else if (assists === 1) note = 'Assist';

      const ev = { d: date, opp, rating, g: goals, a: assists, yellow: !!yellow, red: !!red, min: minutes, note, _fid: fid };
      if (existingEv) Object.assign(existingEv, ev); else evs.push(ev);
    }
  }
}

// Official squad lists from API-Football are the ground truth for "is this
// player actually picked for the World Cup" — replaces guessing from the
// hand-typed NATION list, which drifts from real squad announcements (see
// FootyStock_dc.html EXCLUDED comment history). Squads don't change during
// the tournament, so fetch each tracked nation's once and cache it.
async function ensureSquads(client, fixtures, trackedNations, state, log) {
  state._squadFetched = state._squadFetched || new Set();
  for (const nation of trackedNations) {
    if (state._squadFetched.has(nation)) continue;
    const fx = fixtures.find(f => canonNation(f.teams.home.name) === nation || canonNation(f.teams.away.name) === nation);
    if (!fx) continue;
    const teamId = canonNation(fx.teams.home.name) === nation ? fx.teams.home.id : fx.teams.away.id;
    try {
      const resp = await client.playersSquad(teamId);
      const squad = (resp?.[0]?.players || []).map(p => p.name);
      state.teams[nation] = state.teams[nation] || { fixtures: [] };
      state.teams[nation].squad = squad;
      state._squadFetched.add(nation);
      log(`squad: ${nation} -> ${squad.length} players`);
    } catch (e) {
      log(`playersSquad ${nation} (team ${teamId}) failed: ${e.message}`);
    }
  }
}

export async function pollOnce(client, crosswalk, state, log = console.log) {
  const trackedNations = new Set(crosswalk.map(p => p.nation));
  const nationIndex = buildNationIndex(crosswalk);

  const fixtures = await client.fixtures({ league: WC_LEAGUE_ID, season: state.season });
  await ensureSquads(client, fixtures, trackedNations, state, log);
  let liveCount = 0, finishedNew = 0;

  for (const fixture of fixtures) {
    const status = fixture.fixture.status.short;
    const fid = fixture.fixture.id;
    if (status === 'NS' || status === 'TBD' || status === 'PST') continue;

    if (status === 'FT' || status === 'AET' || status === 'PEN') {
      // API-Football's official player stats (assists, late-corrected goal
      // tallies) can lag the final whistle by a few minutes, so don't lock
      // a fixture as done after a single FT-status poll — keep re-checking
      // it for a few more cycles before treating it as truly final.
      const polls = state._finalPolls.get(fid) || 0;
      if (polls >= FINAL_GRACE_POLLS) continue;
      await processFixture(client, fixture, nationIndex, trackedNations, state, log);
      state._finalPolls.set(fid, polls + 1);
      finishedNew++;
    } else if (LIVE_STATUSES.has(status)) {
      await processFixture(client, fixture, nationIndex, trackedNations, state, log);
      liveCount++;
    }
  }

  state.generatedAt = new Date().toISOString();
  log(`poll: ${fixtures.length} fixtures, ${liveCount} live, ${finishedNew} newly finished.`);
  return { liveCount, finishedNew };
}

export function makeInitialState(season) {
  return { generatedAt: null, season, teams: {}, players: {}, _finalPolls: new Map() };
}

// Public snapshot strips the internal bookkeeping (_fid, _processedFinal)
// before it's served — the frontend only needs the shape documented in
// data-sources.md / pricing-model.md.
export function publicSnapshot(state) {
  const teams = {};
  for (const [nation, t] of Object.entries(state.teams)) {
    teams[nation] = { status: t.status, squad: t.squad || [], fixtures: t.fixtures.map(({ _fid, ...rest }) => rest) };
  }
  const players = {};
  for (const [id, p] of Object.entries(state.players)) {
    players[id] = { events: p.events.map(({ _fid, ...rest }) => rest) };
  }
  return { generatedAt: state.generatedAt, season: state.season, teams, players };
}
