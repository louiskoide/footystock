// In-memory real leaderboard. Keyed by anonymous client token so one
// user can't overwrite another's entry. Resets on worker redeploy —
// acceptable while user counts are low. When persistence is needed,
// swap this out for Supabase per CLAUDE.md.

const MAX_ENTRIES = 200;
const STARTING_CAPITAL = 10000;

export function submitScore(state, token, name, netWorth) {
  if (!state.leaderboard) state.leaderboard = {};
  const k = String(token).slice(0, 64);
  const n = String(name).trim().slice(0, 32) || 'Anonymous';
  // Clamp net worth to a sane range — the game starts at $10k and even
  // aggressive compounding won't realistically clear $10M in a tournament.
  const nw = Math.max(0, Math.min(10_000_000, Math.round(Number(netWorth) || STARTING_CAPITAL)));
  state.leaderboard[k] = { name: n, netWorth: nw, updatedAt: Date.now() };

  // Prune the long tail if we've grown past the cap
  const entries = Object.entries(state.leaderboard);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1].netWorth - a[1].netWorth);
    state.leaderboard = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
  }
}

export function getLeaderboard(state) {
  if (!state.leaderboard) return [];
  return Object.values(state.leaderboard)
    .sort((a, b) => b.netWorth - a.netWorth)
    .slice(0, 100)
    .map(({ name, netWorth }) => ({ name, netWorth }));
}
