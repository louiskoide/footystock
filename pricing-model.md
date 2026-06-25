# FootyStock — Pricing Model

This is the spec for how a player's price is determined. Read it before
changing any pricing, rating, form, or hype logic. The price is a deliberate
function of three real-world signals, not an ad-hoc number.

## Core idea: anchor + composite, in log space

A player's price has two parts, like a real stock: a slow **fundamental level**
and faster **movements** driven by news and performance.

- The **anchor** is the player's transfer market value (the `VAL()` table,
  €M, Transfermarkt-style). This is the long-run fundamental — it does *not*
  change much day to day.
- Three signals push the price *away* from that anchor:
  **performance**, **form**, and **hype**.

We combine them **multiplicatively** (i.e. additively in log space) so effects
compound proportionally and the price can never go negative:

```
// SLOW LOOP — once a day, fundamentals only.
// This is the fair-value FLOOR the intraday ticks orbit around.
log(fairValueBase) = log(marketValue)
                   + wPerf * perfScore     // real-life performance
                   + wForm * formScore     // recent trajectory

// FAST LOOP — every ~15–60 min, refresh hype + re-converge the price.
log(fairValue) = log(fairValueBase)
               + wHype * hypeScore(now)    // search / news / odds buzz, refreshed live

price = price + α * (fairValue − price) + noise   // chase the floor + wobble
```

### The mean-centering rule (critical)

Each of the three scores must be **mean-centered**: an average player scores 0
on all three and therefore trades *exactly* at market value. Above-average
output pushes the price up; a cold streak or a stale rumor pulls it down. If a
signal is never negative, it can only ever inflate prices — center it.

### Weights

Start with:

| Signal      | Weight | Why |
|-------------|--------|-----|
| performance | 0.50   | fundamentals should dominate |
| form        | 0.30   | recent trajectory matters but less than the body of work |
| hype        | 0.20   | spice, not the meal — never let one rumor dominate |

These are tunable. Keep `wHype` the smallest: high hype weight turns FootyStock
into a meme-stock generator where one tweet 5x's a player.

## Signal 1 — Performance (fundamental, slow)

Computed **from raw event data**, never from a third-party rating. This is the
biggest accuracy lever and where the old `(rating-6.9)*1.3 + g*1.0 + a*0.6`
delta was crudest. Three things it must do:

1. **Position-adjusted baselines.** A 7.0 means different things for a striker
   vs a holding midfielder, and a defender must not be punished for 0 goals.
   Reward output *relative to a position-expected baseline*, not raw counts.
2. **Opponent + stakes weighting.** A goal vs Brazil ≠ a goal vs a minnow, and
   a knockout ≠ a dead-rubber group game. We already store the opponent on each
   event — multiply each performance by an opponent-strength factor (FIFA/Elo)
   and a match-importance factor.
3. **Per-90 normalization.** An 8.0 in a 15-minute cameo ≠ an 8.0 over a full
   match. Weight by minutes played.

Inputs to use when available: goals, assists, xG, xA, shots, key passes,
minutes, result, opponent, competition stage. (On the free data path some of
these — xG/shots — won't be present; degrade to a coarser version, see
`data-sources.md`.)

Output: a per-match performance value, then aggregated and mean-centered into
`perfScore`.

## Signal 2 — Form (momentum, medium)

Form = "is this player outperforming *themselves* lately."

- Take an **exponentially-weighted moving average (EWMA)** of recent per-match
  performance values, decay λ ≈ 0.75 (last game weighted most, but not
  dominant). Use roughly the last 5–6 appearances.
- `formScore = recentEWMA − player's own baseline`. Positive = in form,
  negative = out of form. (Mean-centered by construction.)
- A **streak kicker** (consecutive high-rated games) is fine as a *small*
  nonlinear bonus on top — not the main term. The existing `streakLen` is a
  good basis for this.

## Signal 3 — Hype (sentiment, fast, mean-reverting)

Hype is a **basket**, deliberately not Twitter-only (X data is expensive and
ToS-grey — see `data-sources.md`). Combine:

- **Google Trends search interest** — the best free real-time buzz proxy.
- **News / transfer-rumor volume** (e.g. GDELT) — weighted by recency.
- **Betting odds movement** — if the data feed includes odds, a shift in a
  player's goalscorer or transfer line is a real-money crowd signal and often
  better than social.

Two hard rules for hype:

1. **It must decay.** Model each rumor/viral moment as an *impulse* with a
   short half-life. A rumor spikes hype, then fades unless it materializes.
   Without decay, prices ratchet upward forever on speculation.
2. **Keep it separate from performance.** Don't let on-pitch output leak into
   the hype channel (the old `transferSig` mixed `news.bias` with `change30d`,
   double-counting). Performance = realized output. Hype = speculation. Two
   different axes.

Optionally **cap** hype's contribution so buzz alone can't dwarf fundamentals.

## Traded-price dynamics (what makes it feel like a market)

Do **not** snap the price to `fairValue`. Let the *traded price* chase the
fundamental, which produces lag, overshoots, and interesting charts:

```
price(t+1) = price(t) + α * (fairValue − price(t)) + noise [+ supply/demand]
```

- `α` controls tracking speed. Smaller α = more lag, more drama.
- `noise` = small intraday wobble (the current `live` multiplier already does a
  mean-reverting version of this — reuse it).
- `supply/demand` = optional order-flow term once there are real traders.

**Event impulses:** a goal or a transfer break should inject an *instant* bump
into the relevant signal (performance or hype) that then decays. This is what
creates realistic "spike then settle" price action. The existing history-bump
logic in `buildDB()` is a primitive version of this.

### The intended price story

A player scores a knockout brace vs a strong side →
performance spikes → form turns positive → hype may follow if rumors swirl →
fairValue jumps → traded price climbs toward it over a few ticks → drifts back
down if the form doesn't continue. Every piece traces to something real.

## Mapping to the existing code

The `signals` object in `buildDB()` already has the right shape. The key change
is that **today the price level is essentially just `marketValue` + noise, and
the signals are cosmetic** (they feed the "what's driving the price" panel and
the sparkline, not the headline price). Wire the signals *into* fair value:

| Existing signal     | Repoint to |
|---------------------|------------|
| `fotmob`            | our computed rating from event data |
| `fantasy`           | fantasy points (from events, optional) |
| `form`              | EWMA of our computed ratings |
| `twitter` (→ buzz)  | Google Trends interest + news volume |
| `transfermarkt`     | odds movement + transfer-rumor feed (kept separate from perf) |

Then `price` becomes the `fairValue` formula above, and `curPrice()` /
the `live` multiplier handle the traded-price drift on top.

## Tuning checklist

- [ ] Each signal mean-centered (average player → 0 effect)?
- [ ] Performance position-adjusted, opponent/stakes/minutes weighted?
- [ ] Form is EWMA-of-recent minus own baseline (not just last game)?
- [ ] Hype decays and is independent of performance?
- [ ] `wHype` smallest; hype contribution capped?
- [ ] Traded price mean-reverts to fairValue rather than snapping?
- [ ] Validated offline on StatsBomb data before going live? (see data doc)
