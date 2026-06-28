// Real, independent hype signal — see pricing-model.md Signal 3. Hype must
// (a) decay on its own and (b) never leak realized performance into it (the
// old transferSig/change30d mixing this doc explicitly calls out as the bug to
// avoid).
//
// Source: GDELT DOC 2.0 (api.gdeltproject.org), the news-hype owner in
// data-sources.md. Free, no API key. Replaces Google Trends, whose unofficial
// scraped endpoint IP-blocked the Fly worker (every request came back an HTML
// challenge), so hype was silently stuck at the cold-start 0 for everyone.
//
// For each player we query their name (+ a football disambiguator) over a short
// recent window and read GDELT's ToneChart: a histogram of matching articles by
// automated tone. From it we get two things — VOLUME (how much they're being
// talked about) and average TONE (praise vs criticism). The score combines them
// (sentiment direction x buzz magnitude), mean-centered across the player pool
// so an average player scores ~0. Decay is free: the moving window means old
// news falls out as time passes, no synthetic half-life needed. Tone is GDELT's
// own lexicon score, not a licensed third-party rating (CLAUDE.md rule 4 is
// about pundit *ratings* of players; article sentiment is fair game).
//
// Caveat: GDELT tone is the *article's* overall tone, not sentiment toward the
// specific player — only meaningful in aggregate, where per-article noise
// cancels. Good enough for a buzz proxy; not a per-player verdict.

const BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
const REQUEST_GAP_MS = 1500; // sequential + polite — GDELT soft-throttles bursts
const WINDOW = '3d';         // recent-news window; sliding it IS the decay
const SCALE = 15;            // maps sentiment*confidence into the ~-100..100 score scale the frontend's moodSig expects

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// One GDELT ToneChart pull → { vol, tone } for a single player. Throws on any
// throttle/parse failure so the caller can skip the player for this cycle.
async function fetchOnePlayerHype(name) {
  const query = `"${name}" (soccer OR football)`;
  const url = `${BASE}?query=${encodeURIComponent(query)}&mode=tonechart&timespan=${WINDOW}&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'FootyStock/1.0 (entertainment hype index)' } });
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('GDELT returned non-JSON (likely throttled)'); }
  // ToneChart bins articles by tone: [{ bin, count }, ...]. Volume is the total
  // article count; tone is the count-weighted average of the bins.
  const bins = data.tonechart || [];
  let vol = 0, weighted = 0;
  for (const b of bins) {
    const c = b.count || 0;
    const t = (b.bin != null) ? b.bin : (b.tone != null ? b.tone : 0);
    vol += c;
    weighted += t * c;
  }
  return { vol, tone: vol ? weighted / vol : 0 };
}

// Refreshes state.hype[id] = { score, updatedAt } for every crosswalk player.
// Two-pass: gather (vol, tone) for everyone we can reach, then derive
// cohort-relative, mean-centered scores so an average player lands at ~0.
// Players we failed to fetch keep their last known score (or the cold-start 0).
export async function refreshHype(crosswalk, state, log = console.log) {
  state.hype = state.hype || {};
  const raw = []; // { id, vol, tone }
  let ok = 0, failed = 0;
  for (const p of crosswalk) {
    try {
      const { vol, tone } = await fetchOnePlayerHype(p.name);
      raw.push({ id: p.id, vol, tone });
      ok++;
    } catch (e) {
      failed++;
      log(`hype ${p.name} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, REQUEST_GAP_MS));
  }

  // Cohort baselines from players who actually got coverage this window.
  const covered = raw.filter(r => r.vol > 0);
  const cohortTone = median(covered.map(r => r.tone)); // "neutral" news tone for football right now
  const medVol = median(covered.map(r => r.vol)) || 1;

  // sentiment (tone vs cohort) x confidence (more coverage = stronger signal).
  const scored = raw.map(r => {
    const sentiment = r.tone - cohortTone;            // + = praised vs the news baseline, - = criticized
    const confidence = Math.min(1, r.vol / (medVol * 2)); // full weight at ~2x median coverage; ~0 for quiet players
    return { id: r.id, s: sentiment * confidence * SCALE };
  });

  // Mean-center so the average player scores 0 (pricing-model.md mean-centering rule).
  const medScore = median(scored.map(x => x.s));
  const now = new Date().toISOString();
  for (const x of scored) {
    const score = Math.max(-100, Math.min(100, Math.round(x.s - medScore)));
    state.hype[x.id] = { score, updatedAt: now };
  }

  log(`hype: refreshed ${ok}/${crosswalk.length} via GDELT (${failed} failed, ${covered.length} with coverage).`);
  return { ok, failed, total: crosswalk.length };
}
