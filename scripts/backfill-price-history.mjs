/**
 * Re-runnable script: backfill Supabase price_history with realistic past
 * closes, driven by actual World Cup match performances rather than a smooth
 * random walk. Supabase's price_history had accumulated almost nothing since
 * an initial April seed (2 day-keys total across 90 days of tournament), so
 * priceHistory() on the frontend was reading mostly-synthetic filler for the
 * whole 7d/30d/90d window — that's why every stock read flat.
 *
 * Prefers REAL match events from the live worker's /prices.json
 * (players[id].events — goals/assists/cards/rating per fixture, the same
 * data the "match by match" panel shows) over the hand-typed STARS/WC
 * fallback in FootyStock_dc.html, for any player the worker has actually
 * polled. Falls back to STARS for players the worker hasn't covered yet
 * (matches the frontend's own precedence, see `starsEff` in buildDB()).
 * Zero API-Football calls — only reads the worker's already-polled data.
 *
 * Runs the same event-driven bump/decay pricing math as buildDB() (see
 * FootyStock_dc.html "history 90d ending at current price" section) so a
 * match-day jump on the backfilled chart matches what the live app would
 * have shown that day, then upserts days 0..88 (past only — today is left
 * for the live app). Safe to re-run as the worker's coverage improves.
 *
 * Usage:  node scripts/backfill-price-history.mjs
 *         LIVE_WORKER_URL=https://footystock.fly.dev node scripts/backfill-price-history.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(path.join(__dirname, '..', 'FootyStock_dc.html'), 'utf8');

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';

// ── extract sections from HTML ─────────────────────────────────────────────

function extractBetween(src, startPattern, endPattern) {
  const si = src.indexOf(startPattern);
  if (si === -1) throw new Error('Start pattern not found: ' + startPattern);
  const ei = src.indexOf(endPattern, si + startPattern.length);
  if (ei === -1) throw new Error('End pattern not found: ' + endPattern);
  return src.slice(si + startPattern.length, ei);
}

// ROSTER: lines like "Name|Team|Pos|Age|Tier"
const rosterRaw = extractBetween(HTML, 'ROSTER(){ return `\n', '\`; }');

// VAL table: extract by running the VAL() function body
const valRaw = extractBetween(HTML, 'VAL(){ if(this._val) return this._val; const v={}; const A=s=>s.split(\',\').forEach(p=>{p=p.trim();const i=p.lastIndexOf(\' \');v[p.slice(0,i).trim()]=+p.slice(i+1);});', 'this._val=v; return v;');
// Execute it to get the actual map
const valFn = new Function(`
  const v = {};
  const A = s => s.split(',').forEach(p => { p = p.trim(); const i = p.lastIndexOf(' '); v[p.slice(0,i).trim()] = +p.slice(i+1); });
  ${valRaw}
  return v;
`);
const VAL = valFn();

// STARS, WC, NEWS — extract the DATA() function body and eval it
const dataBody = extractBetween(HTML, 'DATA(){ if(this._data) return this._data;\n', 'this._data={WC,STARS,NEWS,MOOD,ARTICLES,NATION:nat};');
const dataFn = new Function(`
  ${dataBody}
  return {WC, STARS, NEWS, NATION: nat};
`);
const { WC, STARS, NEWS, NATION } = dataFn();

// ── live worker data (real match events — zero API-Football calls) ────────

const WORKER_URL = process.env.LIVE_WORKER_URL || 'https://footystock.fly.dev';
const live = await fetch(`${WORKER_URL}/prices.json`).then(r => r.json()).catch(e => {
  console.error(`Could not reach live worker (${e.message}) — falling back to STARS-only for every player.`);
  return null;
});
const liveEventsById = {};
const liveNationById = {};
if (live?.players) {
  for (const [id, p] of Object.entries(live.players)) {
    if ((p.events || []).length) liveEventsById[id] = p.events;
    if (p.nation) liveNationById[id] = p.nation;
  }
}
const liveTeams = live?.teams || {};
console.log(live ? `Live worker: ${Object.keys(liveEventsById).length} players with real events.` : 'Live worker unreachable.');

// ── helpers ────────────────────────────────────────────────────────────────

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  return h >>> 0;
}
function mulberry(seed) {
  return function () {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function slug(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ── pricing ────────────────────────────────────────────────────────────────

const TODAY_KEY = new Date().toISOString().slice(0, 10);
const tierBase = { 1: 228, 2: 158, 3: 99, 4: 58, 5: 35, 6: 23 };

function offOf(dateStr) {
  return Math.round(
    (new Date(TODAY_KEY + 'T00:00:00Z') - new Date('2026-' + dateStr + 'T00:00:00Z')) / 86400000
  );
}

function dayKeyForOffset(offset) {
  const d = new Date(TODAY_KEY + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function computeSyntheticHist(id, name, pos, age, tier) {
  const r = mulberry(hash(id));
  const mv = VAL[name];
  const youth = age <= 21 ? 1 : 0;
  const anchor = (mv != null) ? mv : tierBase[tier] * (0.9 + 0.5 * r()) * (youth ? 1.15 : 1);

  // Real polled events (from the live worker) take priority over the
  // hand-typed STARS fallback for any player the worker has actually
  // matched — same precedence buildDB() uses on the frontend.
  const liveEvents = liveEventsById[id];
  const starsEff = (liveEvents && liveEvents.length) ? liveEvents : (STARS[id] || null);
  const news = NEWS[id] || null;
  const nation = liveNationById[id] || NATION[name] || null;
  const wc = (nation && (liveTeams[nation] || WC[nation])) || null;
  const eliminated = !!(wc && /^Eliminated/.test(wc.status));
  const atWC = !!starsEff;

  let events = [];
  if (starsEff) {
    for (const s of starsEff) {
      if (s.rating == null) continue; // bench
      const g = s.g || 0, a = s.a || 0;
      const goalPart = g * 1.0 + (g >= 2 ? Math.pow(g - 1, 1.6) * 0.9 : 0);
      const assistPart = a * 0.6 + (a >= 2 ? Math.pow(a - 1, 1.4) * 0.4 : 0);
      const ratingExcess = Math.max(0, s.rating - 8.0);
      const isDefPos = /^(CB|LB|RB|WB|GK|DEF|SW)$/i.test(pos);
      const ratingBase = isDefPos ? 6.5 : 6.0;
      const ratingPart = (s.rating - ratingBase) * 1.3 + Math.pow(ratingExcess, 1.8) * 1.5;
      const delta = parseFloat((ratingPart + goalPart + assistPart).toFixed(2));
      events.push({ offset: offOf(s.d), delta });
    }
  }

  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const newsDelta = news ? news.bias : 0;
  let change30d = parseFloat((sum(events.map(e => e.delta)) + newsDelta).toFixed(1));
  // A player with no match data at all (not at the WC) can still have a
  // real signal — a transfer, an award, a saga — via NEWS alone. Gate the
  // historical trend/noise on that too, matching buildDB()'s hasSignal.
  const hasSignal = atWC || !!news;

  const ratingVals = starsEff ? starsEff.map(s => s.rating).filter(x => x > 0) : [];
  const avgR = ratingVals.length ? sum(ratingVals) / ratingVals.length : 0;
  const ratingsByRecency = (starsEff || []).slice().sort((a, b) => (a.offset || 0) - (b.offset || 0)).map(s => s.rating).filter(x => x > 0);
  let streakLen = 0;
  for (const rt of ratingsByRecency) { if (rt >= 7.4) streakLen++; else break; }

  const fotmob = avgR ? Math.max(8, Math.min(99, (avgR - 2.6) / 7.4 * 100)) : 0;
  let ewmaR = 0, ewmaW = 0, wgt = 1;
  for (const rt of ratingsByRecency.slice(0, 6)) { ewmaR += rt * wgt; ewmaW += wgt; wgt *= 0.75; }
  ewmaR = ewmaW ? ewmaR / ewmaW : 0;
  const formDelta = (ewmaW && avgR) ? (ewmaR - avgR) : 0;
  const formSig = atWC ? Math.max(6, Math.min(99, 46 + formDelta * 22 + streakLen * 4)) : 8;

  const moodSig = Math.max(6, Math.min(99, (46 + (starsEff ? 14 : 0)) - (eliminated ? 30 : 0)));
  const transferSig = news ? (news.bias >= 0 ? Math.min(99, 72 + news.bias * 2) : Math.max(20, 52 + news.bias * 3)) : Math.max(8, Math.min(90, 46));

  const wPerf = 0.06, wForm = 0.10, wHype = 0.35;
  const hasMatchData = atWC && avgR > 0;
  const notoriety = clamp((anchor - 20) / 180, 0, 1);
  const rawPerf = hasMatchData ? clamp((fotmob - 46) / 18, -1, 1) : 0;
  const rawForm = hasMatchData ? clamp((formSig - 46) / 18, -1, 1) : 0;
  const upMult = 1.55 - 0.8 * notoriety;
  const downMult = 0.60 + 0.8 * notoriety;
  const formDownMult = downMult * (1 + notoriety * 0.4);
  const applyMult = (v, up, dn) => v >= 0 ? v * up : v * dn;
  const applyFormMult = v => v >= 0 ? v * upMult : v * formDownMult;
  const perfScore = applyMult(rawPerf, upMult, downMult);
  const formScore = applyFormMult(rawForm);
  const hypeScore = clamp(((moodSig - 46) + (transferSig - 46)) / 2 / 30, -1, 1) * (1.3 - 0.4 * notoriety);

  const fairValueBase = anchor * Math.exp(wPerf * perfScore + wForm * formScore);
  const fairValue = fairValueBase * Math.exp(wHype * hypeScore);
  const price = fairValue;

  const N = 90;
  const hist = [];
  const trend = hasSignal ? clamp(change30d / 100, -0.4, 0.4) : (r() - 0.5) * 0.04;
  const start = price / (1 + trend * 1.05);
  const steps = []; let acc = 0;
  for (let i = 0; i < N; i++) { acc += (r() - 0.5); steps.push(acc); }
  const s0 = steps[0], s1 = steps[N - 1];
  const bridge = steps.map((v, i) => v - (s0 + (s1 - s0) * i / (N - 1)));
  const bridgeMax = Math.max(...bridge.map(Math.abs)) || 1;
  const noiseAmp = price * (hasSignal ? 0.012 : 0.006);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const baseV = start + (price - start) * Math.pow(t, 1.15);
    hist.push(Math.max(2, baseV + (bridge[i] / bridgeMax) * noiseAmp));
  }

  // Match-performance bumps, plus — unlike buildDB(), which only bumps off
  // real match events since news also feeds the match-by-match UI panel
  // there — a discrete bump for the transfer/news event itself. The backfill
  // only ever writes past closes to Supabase (nothing here is rendered as a
  // match card), so there's no UI reason to fold it into `events`; this is
  // exactly the "price jump the performance gives you" shape requested for
  // transfers, just sourced from NEWS instead of a match rating.
  const bumpEvents = news ? [...events, { offset: offOf(news.d), delta: news.bias }] : events;
  for (const e of bumpEvents) {
    const idx = N - 1 - e.offset;
    if (idx < 0 || idx >= N) continue;
    const downScale = e.delta < 0 ? 1.0 * (1 + notoriety * 0.25) : 1.0;
    const bump = (e.delta / 100) * price * downScale, ramp = 1, halfLife = 6;
    for (let j = idx; j < N; j++) {
      const daysIn = j - idx + 1;
      const riseK = Math.min(1, daysIn / ramp);
      const eased = riseK * riseK * (3 - 2 * riseK);
      const decay = Math.pow(0.5, Math.max(0, daysIn - ramp) / halfLife);
      hist[j] += bump * eased * decay;
    }
  }

  if (eliminated && wc && wc.fixtures && wc.fixtures.length) {
    const lastFixture = wc.fixtures[wc.fixtures.length - 1];
    const elimOffset = offOf(lastFixture.d);
    const idx = N - 1 - elimOffset;
    if (idx >= 0 && idx < N) {
      const bump = -price * 0.08, ramp = 2, halfLife = 10;
      for (let j = idx; j < N; j++) {
        const daysIn = j - idx + 1;
        const riseK = Math.min(1, daysIn / ramp);
        const eased = riseK * riseK * (3 - 2 * riseK);
        const decay = Math.pow(0.5, Math.max(0, daysIn - ramp) / halfLife);
        hist[j] += bump * eased * decay;
      }
    }
  }

  // Daily wobble — same seed as buildDB
  const wR = mulberry(hash(id + ':w:' + TODAY_KEY));
  const wMag = atWC ? 0.02 : 0.006;
  hist[N - 1] = Math.max(2, hist[N - 1] * (1 + (wR() - 0.5) * 2 * wMag));
  for (let i = 0; i < N; i++) hist[i] = Math.max(2, hist[i]);

  return hist;
}

// ── Supabase upsert ────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

async function upsertBatch(rows) {
  if (DRY_RUN) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/price_history`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase upsert failed: ${r.status} ${await r.text()}`);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const lines = rosterRaw.trim().split('\n');
  const seen = {};
  const allRows = [];
  let playerCount = 0, liveDrivenCount = 0, starsDrivenCount = 0;

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 5) continue;
    let [name, team, pos, age, tier] = parts;
    name = name.replace(/ dummy.*$/, '').trim();
    tier = parseInt(tier); age = parseInt(age);
    const id = slug(name + '-' + team);
    if (seen[id]) continue;
    seen[id] = 1;
    playerCount++;

    if (liveEventsById[id]?.length) liveDrivenCount++;
    else if (STARS[id]) starsDrivenCount++;

    const hist = computeSyntheticHist(id, name, pos, age, tier);
    // Only upsert past days (indices 0..88), skip today (index 89)
    for (let i = 0; i < 89; i++) {
      const offset = 89 - i;
      const dayKey = dayKeyForOffset(offset);
      allRows.push({ player_id: id, day_key: dayKey, price: Math.round(hist[i] * 100) / 100 });
    }
  }

  console.log(`Players driven by real worker events: ${liveDrivenCount}, by hand-typed STARS fallback: ${starsDrivenCount}, no signal (flat baseline): ${playerCount - liveDrivenCount - starsDrivenCount}.`);
  console.log(`${DRY_RUN ? '[DRY RUN] Would upsert' : 'Upserting'} ${allRows.length} rows for ${playerCount} players…`);

  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    await upsertBatch(allRows.slice(i, i + CHUNK));
    process.stdout.write(`  ${Math.min(i + CHUNK, allRows.length)}/${allRows.length}\r`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
