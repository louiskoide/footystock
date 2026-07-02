#!/usr/bin/env node
// Always-on Fly.io worker: polls API-Football for WC2026 and serves the
// resulting prices.json over HTTP. Replaces the daily GitHub Action — see
// CLAUDE.md rule 1 (data fetching is server-side only) and rule 4 (we
// compute our own rating, never store a third-party one).
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { loadCrosswalk, canonNation } from '../lib/crosswalk.mjs';
import { makeClient } from './api-football.mjs';
import { pollOnce, makeInitialState, publicSnapshot, recordPriceCloses, repairStaleFixtures, getWriteLog } from './poll.mjs';
import { refreshHype } from './hype.mjs';
import { tickDemand, recordTrade, recordHatewatch } from './demand.mjs';
import { submitScore, getLeaderboard } from './leaderboard.mjs';
import { loadShares, decrementShares, incrementShares, expandAndDecrementShares, reconcileShares, repairShareTotals } from './shares.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const HTML_PATH = path.join(ROOT, 'FootyStock_dc.html');

const API_KEY = process.env.API_FOOTBALL_KEY;
const SEASON = process.env.WC_SEASON || '2026';
const PORT = process.env.PORT || 8080;
const LIVE_POLL_MS = 30_000;   // while a tracked match is in play
const IDLE_POLL_MS = 300_000;  // nothing live — just watching for kickoffs/results
const HYPE_POLL_MS = 2 * 60 * 60_000; // every 2h: news-tone hype (GDELT) moves slower than search trends, and this keeps us well under GDELT's soft request limits (~470 players/cycle)

if (!API_KEY) {
  console.error('API_FOOTBALL_KEY not set — refusing to start.');
  process.exit(1);
}

const STATE_PATH = '/data/state-cache.json';
// Bump this whenever a deploy needs a clean rebuild of player events / nationOf.
// Any cached state without this version gets its player data wiped and rebuilt.
// IMPORTANT: migrations preserve _finalPolls (grace-poll counters) so that
// fixtures already fully polled (counter >= FINAL_GRACE_POLLS) are NOT
// re-fetched after a player-data wipe. Only wipe _finalPolls if you need to
// force a complete re-fetch of all fixture stats (e.g. after a rating formula
// change) — and expect a rebuild burst to consume ~400 API calls.
const STATE_VERSION = 6;

function saveState(s) {
  try {
    const serialisable = Object.assign({}, s, {
      _stateVersion: STATE_VERSION,
      _finalPolls: Array.from(s._finalPolls.entries()),
      _trackedNations: s._trackedNations ? Array.from(s._trackedNations) : undefined,
      _squadFetched: s._squadFetched instanceof Set ? Array.from(s._squadFetched) : [],
    });
    writeFileSync(STATE_PATH, JSON.stringify(serialisable));
  } catch (e) {
    console.error('state save failed:', e.message);
  }
}

function loadState(season) {
  try {
    if (!existsSync(STATE_PATH)) return null;
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (raw.season !== season) { console.log('state cache is from a different season — ignoring.'); return null; }
    if (raw._stateVersion !== STATE_VERSION) {
      // Schema migration: wipe player events and nationOf so they get rebuilt
      // from the API. Preserves _finalPolls so fixtures already grace-polled
      // to exhaustion are NOT re-fetched — this is the key budget guard.
      // Preserves teams, demand, and priceHist (expensive/slow to regenerate).
      console.log(`State schema v${raw._stateVersion || 0} → v${STATE_VERSION}: clearing player/nation data for clean rebuild.`);
      raw._nationOf = {};
      raw.players = {};
      raw._squadFetched = undefined;
      // _finalPolls normally preserved (see comment above) — but v5 and v6
      // each fix a matchPlayer() bug (v5: initial-disambiguated surname
      // match, e.g. "J. Sánchez" for an ambiguous "Sánchez" surname; v6:
      // same-surname-AND-same-initial relatives, e.g. brothers Jude/Jobe
      // Bellingham both reducing to "J. Bellingham", resolved via a
      // nation-tag tiebreaker) that were silently dropping matches, so
      // already-grace-exhausted fixtures need a genuine re-fetch to pick up
      // the players they previously missed. One-time cost: ~2 calls per
      // already-finished fixture.
      if ((raw._stateVersion || 0) < 6) raw._finalPolls = [];
    }
    raw._finalPolls = new Map(raw._finalPolls || []);
    if (raw._trackedNations) raw._trackedNations = new Set(raw._trackedNations);
    raw._squadFetched = new Set(Array.isArray(raw._squadFetched) ? raw._squadFetched : []);
    const ageMs = raw.generatedAt ? Date.now() - new Date(raw.generatedAt).getTime() : Infinity;
    console.log(`Loaded cached state v${raw._stateVersion || 0} (age: ${Math.round(ageMs / 60000)}m, players: ${Object.keys(raw.players || {}).length}).`);
    return raw;
  } catch (e) {
    console.error('state load failed:', e.message);
    return null;
  }
}

const client = makeClient(API_KEY);
const crosswalk = loadCrosswalk(HTML_PATH);
console.log(`Loaded crosswalk: ${crosswalk.length} players across ${new Set(crosswalk.map(p => p.nation)).size} nations.`);

const state = loadState(SEASON) || makeInitialState(SEASON);

// Reconcile share rows against existing portfolio holdings, then pre-load into state.
reconcileShares()
  .then(() => loadShares())
  .then(rows => {
    state.shares = state.shares || {};
    for (const [id, s] of Object.entries(rows)) state.shares[id] = { remaining: s.remaining, total: s.total };
  })
  .catch(e => console.error('shares init failed:', e.message));

// Repair stale share totals once on first /price-closes call (has full price map).
let _sharesRepaired = false;

let nextDelay = IDLE_POLL_MS;
let lastTickAt = Date.now();
async function tick() {
  const now = Date.now();
  const elapsed = now - lastTickAt;
  lastTickAt = now;
  try {
    const { liveCount } = await pollOnce(client, crosswalk, state);
    tickDemand(state, crosswalk, elapsed);
    nextDelay = liveCount > 0 ? LIVE_POLL_MS : IDLE_POLL_MS;
    saveState(state);
  } catch (e) {
    console.error('poll failed:', e.message);
    nextDelay = IDLE_POLL_MS;
  }
  setTimeout(tick, nextDelay);
}
tick();

// GDELT can soft-throttle bursts (returns empty/HTML instead of JSON) if hit
// too hard. Hammering it every HYPE_POLL_MS while throttled just prolongs it,
// so back off exponentially on a cycle that's almost entirely failures, and
// reset once it recovers. (This is the same guard the old Google Trends path
// needed when its scraped endpoint IP-blocked us — kept, retargeted at GDELT.)
const HYPE_BACKOFF_MAX_MS = 4 * 60 * 60_000; // 4h cap
let hypeBackoffMs = HYPE_POLL_MS;
async function hypeTick() {
  let nextHypeDelay = HYPE_POLL_MS;
  try {
    const { ok, failed, total } = await refreshHype(crosswalk, state);
    if (total > 0 && failed / total > 0.8) {
      hypeBackoffMs = Math.min(hypeBackoffMs * 2, HYPE_BACKOFF_MAX_MS);
      nextHypeDelay = hypeBackoffMs;
      console.error(`hype: ${failed}/${total} failed — likely rate-limited/blocked, backing off to ${Math.round(nextHypeDelay / 60000)}m.`);
    } else {
      hypeBackoffMs = HYPE_POLL_MS; // recovered — reset backoff
    }
  } catch (e) {
    console.error('hype refresh failed:', e.message);
    hypeBackoffMs = Math.min(hypeBackoffMs * 2, HYPE_BACKOFF_MAX_MS);
    nextHypeDelay = hypeBackoffMs;
  }
  setTimeout(hypeTick, nextHypeDelay);
}
hypeTick();

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, generatedAt: state.generatedAt }));
    return;
  }

  if (url.pathname === '/debug/unmatched') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state._unmatchedSquadNames || {}));
    return;
  }

  // One-off diagnostic (1 extra API-Football call, no state mutation):
  // re-fetches the raw fixturePlayers stats for every player on a nation's
  // side in a given player's fixture (most recent by default, or a specific
  // one via ?date=MM-DD — a player can have several events, and the stale
  // one under investigation isn't always the latest), so we can see exactly
  // what API-Football itself reports (games.substitute/minutes/rating)
  // rather than guessing from our own derived min:0 events.
  if (url.pathname === '/debug/rawstats') {
    const id = url.searchParams.get('id');
    const date = url.searchParams.get('date');
    const p = id && state.players[id];
    const ev = p && p.events && (date ? p.events.find(e => e.d === date) : p.events[p.events.length - 1]);
    if (!ev || !ev._fid) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no event with a fixture id found for that player' }));
      return;
    }
    const nation = (state._nationOf || {})[id];
    client.fixturePlayers(ev._fid).then(playersResp => {
      const teamBlock = (playersResp || []).find(tb => canonNation(tb.team.name) === nation);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        fid: ev._fid,
        nation,
        finalPolls: state._finalPolls.get(ev._fid),
        storedEvent: ev,
        teamBlockFound: !!teamBlock,
        players: (teamBlock?.players || []).map(pl => ({ name: pl.player.name, games: pl.statistics?.[0]?.games })),
      }, null, 2));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // Temporary: dumps the global write-audit trail (every write to any
  // player's event, from both the normal poll loop and manual repairs,
  // tagged by source + timestamp) — lets us see whether a concurrent poll
  // cycle overwrites a repair's write for the same fid/player right after
  // it lands. ?id=<playerId> filters to just that player. Remove once the
  // write-then-revert bug is root-caused.
  if (url.pathname === '/debug/writelog') {
    const id = url.searchParams.get('id');
    const log = getWriteLog();
    const filtered = id ? log.filter(w => w.id === id) : log;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: filtered.length, entries: filtered }, null, 2));
    return;
  }

  // One-off repair pass (POST, mutates state + saves it): re-fetches only
  // the fixtures stuck with a stale bench marker after exhausting their
  // normal grace-polls — see repairStaleFixtures() in poll.mjs. Safe to run
  // any time; a no-op if nothing is stuck.
  if (url.pathname === '/admin/repair-stale-events' && req.method === 'POST') {
    repairStaleFixtures(client, crosswalk, state).then(result => {
      saveState(state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch(e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  if (url.pathname === '/prices.json' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(publicSnapshot(state)));
    return;
  }

  if (url.pathname === '/trade' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { id, side, qty, price, referral } = JSON.parse(body);
        const q = typeof qty === 'number' && qty > 0 ? qty : 1;
        if (typeof id !== 'string' || !['buy', 'sell', 'hatewatch', 'cover'].includes(side)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); return;
        }
        if (side === 'buy') {
          if (referral) {
            // Referral awards are new issuance — bypass supply check, expand total if sold out.
            await expandAndDecrementShares(id, q, price || 100);
          } else {
            const result = await decrementShares(id, q, price || 100);
            if (!result.ok) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, reason: 'no_shares', remaining: result.remaining }));
              return;
            }
          }
          const sh = await loadShares();
          state.shares = state.shares || {};
          if (sh[id]) state.shares[id] = { remaining: sh[id].remaining, total: sh[id].total };
          recordTrade(state, id, 'buy', q);
        } else if (side === 'sell') {
          await incrementShares(id, q, price || 100);
          state.shares = state.shares || {};
          const sh = await loadShares();
          if (sh[id]) state.shares[id] = { remaining: sh[id].remaining, total: sh[id].total };
          recordTrade(state, id, 'sell', q);
        } else if (side === 'hatewatch') {
          recordHatewatch(state, id, q);
        } else if (side === 'cover') {
          recordHatewatch(state, id, -q);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request');
      }
    });
    return;
  }

  if (url.pathname === '/shares.json') {
    loadShares().then(shares => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(shares));
    }).catch(() => { res.writeHead(500); res.end('error'); });
    return;
  }

  if (url.pathname === '/price-closes' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { dayKey, closes } = JSON.parse(body);
        if (typeof dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || typeof closes !== 'object') {
          res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); return;
        }
        recordPriceCloses(state, closes, dayKey);
        // Repair stale share totals using the frontend-computed prices.
        if (!_sharesRepaired) {
          _sharesRepaired = true;
          repairShareTotals(id => closes[id] || 0).catch(() => {});
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request');
      }
    });
    return;
  }

  if (url.pathname === '/leaderboard') {
    if (req.method === 'GET') {
      getLeaderboard().then(rows => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      }).catch(() => { res.writeHead(500); res.end('error'); });
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const { token, name, netWorth } = JSON.parse(body);
          if (!token || !name) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); return; }
          submitScore(token, name, netWorth).then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }).catch(() => { res.writeHead(500); res.end('error'); });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request');
        }
      });
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => console.log(`live-worker listening on :${PORT}`));
