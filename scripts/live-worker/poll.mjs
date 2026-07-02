// Polling loop: pulls WC2026 fixtures from API-Football, computes our own
// player ratings from raw events (CLAUDE.md rule 4), and keeps an in-memory
// prices.json-shaped state object up to date. server.mjs just serves it.
// Crosswalk rebuilt: Amad Diallo (Man Utd/Ivory Coast) added to roster 2026-07-01.
import { canonNation, normName } from '../lib/crosswalk.mjs';
import { computeRating } from './rating.mjs';

const WC_LEAGUE_ID = 1;
const LIVE_STATUSES = new Set(['1H', '2H', 'HT', 'ET', 'P', 'BT', 'LIVE', 'INT']);
const FINAL_GRACE_POLLS = 5;  // re-check a finished fixture up to 5 times (~25min at 5-min idle) for late API stat corrections
// After a _finalPolls wipe (STATE_VERSION migration), all historical fixtures
// have polls=0 and need rebuilding. Process at most this many per cycle so a
// single cycle doesn't burst-hit 50+ fixtures at once. Note this only affects
// wall-clock speed, not total API cost — total calls for a full rebuild are
// fixed at (finished fixtures × FINAL_GRACE_POLLS × ~2 calls) regardless of
// how many are done per cycle, since each fixture needs FINAL_GRACE_POLLS
// successful re-polls either way. Raised from 5 → 20 (≈79 fixtures × 5 grace
// polls ≈ 790 calls total either way — well under the 7,500/day budget — but
// at 5/cycle a full rebuild took ~6.7h; at 20/cycle it's ~1.7h). Live fixtures
// are always processed regardless of this cap.
const FINISHED_PER_CYCLE = 20;
// Fixtures outside the tournament window (pre-Jun 2026) are truly dead — no
// point ever fetching them even during a full rebuild.
const STALE_FIXTURE_MS = 400 * 24 * 60 * 60_000; // ~13 months
// Temporary: narrow debug trace for a confirmed-but-unexplained bug where
// jonathan-david-juventus and zion-suzuki-parma stay stuck at min:0/
// rating:null on specific fixtures despite raw API-Football data being
// confirmed correct. Remove once root-caused.
const DEBUG_WATCH_NAMES = /jonathan david|zion suzuki/i;

function buildFlatIndex(crosswalkPlayers) {
  return crosswalkPlayers.map(p => ({ id: p.id, name: p.name, norm: normName(p.name), nation: p.nation }));
}

// nationHint (optional): the nation this name is being resolved for — e.g.
// the squad list or fixture team currently being processed. Only used as a
// last-resort tiebreaker, never to override an unambiguous match.
function matchPlayer(flatIndex, apiName, nationHint = null) {
  const norm = normName(apiName);
  // 1. Exact normalized match
  let hit = flatIndex.find(c => c.norm === norm);
  if (hit) return hit.id;

  const words = norm.split(' ');
  const surname = words[words.length - 1];

  // 2. Reversed name order — API-Football uses "Last First" for many
  //    Asian players (e.g. "Suzuki Zion" for our "Zion Suzuki").
  if (words.length >= 2) {
    const reversed = words.slice(1).join(' ') + ' ' + words[0];
    hit = flatIndex.find(c => c.norm === reversed);
    if (hit) return hit.id;
  }

  // 3. Surname-only match (API returns display short name like "Mbappé").
  //    Only use if the surname is unique in the index to avoid false matches.
  const surnameMatches = flatIndex.filter(c => c.norm.split(' ').pop() === surname);
  if (surnameMatches.length === 1) return surnameMatches[0].id;

  // 4. Initial-disambiguated surname match. API-Football often sends squad
  //    names as "J. Sánchez" (leading first-initial + surname) rather than a
  //    full name — very common for non-marquee squad members. normName()
  //    already reduces that to two words, "j sanchez", so when the bare
  //    surname is ambiguous (multiple "Sánchez"es on our roster), use the
  //    leading initial to pick the one candidate whose first name starts
  //    with it instead of giving up entirely.
  if (surnameMatches.length > 1 && words.length === 2 && words[0].length === 1) {
    const initial = words[0];
    const narrowed = surnameMatches.filter(c => c.norm[0] === initial);
    if (narrowed.length === 1) return narrowed[0].id;
    // 5. Same surname AND same leading initial — e.g. brothers Jude and Jobe
    // Bellingham both resolve to "J. Bellingham". The hand-typed NATION table
    // (crosswalk `nation` field) is a real signal here even though the live
    // worker otherwise ignores it for WC-squad discovery: it only tags a
    // player for a nation when someone has actually confirmed they're a full
    // international for that side, so it reliably picks out the real squad
    // member from a same-initial relative who isn't (yet) tracked as one.
    if (narrowed.length > 1 && nationHint) {
      const byNation = narrowed.filter(c => c.nation === nationHint);
      if (byNation.length === 1) return byNation[0].id;
    }
  }

  return null;
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

async function processFixture(client, fixture, flatIndex, trackedNations, nationOf, state, log, matchInfo = { live: false, elapsed: null }) {
  const fid = fixture.fixture.id;
  const home = canonNation(fixture.teams.home.name);
  const away = canonNation(fixture.teams.away.name);
  const homeTracked = trackedNations.has(home);
  const awayTracked = trackedNations.has(away);
  if (!homeTracked && !awayTracked) return true;

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
      const eventNation = re.team?.name ? canonNation(re.team.name) : null;
      if (re.type === 'Goal') {
        const scorerId = matchPlayer(flatIndex, re.player?.name || '', eventNation);
        if (scorerId) (marksByPlayer[scorerId] ||= []).push({ minute, kind: /own/i.test(re.detail || '') ? 'owngoal' : 'goal' });
        const assistId = re.assist?.name ? matchPlayer(flatIndex, re.assist.name, eventNation) : null;
        if (assistId) (marksByPlayer[assistId] ||= []).push({ minute, kind: 'assist' });
      } else if (re.type === 'Card') {
        const cardId = matchPlayer(flatIndex, re.player?.name || '', eventNation);
        if (cardId) (marksByPlayer[cardId] ||= []).push({ minute, kind: /red/i.test(re.detail || '') ? 'red' : 'yellow' });
      }
    }
  } catch (e) { log(`fixtureEvents ${fid} failed: ${e.message}`); }

  let ok = true;
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
    try { playersResp = await client.fixturePlayers(fid); } catch (e) { log(`fixturePlayers ${fid} failed: ${e.message}`); ok = false; continue; }
    const teamBlock = (playersResp || []).find(tb => canonNation(tb.team.name) === me);
    if (!teamBlock) { ok = false; continue; }

    for (const pl of teamBlock.players || []) {
      const watched = DEBUG_WATCH_NAMES.test(pl.player?.name || '');
      const stats = pl.statistics?.[0];
      if (watched) log(`match-debug: fid=${fid} me=${me} name="${pl.player?.name}" statsCount=${pl.statistics?.length} hasStats=${!!stats} games=${JSON.stringify(stats?.games)}`);
      if (!stats) continue;
      const id = matchPlayer(flatIndex, pl.player.name, me);
      if (watched) log(`match-debug: fid=${fid} name="${pl.player.name}" matchedId=${id} nationOfId=${nationOf[id]}`);
      // Matching is global (not nation-scoped), so confirm this roster
      // player was actually discovered in *this* nation's official squad —
      // otherwise a name collision with some other club player on our
      // roster could get falsely credited with another country's match.
      if (!id || nationOf[id] !== me) continue;

      // API-Football sometimes omits minutes for starters (common for GKs).
      // Use substitute !== true (not strict === false) so null/undefined also
      // counts as "started"; treat null/0 minutes as 90 for starters.
      const rawMinutes = stats.games?.minutes;
      const started = stats.games?.substitute !== true;
      const minutes = (rawMinutes > 0) ? rawMinutes : (started ? 90 : 0);
      if (watched) log(`match-debug: fid=${fid} id=${id} rawMinutes=${rawMinutes} started=${started} minutes=${minutes}`);

      state.players[id] = state.players[id] || { events: [] };
      const evs = state.players[id].events;
      const existingEv = evs.find(e => e._fid === fid);
      if (watched) log(`match-debug: fid=${fid} id=${id} existingEvFound=${!!existingEv} existingEvBefore=${JSON.stringify(existingEv)}`);

      if (minutes <= 0) {
        // Named in the matchday squad but never came on — a genuine bench
        // appearance, distinct from not being in the squad for this match
        // at all (which never reaches this loop, since they're absent from
        // teamBlock.players entirely).
        const ev = { d: date, opp, rating: null, g: 0, a: 0, yellow: false, red: false, min: 0, note: null, marks: [], live: matchInfo.live, elapsed: matchInfo.elapsed, _fid: fid };
        if (existingEv) Object.assign(existingEv, ev); else evs.push(ev);
        if (watched) log(`match-debug: fid=${fid} id=${id} took BENCH branch, wrote min:0`);
        continue;
      }

      const ownGoals = (marksByPlayer[id] || []).filter(m => m.kind === 'owngoal').length;
      const rating = computeRating(stats, { minutes, knockout, result, cleanSheet: oppGoals === 0, ownGoals, goalsConceded: oppGoals });
      if (watched) log(`match-debug: fid=${fid} id=${id} computeRating -> ${rating}`);
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

      const ev = { d: date, opp, rating, g: goals, a: assists, yellow: !!yellow, red: !!red, min: minutes, note, marks: marksByPlayer[id] || [], live: matchInfo.live, elapsed: matchInfo.elapsed, _fid: fid };
      if (existingEv) Object.assign(existingEv, ev); else evs.push(ev);
      if (watched) {
        const verify = state.players[id].events.find(e => e._fid === fid);
        log(`match-debug: fid=${fid} id=${id} immediately-after-assign min=${verify?.min} rating=${verify?.rating} sameRef=${verify === existingEv} evsLength=${evs.length}`);
      }
    }
  }
  return ok;
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
    try {
      const resp = await client.playersSquad(teamId);
      const squad = (resp?.[0]?.players || []).map(p => p.name);
      state.teams[nation] = state.teams[nation] || { fixtures: [] };
      state.teams[nation].squad = squad;
      let matched = 0;
      state._unmatchedSquadNames = state._unmatchedSquadNames || {};
      for (const squadName of squad) {
        const id = matchPlayer(flatIndex, squadName, nation);
        if (!id) {
          state._unmatchedSquadNames[squadName] = nation;
          continue;
        }
        delete state._unmatchedSquadNames[squadName];
        state._nationOf[id] = nation;
        matched++;
      }
      if (matched > 0) state._trackedNations.add(nation);
      log(`squad: ${nation} -> ${squad.length} players (${matched} matched, ${squad.length - matched} unmatched)`);
      // Only mark this team as fetched once the call actually succeeded —
      // a transient failure (rate limit, timeout) must retry next poll
      // rather than permanently losing that nation's roster mapping.
      state._squadFetched.add(teamId);
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
  let liveCount = 0, finishedNew = 0, finishedThisCycle = 0;

  for (const fixture of fixtures) {
    const status = fixture.fixture.status.short;
    const fid = fixture.fixture.id;
    if (status === 'NS' || status === 'TBD' || status === 'PST') continue;

    if (status === 'FT' || status === 'AET' || status === 'PEN') {
      const polls = state._finalPolls.get(fid) || 0;
      if (polls >= FINAL_GRACE_POLLS) continue;
      // Skip fixtures that predate the tournament entirely (no real data to fetch).
      const fixtureDateMs = new Date(fixture.fixture.date).getTime();
      if (polls === 0 && Date.now() - fixtureDateMs > STALE_FIXTURE_MS) {
        state._finalPolls.set(fid, FINAL_GRACE_POLLS);
        continue;
      }
      // Rate-limit finished-fixture fetches per cycle. In normal steady-state
      // all finished fixtures are already at FINAL_GRACE_POLLS and this never
      // triggers. After a _finalPolls wipe (STATE_VERSION migration) it spreads
      // the rebuild across many cycles instead of hitting 50+ fixtures at once.
      if (finishedThisCycle >= FINISHED_PER_CYCLE) continue;
      const ok = await processFixture(client, fixture, flatIndex, trackedNations, nationOf, state, log, { live: false, elapsed: fixture.fixture.status.elapsed });
      // Only spend a grace poll on a fetch that actually succeeded — a
      // transient API error (rate limit, timeout) must not permanently give
      // up on a fixture's data after 3 unlucky failures in a row.
      if (ok) { state._finalPolls.set(fid, polls + 1); finishedThisCycle++; }
      finishedNew++;
    } else if (LIVE_STATUSES.has(status)) {
      await processFixture(client, fixture, flatIndex, trackedNations, nationOf, state, log, { live: true, elapsed: fixture.fixture.status.elapsed });
      liveCount++;
    }
  }

  state.generatedAt = new Date().toISOString();
  log(`poll: ${fixtures.length} fixtures, ${liveCount} live, ${finishedNew} newly finished.`);
  return { liveCount, finishedNew };
}

// One-off repair pass, triggered manually (see /admin/repair-stale-events in
// server.mjs) — not part of the normal poll cadence. A "stale" event (our
// min:0/rating:null bench marker) on a fixture that has already exhausted
// its FINAL_GRACE_POLLS re-polls is stuck for good under pollOnce(): the
// `if (polls >= FINAL_GRACE_POLLS) continue` gate skips it forever, even if
// API-Football has since finished writing that fixture's final box score
// (which it sometimes hasn't yet during a burst rebuild, e.g. right after a
// STATE_VERSION wipe — see CLAUDE.md). Re-fetching just these fixtures once,
// unconditionally, either confirms a genuine bench appearance (idempotent —
// substitute stays true, nothing changes) or picks up the now-complete
// data. Never touches fixtures still within their normal grace-poll window
// or that never showed the stale marker, so it can't corrupt good data.
export async function repairStaleFixtures(client, crosswalk, state, log = console.log) {
  const flatIndex = buildFlatIndex(crosswalk);
  const nationOf = state._nationOf || {};
  const trackedNations = state._trackedNations || new Set();

  const suspectFids = new Set();
  const suspectPlayers = new Map(); // fid -> [ids], used to build the per-player `details` below
  for (const [id, p] of Object.entries(state.players)) {
    for (const ev of p.events || []) {
      if (ev._fid && ev.min === 0 && ev.rating === null && (state._finalPolls.get(ev._fid) || 0) >= FINAL_GRACE_POLLS) {
        suspectFids.add(ev._fid);
        if (!suspectPlayers.has(ev._fid)) suspectPlayers.set(ev._fid, []);
        suspectPlayers.get(ev._fid).push(id);
      }
    }
  }

  if (!suspectFids.size) { log('repair: no stuck-stale fixtures found.'); return { checked: 0, repaired: 0, details: [] }; }

  log(`repair: found ${suspectFids.size} exhausted fixture(s) with stale bench markers, re-fetching...`);
  const fixtures = await client.fixtures({ league: WC_LEAGUE_ID, season: state.season });
  const byId = new Map(fixtures.map(f => [f.fixture.id, f]));

  // Returned directly in the HTTP response (not just logged) — Fly's log
  // tail only keeps a limited recent window, which silently drops early
  // entries once a run touches many fixtures, making the log an unreliable
  // way to verify any one specific player's outcome.
  const details = [];
  let repaired = 0;
  for (const fid of suspectFids) {
    const fixture = byId.get(fid);
    const ids = suspectPlayers.get(fid) || [];
    if (!fixture) {
      log(`repair: fixture ${fid} not found in current fixtures list, skipping.`);
      for (const id of ids) details.push({ fid, id, foundInFixturesList: false });
      continue;
    }
    const ok = await processFixture(client, fixture, flatIndex, trackedNations, nationOf, state, log, { live: false, elapsed: fixture.fixture.status.elapsed });
    if (ok) repaired++;
    for (const id of ids) {
      const ev = (state.players[id]?.events || []).find(e => e._fid === fid);
      details.push({ fid, id, foundInFixturesList: true, ok, min: ev?.min, rating: ev?.rating });
    }
  }
  log(`repair: re-fetched ${repaired}/${suspectFids.size} exhausted fixtures.`);
  return { checked: suspectFids.size, repaired, details };
}

export function makeInitialState(season) {
  return { generatedAt: null, season, teams: {}, players: {}, demand: {}, priceHist: {}, _finalPolls: new Map() };
}

// Record daily price closes sent by clients. All clients compute the same
// price from the same worker data, so last-writer-wins per dayKey is fine.
export function recordPriceCloses(state, closes, dayKey) {
  if (!state.priceHist) state.priceHist = {};
  for (const [id, price] of Object.entries(closes)) {
    if (typeof price !== 'number' || !isFinite(price) || price <= 0) continue;
    const p = Math.round(price * 100) / 100;
    let arr = state.priceHist[id] || [];
    const last = arr[arr.length - 1];
    if (last && last.d === dayKey) {
      last.p = p;
    } else {
      arr = [...arr, { d: dayKey, p }];
      if (arr.length > 90) arr = arr.slice(-90);
    }
    state.priceHist[id] = arr;
  }
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
  return { generatedAt: state.generatedAt, season: state.season, teams, players, hype: state.hype || {}, demand: state.demand || {}, priceHist: state.priceHist || {}, tradeTotals: state.tradeTotals || { buy: {}, sell: {} }, tradeTotalsYday: state.tradeTotalsYday || { buy: {}, sell: {} }, shares: state.shares || {}, hateCount: state.hateCount || {} };
}
