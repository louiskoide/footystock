// Supabase-backed share supply — persists across worker restarts.
// Each player starts with floor(120000 / currentPrice) shares.
// Buys decrement remaining; sells/covers increment (up to total cap).
// The worker seeds missing rows on first trade so no manual seeding needed.

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
};

const MARKET_CAP_TARGET = 120_000; // total shares × price ≈ $120k per player

// In-memory cache to avoid a Supabase round-trip on every trade.
// Keyed by player_id → { remaining, total }
let cache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // refresh every 5 min

async function sbFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS, ...opts });
}

export async function loadShares() {
  if (cache && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cache;
  try {
    const r = await sbFetch('shares?select=player_id,remaining,total');
    if (!r.ok) { console.error('shares load failed:', await r.text()); return cache || {}; }
    const rows = await r.json();
    cache = {};
    for (const row of rows) cache[row.player_id] = { remaining: row.remaining, total: row.total };
    cacheLoadedAt = Date.now();
  } catch (e) { console.error('shares load error:', e.message); }
  return cache || {};
}

// Compute initial share count from price.
export function sharesForPrice(price) {
  return Math.max(10, Math.round(MARKET_CAP_TARGET / Math.max(1, price)));
}

// Sum shares already held across all portfolios for a given player.
async function existingHoldings(id) {
  try {
    const r = await sbFetch('portfolios?select=holdings');
    if (!r.ok) return 0;
    const rows = await r.json();
    let total = 0;
    for (const row of rows) {
      if (row.holdings && row.holdings[id]) total += (row.holdings[id].qty || 0);
    }
    return total;
  } catch (e) { return 0; }
}

// Seed a row if it doesn't exist yet (called lazily on first trade for that player).
// Subtracts already-held shares so existing portfolios are reflected from day one.
async function ensureRow(id, price) {
  if (cache && cache[id]) return;
  const total = sharesForPrice(price);
  const held = await existingHoldings(id);
  const remaining = Math.max(0, total - held);
  try {
    const r = await sbFetch('shares', {
      method: 'POST',
      headers: { ...HEADERS, 'Prefer': 'resolution=ignore-duplicates' },
      body: JSON.stringify({ player_id: id, remaining, total }),
    });
    if (!r.ok && r.status !== 409) console.error('shares seed error:', await r.text());
    if (!cache) cache = {};
    if (!cache[id]) cache[id] = { remaining, total };
  } catch (e) { console.error('shares seed error:', e.message); }
}

// Reconcile all existing share rows against current portfolio holdings.
// Call once on worker startup to fix any rows that were seeded before
// existing holdings were accounted for.
export async function reconcileShares() {
  try {
    const [sharesResp, portfoliosResp] = await Promise.all([
      sbFetch('shares?select=player_id,remaining,total'),
      sbFetch('portfolios?select=holdings'),
    ]);
    if (!sharesResp.ok || !portfoliosResp.ok) return;
    const shareRows = await sharesResp.json();
    const portfolios = await portfoliosResp.json();

    // Sum held per player across all portfolios
    const heldMap = {};
    for (const row of portfolios) {
      if (!row.holdings) continue;
      for (const [pid, h] of Object.entries(row.holdings)) {
        heldMap[pid] = (heldMap[pid] || 0) + (h.qty || 0);
      }
    }

    // Fix any row where remaining + held != total
    for (const row of shareRows) {
      const held = heldMap[row.player_id] || 0;
      const correct = Math.max(0, row.total - held);
      if (correct !== row.remaining) {
        await sbFetch(`shares?player_id=eq.${encodeURIComponent(row.player_id)}`, {
          method: 'PATCH',
          headers: { ...HEADERS, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ remaining: correct }),
        });
        if (cache && cache[row.player_id]) cache[row.player_id].remaining = correct;
        console.log(`shares reconcile: ${row.player_id} ${row.remaining}→${correct} (${held} held)`);
      }
    }
    cacheLoadedAt = 0; // force refresh after reconcile
  } catch (e) { console.error('shares reconcile error:', e.message); }
}

// Attempt to decrement remaining by qty. Returns { ok, remaining } after the operation.
// Uses Supabase RPC or a read-then-write — we do read-then-write since RPC needs a
// custom function. Race conditions at 100 users are acceptable; we degrade gracefully.
export async function decrementShares(id, qty, price) {
  await ensureRow(id, price);
  const shares = (await loadShares())[id];
  if (!shares) return { ok: false, remaining: 0, total: 0 };
  const newRemaining = shares.remaining - qty;
  if (newRemaining < 0) return { ok: false, remaining: shares.remaining, total: shares.total };
  try {
    const r = await sbFetch(`shares?player_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...HEADERS, 'Prefer': 'return=representation' },
      body: JSON.stringify({ remaining: newRemaining }),
    });
    if (!r.ok) { console.error('shares decrement error:', await r.text()); return { ok: false, remaining: shares.remaining, total: shares.total }; }
    if (cache && cache[id]) cache[id].remaining = newRemaining;
    return { ok: true, remaining: newRemaining, total: shares.total };
  } catch (e) { console.error('shares decrement error:', e.message); return { ok: false, remaining: shares.remaining, total: shares.total }; }
}

// Increment remaining (sell/cover) — capped at total.
export async function incrementShares(id, qty, price) {
  await ensureRow(id, price);
  const shares = (await loadShares())[id];
  if (!shares) return;
  const newRemaining = Math.min(shares.total, shares.remaining + qty);
  try {
    const r = await sbFetch(`shares?player_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...HEADERS, 'Prefer': 'return=representation' },
      body: JSON.stringify({ remaining: newRemaining }),
    });
    if (!r.ok) { console.error('shares increment error:', await r.text()); return; }
    if (cache && cache[id]) cache[id].remaining = newRemaining;
  } catch (e) { console.error('shares increment error:', e.message); }
}

// Expose full shares map for publicSnapshot — force-refresh from DB.
export async function getSharesSnapshot() {
  cacheLoadedAt = 0; // force refresh
  return loadShares();
}
