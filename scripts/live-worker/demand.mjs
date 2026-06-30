// Simulated market demand: virtual agents create buy/sell pressure that
// moves prices above/below fair value. Real user trades feed the same
// state.demand[id] signal, so the market transitions naturally from
// "all simulated" to "real users dominate" as traffic grows.
//
// state.demand[id] is a float in [-1, 1]:
//   0  = neutral / no pressure
//  +1  = maximum buy pressure  → ~+15% above fair value
//  -1  = maximum sell pressure → ~-15% below fair value
//
// The frontend applies it as: price = fairValue * exp(0.15 * demand)

const DECAY_HALF_LIFE_MS = 10 * 60 * 60 * 1000; // pressure fades in ~10h
const MOMENTUM_IMPULSE   = 0.012; // max agent push per tick from match quality
const NOISE_IMPULSE      = 0.003; // random walk per tick for quiet players

// Fast deterministic hash: uint32 -> [0, 1)
function rand01(n) {
  let h = (n ^ 0xdeadbeef) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// String -> uint32 (djb2)
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

// Recent-match momentum: rating 6.0 = neutral → 0, 9.5 → ~1, 3.0 → ~-1
function recentMomentum(playerState) {
  if (!playerState?.events?.length) return 0;
  const ev = [...playerState.events].reverse().find(e => e.rating != null && e.min > 0);
  if (!ev) return 0;
  return Math.max(-1, Math.min(1, (ev.rating - 6.0) / 3.5));
}

// Advance the fake-agent demand simulation by one poll interval.
// elapsedMs is the actual wall-clock time since the last tick, used
// to compute the correct exponential decay regardless of poll cadence.
export function tickDemand(state, crosswalk, elapsedMs) {
  if (!state.demand) state.demand = {};
  // Roll trade totals over at midnight regardless of whether any trades happened.
  const today = new Date().toISOString().slice(0, 10);
  if (state._tradeDay && state._tradeDay !== today) {
    state.tradeTotalsYday = state.tradeTotals || { buy: {}, sell: {} };
    state.tradeTotals = { buy: {}, sell: {} };
  }
  state._tradeDay = today;
  state._demandTick = (state._demandTick || 0) + 1;
  const tick = state._demandTick;
  const decayFactor = Math.pow(0.5, elapsedMs / DECAY_HALF_LIFE_MS);

  for (const { id } of crosswalk) {
    const d = state.demand[id] || 0;
    const momentum = recentMomentum(state.players[id]);
    // Noise seed mixes player id with tick counter so each player gets an
    // independent random walk, but the same (id, tick) always gives the
    // same noise value — no surprises on restart.
    const noise = (rand01((hashStr(id) ^ tick) >>> 0) - 0.5) * 2 * NOISE_IMPULSE;
    const nd = Math.max(-1, Math.min(1, d * decayFactor + momentum * MOMENTUM_IMPULSE + noise));
    if (Math.abs(nd) < 0.0005) delete state.demand[id];
    else state.demand[id] = parseFloat(nd.toFixed(5));
  }
}

// Real user buy/sell: adds a small demand impulse so actual trades move
// the shared price. Sized so a handful of real trades ≈ sustained agent
// momentum for one poll cycle — enough to be meaningful without letting
// one user dominate a deep market.
// Also accumulates global trade volume counters so the frontend can show
// the most-bought / most-sold players across all users.
export function recordTrade(state, id, side, qty = 1) {
  if (!state.demand) state.demand = {};
  const impulse = side === 'buy' ? 0.12 : -0.12;
  state.demand[id] = Math.max(-1, Math.min(1, (state.demand[id] || 0) + impulse));

  if (!state.tradeTotals) state.tradeTotals = { buy: {}, sell: {} };
  if (side === 'buy') {
    state.tradeTotals.buy[id] = (state.tradeTotals.buy[id] || 0) + qty;
  } else if (side === 'sell') {
    state.tradeTotals.sell[id] = (state.tradeTotals.sell[id] || 0) + qty;
  }
}

// Hatewatch: counts open short positions globally per player.
// Each open hatewatch position drags the hype multiplier down by a small
// amount — if enough users are hatewatching, it meaningfully suppresses
// hype-driven price inflation, creating organic downward pressure without
// requiring real short-selling mechanics.
export function recordHatewatch(state, id, delta) {
  if (!state.hateCount) state.hateCount = {};
  state.hateCount[id] = Math.max(0, (state.hateCount[id] || 0) + delta);
  // Also push demand slightly negative — same as a sell impulse.
  if (!state.demand) state.demand = {};
  if (delta > 0) {
    state.demand[id] = Math.max(-1, (state.demand[id] || 0) - 0.08);
  }
}
