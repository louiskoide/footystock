// Real, independent hype signal — see pricing-model.md Signal 3. Hype must
// (a) decay on its own and (b) never leak realized performance into it (the
// old transferSig/change30d mixing this doc explicitly calls out as the bug
// to avoid). Google Trends search interest is the best free real-time buzz
// proxy and is naturally both: its 0-100 scale is already relative to the
// keyword's own peak in the queried window, so comparing a short recent
// window against a longer trailing baseline gives a self-decaying,
// self-centering score with no synthetic decay logic needed.
import googleTrends from 'google-trends-api';

const REQUEST_GAP_MS = 1200; // sequential + polite — avoid Trends' 429s
const WINDOW_DAYS = 30;
const RECENT_POINTS = 2; // most recent ~2 days of the timeline

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function fetchOnePlayerHype(name) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - WINDOW_DAYS * 86400000);
  const raw = await googleTrends.interestOverTime({ keyword: name, startTime, endTime });
  const parsed = JSON.parse(raw);
  const points = parsed?.default?.timelineData || [];
  const values = points.map(p => p.value?.[0] ?? 0);
  if (values.length < 5) return 0;
  const recent = values.slice(-RECENT_POINTS);
  const older = values.slice(0, -RECENT_POINTS);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const baseline = median(older.length ? older : values);
  return recentAvg - baseline; // mean-centered (0 = no fresh spike), roughly -100..100
}

// Refreshes state.hype[id] = { score, updatedAt } for every crosswalk
// player, one at a time. Failures (rate limit, no data for an obscure name,
// etc.) just skip that player for this cycle — they keep their last known
// score (or the cold-start default of 0, "average", per the project's
// established fallback convention) rather than poisoning the run.
export async function refreshHype(crosswalk, state, log = console.log) {
  state.hype = state.hype || {};
  let ok = 0, failed = 0;
  for (const p of crosswalk) {
    try {
      const delta = await fetchOnePlayerHype(p.name);
      state.hype[p.id] = { score: Math.round(delta), updatedAt: new Date().toISOString() };
      ok++;
    } catch (e) {
      failed++;
      log(`hype ${p.name} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
  }
  log(`hype: refreshed ${ok}/${crosswalk.length} players (${failed} failed).`);
}
