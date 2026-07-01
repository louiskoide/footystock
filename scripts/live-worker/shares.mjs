// Supabase-backed share supply — persists across worker restarts.
// Each player starts with floor(20000 / anchor) shares, where anchor is the
// player's fundamental market value (Transfermarkt-style, in $M-equivalent).
// Using anchor instead of live price keeps supply stable — price surges don't
// artificially inflate or deflate the share count.
// Buys decrement remaining; sells/covers increment (up to total cap).
// The worker seeds missing rows on first trade so no manual seeding needed.

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
};

const MARKET_CAP_TARGET = 20_000; // total shares × anchor ≈ $20k per player

// Anchor values (Transfermarkt market value, $M) keyed by player slug.
// Used to compute stable share supply independent of live price movements.
// Tier-based fallback: tier 1→228, 2→158, 3→99, 4→58 (midpoints of tierBase).
const ANCHORS = {
  'erling-haaland-man-city':200,'kylian-mbappe-real-madrid':200,'lionel-messi-inter-miami':120,
  'vinicius-junior-real-madrid':180,'jude-bellingham-real-madrid':180,'mohamed-salah-liverpool':130,
  'bukayo-saka-arsenal':150,'phil-foden-man-city':150,'jamal-musiala-bayern':150,
  'lamine-yamal-barcelona':180,'florian-wirtz-liverpool':170,'pedri-barcelona':120,
  'martin-odegaard-arsenal':100,'enzo-fernandez-chelsea':90,'cole-palmer-chelsea':130,
  'gavi-barcelona':90,'declan-rice-arsenal':100,'virgil-van-dijk-liverpool':80,
  'trent-alexander-arnold-liverpool':80,'federico-valverde-real-madrid':90,
  'bernardo-silva-man-city':70,'joshua-kimmich-bayern':60,'kevin-de-bruyne-napoli':60,
  'bruno-fernandes-man-utd':70,'son-heung-min-spurs':60,'marcus-rashford-barcelona':70,
  'harry-kane-bayern':80,'robert-lewandowski-barcelona':50,'cristiano-ronaldo-al-nassr':30,
  'lautaro-martinez-inter':90,'raphinha-barcelona':75,'luis-diaz-bayern':80,
  'ousmane-dembele-paris-sg':80,'michael-olise-bayern':85,'xabi-simons-leipzig':80,
  'dani-olmo-leipzig':65,'kai-havertz-arsenal':70,'rodri-man-city':100,
  'william-saliba-arsenal':80,'alexander-isak-newcastle':80,'ollie-watkins-aston-villa':70,
  'cody-gakpo-liverpool':60,'darwin-nunez-liverpool':60,'matheus-cunha-man-utd':45,
  'rasmus-hojlund-man-utd':65,'khvicha-kvaratskhelia-napoli':100,'rafael-leao-milan':80,
  'christian-pulisic-milan':55,'theo-hernandez-milan':55,'folarin-balogun-monaco':35,
  'breel-embolo-monaco':25,'desire-doue-paris-sg':50,'bradley-barcola-paris-sg':50,
  'warren-zaire-emery-paris-sg':60,'mika-godts-ajax':20,'bart-verbruggen-brighton':20,
  'marcos-llorente-atletico':25,'gio-lo-celso-villarreal':12,'julian-quinones-club-america':8,
};

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

// Compute share supply from anchor (stable fundamental value), not live price.
// Falls back to a tier-based estimate for players not in ANCHORS.
export function sharesForPrice(price, id) {
  const anchor = (id && ANCHORS[id]) ? ANCHORS[id] : Math.max(8, price);
  return Math.max(10, Math.round(MARKET_CAP_TARGET / Math.max(1, anchor)));
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
  const total = sharesForPrice(price, id);
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

// Reconcile all existing share rows against current portfolio holdings,
// and seed rows for any player that has holdings but no row yet.
// priceOf(id) is optional — called to compute total when seeding a new row.
export async function reconcileShares(priceOf) {
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

    const existingIds = new Set(shareRows.map(r => r.player_id));

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

    // Seed rows for players that have holdings but no row yet
    for (const [pid, held] of Object.entries(heldMap)) {
      if (existingIds.has(pid) || held <= 0) continue;
      const price = priceOf ? priceOf(pid) : 100;
      const total = sharesForPrice(price, pid);
      const remaining = Math.max(0, total - held);
      await sbFetch('shares', {
        method: 'POST',
        headers: { ...HEADERS, 'Prefer': 'resolution=ignore-duplicates' },
        body: JSON.stringify({ player_id: pid, remaining, total }),
      });
      if (!cache) cache = {};
      cache[pid] = { remaining, total };
      console.log(`shares seed (reconcile): ${pid} total=${total} held=${held} remaining=${remaining}`);
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

// Referral/mystery award: bypasses supply check. If remaining < qty, expands
// total by the shortfall so the award always goes through as new issuance.
export async function expandAndDecrementShares(id, qty, price) {
  await ensureRow(id, price);
  const shares = (await loadShares())[id];
  if (!shares) return;
  const shortfall = Math.max(0, qty - shares.remaining);
  const newTotal = shares.total + shortfall;
  const newRemaining = shares.remaining + shortfall - qty;
  try {
    const r = await sbFetch(`shares?player_id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...HEADERS, 'Prefer': 'return=representation' },
      body: JSON.stringify({ remaining: newRemaining, total: newTotal }),
    });
    if (!r.ok) { console.error('shares expand error:', await r.text()); return; }
    if (cache && cache[id]) cache[id] = { remaining: newRemaining, total: newTotal };
  } catch (e) { console.error('shares expand error:', e.message); }
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

// One-time repair: recalculate total for every row using anchor-based formula.
// Adjusts remaining proportionally so held shares are preserved.
// Called once on worker boot to fix stale totals from the low-price period.
export async function repairShareTotals() {
  try {
    const [sharesResp, portfoliosResp] = await Promise.all([
      sbFetch('shares?select=player_id,remaining,total'),
      sbFetch('portfolios?select=holdings'),
    ]);
    if (!sharesResp.ok || !portfoliosResp.ok) return;
    const shareRows = await sharesResp.json();
    const portfolios = await portfoliosResp.json();

    const heldMap = {};
    for (const row of portfolios) {
      if (!row.holdings) continue;
      for (const [pid, h] of Object.entries(row.holdings)) {
        heldMap[pid] = (heldMap[pid] || 0) + (h.qty || 0);
      }
    }

    for (const row of shareRows) {
      const correctTotal = sharesForPrice(0, row.player_id); // 0 triggers anchor lookup
      if (correctTotal === row.total) continue; // already correct
      const held = heldMap[row.player_id] || 0;
      const correctRemaining = Math.max(0, correctTotal - held);
      await sbFetch(`shares?player_id=eq.${encodeURIComponent(row.player_id)}`, {
        method: 'PATCH',
        headers: { ...HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ remaining: correctRemaining, total: correctTotal }),
      });
      if (cache && cache[row.player_id]) cache[row.player_id] = { remaining: correctRemaining, total: correctTotal };
      console.log(`shares repair: ${row.player_id} total ${row.total}→${correctTotal} remaining ${row.remaining}→${correctRemaining}`);
    }
    cacheLoadedAt = 0;
  } catch (e) { console.error('shares repair error:', e.message); }
}

// Expose full shares map for publicSnapshot — force-refresh from DB.
export async function getSharesSnapshot() {
  cacheLoadedAt = 0; // force refresh
  return loadShares();
}
