// Computes our own per-match player rating from raw API-Football event data.
// CLAUDE.md rule 4: never scrape/store a third-party rating — this number is ours.
//
// Calibrated against the frontend's existing delta formula in buildDB():
//   delta = (rating-6.9)*1.3 + g*1.0 + a*0.6
// Goals/assists are already rewarded heavily there, so this rating leans on
// the *other* signals (defensive work, duels, dribbles, discipline, result)
// rather than double-counting g/a on top of what buildDB() already does.
//
// stats is one entry of API-Football's /fixtures/players response
// (statistics[0] for that fixture): { games, goals, passes, tackles, duels,
// dribbles, fouls, cards, penalty, shots }.
export function computeRating(stats, { knockout = false, result = 'draw' } = {}) {
  const minutes = stats.games?.minutes || 0;
  if (minutes <= 0) return null; // did not play — no event to record

  const goals = stats.goals?.total || 0;
  const assists = stats.goals?.assists || 0;
  const tackles = stats.tackles?.total || 0;
  const interceptions = stats.tackles?.interceptions || 0;
  const duelsWon = stats.duels?.won || 0;
  const dribblesSuccess = stats.dribbles?.success || 0;
  const keyPasses = stats.passes?.key || 0;
  const shotsOn = stats.shots?.on || 0;
  const yellow = stats.cards?.yellow || 0;
  const red = stats.cards?.red || 0;

  // Per-90 normalize the volume-based (non-discrete) signals so a 15-minute
  // cameo isn't punished/rewarded as hard as a full match — see pricing-model.md.
  const minuteScale = Math.min(1, minutes / 45);

  let rating = 6.0;
  rating += 0.5 * goals;
  rating += 0.3 * assists;
  rating += minuteScale * (0.05 * tackles + 0.05 * interceptions + 0.03 * duelsWon
    + 0.04 * dribblesSuccess + 0.03 * keyPasses + 0.03 * shotsOn);
  rating -= 0.3 * yellow;
  rating -= 1.0 * red;

  // Stakes weighting: a knockout result swings rating a bit more than a
  // dead-rubber group game (pricing-model.md: "opponent + stakes weighting").
  const stakesMult = knockout ? 1.3 : 1.0;
  const resultBump = result === 'win' ? 0.15 : result === 'loss' ? -0.15 : 0;
  rating += resultBump * stakesMult;

  return Math.max(4.5, Math.min(9.5, Math.round(rating * 100) / 100));
}
