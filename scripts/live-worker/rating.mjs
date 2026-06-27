// Computes our own per-match player rating from raw API-Football event data.
// CLAUDE.md rule 4: never scrape/store a third-party rating — this number is ours.
//
// Calibrated so a truly anonymous, did-nothing-either-way showing sits at the
// 6.0 baseline; a multi-goal game (Messi/Dembélé-hat-trick territory) clears
// 9.5; and a genuinely disastrous game (red card + costing your team a goal)
// lands close to 3.0. API-Football's raw stats/events feed has no standalone
// "defensive error leading to a goal" field (that's an Opta/WhoScored pundit
// tag, not exposed here) — own goals are the closest real, data-backed proxy
// and are penalized accordingly rather than fabricating an unavailable stat.
//
// stats is one entry of API-Football's /fixtures/players response
// (statistics[0] for that fixture): { games, goals, passes, tackles, duels,
// dribbles, fouls, cards, penalty, shots }. games.position is API-Football's
// own per-fixture position code ('G'/'D'/'M'/'F').
//
// cleanSheet/ownGoals are computed by the caller (poll.mjs) from data already
// in scope there: cleanSheet from the fixture's goals-against, ownGoals from
// the real fixtureEvents feed (detail matching /own/i) — never invented here.
export function computeRating(stats, { knockout = false, result = 'draw', cleanSheet = false, ownGoals = 0 } = {}) {
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
  const saves = stats.goals?.saved || 0;
  const yellow = stats.cards?.yellow || 0;
  const red = stats.cards?.red || 0;
  const position = stats.games?.position || '';
  const isKeeper = position === 'G';
  const isDefender = position === 'D';

  // Per-90 normalize the volume-based (non-discrete) signals so a 15-minute
  // cameo isn't punished/rewarded as hard as a full match — see pricing-model.md.
  const minuteScale = Math.min(1, minutes / 45);

  let rating = 6.0;
  // Nonlinear goal bonus: each goal is worth more than the last, so a
  // hat-trick alone (without even counting assists/result) clears 9.5.
  rating += 0.9 * goals;
  if (goals >= 2) rating += 0.3 * (goals - 1);
  if (goals >= 3) rating += 0.5;
  rating += 0.35 * assists;
  rating += minuteScale * (0.05 * tackles + 0.05 * interceptions + 0.03 * duelsWon
    + 0.04 * dribblesSuccess + 0.03 * keyPasses + 0.03 * shotsOn);

  // Goalkeeper saves and clean sheets for the back line — real, available
  // fields (goals.saved; goals-against == 0), not fabricated.
  if (isKeeper) rating += minuteScale * 0.18 * saves;
  if (cleanSheet && (isKeeper || isDefender)) rating += minuteScale * 0.5;

  rating -= 0.3 * yellow;
  rating -= 1.0 * red;
  rating -= 1.8 * ownGoals;

  // Stakes weighting: a knockout result swings rating a bit more than a
  // dead-rubber group game (pricing-model.md: "opponent + stakes weighting").
  const stakesMult = knockout ? 1.3 : 1.0;
  const resultBump = result === 'win' ? 0.15 : result === 'loss' ? -0.15 : 0;
  rating += resultBump * stakesMult;

  return Math.max(1.0, Math.min(9.9, Math.round(rating * 100) / 100));
}
