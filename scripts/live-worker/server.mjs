#!/usr/bin/env node
// Always-on Fly.io worker: polls API-Football for WC2026 and serves the
// resulting prices.json over HTTP. Replaces the daily GitHub Action — see
// CLAUDE.md rule 1 (data fetching is server-side only) and rule 4 (we
// compute our own rating, never store a third-party one).
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { loadCrosswalk } from '../lib/crosswalk.mjs';
import { makeClient } from './api-football.mjs';
import { pollOnce, makeInitialState, publicSnapshot } from './poll.mjs';
import { refreshHype } from './hype.mjs';

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

const client = makeClient(API_KEY);
const crosswalk = loadCrosswalk(HTML_PATH);
console.log(`Loaded crosswalk: ${crosswalk.length} players across ${new Set(crosswalk.map(p => p.nation)).size} nations.`);

const state = makeInitialState(SEASON);

let nextDelay = IDLE_POLL_MS;
async function tick() {
  try {
    const { liveCount } = await pollOnce(client, crosswalk, state);
    nextDelay = liveCount > 0 ? LIVE_POLL_MS : IDLE_POLL_MS;
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

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, generatedAt: state.generatedAt }));
    return;
  }

  if (url.pathname === '/prices.json' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(publicSnapshot(state)));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => console.log(`live-worker listening on :${PORT}`));
