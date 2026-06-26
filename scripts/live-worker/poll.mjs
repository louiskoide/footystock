// Polling loop: pulls WC2026 fixtures from API-Football, computes our own
// player ratings from raw events (CLAUDE.md rule 4), and keeps an in-memory
// prices.json-shaped state object up to date. server.mjs just serves it.
import { canonNation, normName } from '../lib/crosswalk.mjs';
import { computeRating } from './rating.mjs';

const WC_LEAGUE_ID = 1;
const LIVE_STATUSES = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'INT']);
const FINAL_GRACE_POLLS = 3; // re-check a finished fixture this many extra times for late stat corrections

function buildFlatIndex(crosswalkPlayers) {
  return crosswalkPlayers.map(p => ({ id: p.id, name: p.name, norm: normName(p.name) }));
}

function matchPlayer(flatIndex, apiName) {
  const norm = normName(apiName);
  let hit = flatIndex.find(c => c.norm === norm);
  if (hit) return hit.id;
  // Fall back to surname match (API-Football sometimes returns a short
  // display name like "Mbappé" where our roster has "Kylian Mbappé").
  const surname = norm.split(' ').pop();
  hit = flatIndex.find(c => c.norm.split(' ').pop() === surname);
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

async function processFixture(client, fixture, flatIndex, trackedNations, nationOf, state, log) {
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

  // Real kickoff-relative minute timestamps for goals/cards (CLAUDE.md rule 4:
  // compute our own numbers from raw event data, never fabricate them) — one
  // call shared across both nations in this fixture, used to give the
  // frontend's 90-minute chart actual jump points instead of a smooth guess.
  let marksByPlayer = {};
  try {
    const rawEvents = await client.fixtureEvents(fid);
    for (const re of rawEvents || []) {
      const minute = re.time?.elapsed;
      if (minute == null) continue;
      if (re.type === 'Goal') {
        const scorerId = matchPlayer(flatIndex, re.player?.name || '');
        if (scorerId) (marksByPlayer[scorerId] ||= []).push({ minute, kind: /own/i.test(re.detail || '') ? 'owngoal' : 'goal' });
        const assistId = re.assist?.name ? matchPlayer(flatIndex, re.assist.name) : null;
        if (assistId) (marksByPlayer[assistId] ||= []).push({ minute, kind: 'assist' });
      } else if (re.type === 'Card') {
        const cardId = matchPlayer(flatIndex, re.player?.name || '');
        if (cardId) (marksByPlayer[cardId] ||= []).push({ minute, kind: /red/i.test(re.detail || '') ? 'red' : 'yellow' });
      }
    }
  } catch (e) { log(`fixtureEvents ${fid} failed: ${e.message}`); }

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
    // Knockout result always wins (more specific than any group-stage verdict).
    // Group-stage status is owned by applyGroupStandings(), which runs earlier
    // in pollOnce() and knows the real top-2/best-8-thirds picture — don't
    // clobber it back down to a bare round label here. Only fall back to the
    // round label if standings haven't set anything yet (e.g. its API call
    // failed this cycle, or this is the very first poll for a new team).
    if (knockout) t.status = `Through to the ${round}`;
    else if (!t.status) t.status = round;

    let playersResp;
    try { playersResp = await client.fixturePlayers(fid); } catch (e) { log(`fixturePlayers ${fid} failed: ${e.message}`); continue; }
    const teamBlock = (playersResp || []).find(tb => canonNation(tb.team.name) === me);
    if (!teamBlock) continue;

    for (const pl of teamBlock.players || []) {
      const stats = pl.statistics?.[0];
      if (!stats) continue;
      const id = matchPlayer(flatIndex, pl.player.name);
      // Matching is global (not nation-scoped), so confirm this roster
      // player was actually discovered in *this* nation's official squad —
      // otherwise a name collision with some other club player on our
      // roster could get falsely credited with another country's match.
      if (!id || nationOf[id] !== me) continue;

      const minutes = stats.games?.minutes || 0;
      state.players[id] = state.players[id] || { events: [] };
      const evs = state.players[id].events;
      const existingEv = evs.find(e => e._fid === fid);

      if (minutes <= 0) {
        // Named in the matchday squad but never came on — a genuine bench
        // appearance, distinct from not being in the squad for this match
        // at all (which never reaches this loop, since they're absent from
        // teamBlock.players entirely).
        const ev = { d: date, opp, rating: null, g: 0, a: 0, yellow: false, red: false, min: 0, note: null, marks: [], _fid: fid };
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

      const ev = { d: date, opp, rating, g: goals, a: assists, yellow: !!yellow, red: !!red, min: minutes, note, marks: marksByPlayer[id] || [], _fid: fid };
      if (existingEv) Object.assign(existingEv, ev); else evs.push(ev);
    }
  }
}

// Nation/squad membership is discovered entirely from API-Football, never
// from a hand-typed list: fetch every team's official squad (one call per
// team, cached for the worker's lifetime since squads don't change mid-
// tournament) and match each squad name against the *full* roster. A roster
// player only becomes trackable once their name actually turns up in some
// nation's real squad response — new qualifiers or players we forgot to
// tag can never silently fall through a static list again.
async function discoverNations(client, fixtures, flatIndex, state, log) {
  state._squadFetched = state._squadFetched || new Set(); // team ids already queried
  state._nationOf = state._nationOf || {}; // playerId -> nation
  state._trackedNations = state._trackedNations || new Set();

  const teamsById = new Map();
  for (const fx of fixtures) {
    teamsById.set(fx.teams.home.id, canonNation(fx.teams.home.name));
    teamsById.set(fx.teams.away.id, canonNation(fx.teams.away.name));
  }

  for (const [teamId, nation] of teamsById) {
    if (state._squadFetched.has(teamId)) continue;
    state._squadFetched.add(teamId);
    try {
      const resp = await client.playersSquad(teamId);
      const squad = (resp?.[0]?.players || []).map(p => p.name);
      state.teams[nation] = state.teams[nation] || { fixtures: [] };
      state.teams[nation].squad = squad;
      let matched = 0;
      for (const squadName of squad) {
        const id = matchPlayer(flatIndex, squadName);
        if (!id) continue;
        state._nationOf[id] = nation;
        matched++;
      }
      if (matched > 0) state._trackedNations.add(nation);
      log(`squad: ${nation} -> ${squad.length} players (${matched} on our roster)`);
    } catch (e) {
      log(`playersSquad ${nation} (team ${teamId}) failed: ${e.message}`);
    }
  }
}

// World Cup 2026 format: 12 groups of 4, top 2 of each plus the best 8 of
// the 12 third-placed teams advance to the round of 32. A third-placed
// team's fate depends on every other group finishing too, so this never
// labels one "Eliminated" before the whole group stage is actually done —
// fixes a real bug where a hand-typed fallback had a team "Eliminated" on
// a 1-point record while two of its own group's games hadn't even been
// played yet. Runs before the fixtures loop so any knockout-stage fixture
// processed below (which sets a more specific "Through to the {round}"
// label) always has the final say once a team progresses past Group Stage.
async function applyGroupStandings(client, season, state, log) {
  let resp;
  try { resp = await client.standings({ league: WC_LEAGUE_ID, season }); }
  catch (e) { log(`standings failed: ${e.message}`); return; }
  const groups = resp?.[0]?.league?.standings || [];
  if (!groups.length) return;

  const thirdPlaceRows = [];
  let allGroupsDone = true;

  for (const group of groups) {
    const groupName = roundLabel(group[0]?.group || '');
    const done = group.every(row => (row.all?.played || 0) >= 3);
    if (!done) allGroupsDone = false;
    for (const row of group) {
      const nation = canonNation(row.team.name);
      state.teams[nation] = state.teams[nation] || { fixtures: [] };
      if (!done) { state.teams[nation].status = groupName; continue; }
      if (row.rank === 1) state.teams[nation].status = `Through to the R32 · won ${groupName}`;
      else if (row.rank === 2) state.teams[nation].status = `Through to the R32 · ${groupName}`;
      else if (row.rank === 4) state.teams[nation].status = `Eliminated · ${groupName}`;
      else thirdPlaceRows.push({ nation, points: row.points, gd: row.goalsDiff, gf: row.all?.goals?.for || 0, groupName });
    }
  }

  if (!allGroupsDone) {
    // Some other group still has games left — a 3rd-place finish isn't
    // decided yet, so leave it at the plain group label rather than
    // guessing "Eliminated" or "Through".
    for (const t of thirdPlaceRows) state.teams[t.nation].status = t.groupName;
    return;
  }

  // Every group is done — rank all twelve 3rd-place finishers and take the
  // best 8 (points, then goal difference, then goals scored).
  thirdPlaceRows.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf);
  thirdPlaceRows.forEach((t, i) => {
    state.teams[t.nation].status = i < 8
      ? `Through to the R32 · best third-place, ${t.groupName}`
      : `Eliminated · ${t.groupName}`;
  });
}

export async function pollOnce(client, crosswalk, state, log = console.log) {
  const flatIndex = buildFlatIndex(crosswalk);

  const fixtures = await client.fixtures({ league: WC_LEAGUE_ID, season: state.season });
  await discoverNations(client, fixtures, flatIndex, state, log);
  await applyGroupStandings(client, state.season, state, log);
  const trackedNations = state._trackedNations;
  const nationOf = state._nationOf;
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
      await processFixture(client, fixture, flatIndex, trackedNations, nationOf, state, log);
      state._finalPolls.set(fid, polls + 1);
      finishedNew++;
    } else if (LIVE_STATUSES.has(status)) {
      await processFixture(client, fixture, flatIndex, trackedNations, nationOf, state, log);
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
    players[id] = { nation: (state._nationOf && state._nationOf[id]) || null, events: p.events.map(({ _fid, ...rest }) => rest) };
  }
  return { generatedAt: state.generatedAt, season: state.season, teams, players, hype: state.hype || {} };
}
