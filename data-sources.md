# FootyStock — Data Sources & Merge

This is the spec for where data comes from and how feeds are combined. Read it
before touching anything that fetches, stores, or merges external data.

**Update (live era):** we now pay for an API-Football tier with a 7,500
req/day cap, specifically to support live in-play polling instead of a
once-daily batch (see "Why live polling fits the budget" below). Everything
else — GDELT, TheSportsDB, the Supabase backend (see CLAUDE.md Architecture
rule 3) — stays on free tiers; this project is not trying to spend money
broadly, just on the one feed that buys live updates.

## The stack (each source has one job)

No single source does it all, so we layer complementary ones. Division of
labor:

| Source              | Role | Notes |
|---------------------|------|---------------------------|
| **API-Football** (api-sports.io), paid tier (7,500 req/day) | Per-player events: goals, assists, cards, minutes — polled live during matches | The primary performance feed; polled every 30s while a tracked match is in play, every 5 min when idle (`scripts/live-worker/`). |
| **football-data.org**, free | Skeleton: fixtures, schedules, final scores, lineups | Free forever, ~10 req/min, professional-grade. Thin on per-player stats on free (goals via scorers endpoint; assists/minutes/shots behind a paid add-on). Use as the reliable backbone + fallback. |
| **StatsBomb Open Data** (GitHub) | Offline model building/validation; xG depth | Free, rich event data incl. xG, but **static & historical, not live**. Attribution to StatsBomb required. Use to tune the rating before paying for anything. |
| **TheSportsDB**, free | Media layer: club badges, player photos | Crowd-sourced; image accuracy doesn't matter. Commercial use needs the ~$9/mo tier — fine while non-commercial. Do NOT trust it for performance stats. |
| ~~**Google Trends**~~ | ~~Hype: search interest~~ | **Dropped.** The unofficial scraped endpoint IP-blocked the always-on Fly worker (HTML challenge instead of JSON), so hype sat at the cold-start 0 for everyone. Replaced by GDELT below. |
| **GDELT** (DOC 2.0 ToneChart) | **Hype (live):** news volume + automated tone | Free, no key. Per player: article volume (buzz) + count-weighted tone (praise vs criticism), combined and mean-centered across the pool; decay is the sliding window. The implemented hype signal — see `scripts/live-worker/hype.mjs`. Tone is GDELT's lexicon score, not a licensed rating. |

### Deliberately NOT used

- **X / Twitter API** — pay-per-use, ~$0.005/read, 2M/mo cap, no real free
  tier. Third-party scrapers are cheaper but ToS-grey and fragile. Hype comes
  from Trends + news + odds instead.
- **FotMob / SofaScore ratings** — no clean official API, and the data is
  licensed (Opta/Stats Perform). We compute our **own** rating instead (see
  `pricing-model.md`). This is a hard rule, not a preference.

## Why live polling fits the budget

With a 7,500 req/day cap, polling every tracked World Cup fixture every 30s
while it's live, plus a 5-min idle heartbeat, comfortably fits inside the cap
for the tournament's match volume — see `scripts/live-worker/server.mjs` for
the exact poll intervals. This replaced the old free-tier ~100 req/day plan,
which could only afford one batched pull per day after matches finished.

## Architecture (always-on worker, not a daily batch)

```
Fly.io worker (always-on, scripts/live-worker/)
  → polls API-Football continuously (live-match-aware interval)
  → resolves every record to our canonical slug ID
  → computes each player's price (see pricing-model.md)
  → serves prices.json-shaped JSON over HTTP (no commit/repo write)
Static frontend (deploy target TBC — see CLAUDE.md)
  → polls the worker's /prices.json every 30s, merges it live
  → falls back silently to the hand-typed STARS/NEWS snapshot if unreachable
Accounts, portfolios, leaderboard, clubs, referrals
  → Supabase Postgres, fetched directly from the browser with the public
    anon key (see CLAUDE.md Architecture rule 3 for the RLS-is-off /
    SECURITY DEFINER RPC pattern this relies on)
```

The worker (`deploy-worker.yml`) auto-deploys on push to `main` — no manual
`fly deploy` step needed. The frontend's `pages.yml` was removed after failing
on all 371 of its runs (GitHub Pages was never enabled for this repo) —
confirm what actually serves `FootyStock_dc.html` in production before
assuming a push to `main` publishes it.

- **A Supabase backend is live**, not a future maybe — see CLAUDE.md
  Architecture rule 3 for what's stored there and the access-control pattern
  in use. Prices themselves are still served live by the worker, never
  committed to the repo.
- **Never fetch the data-source APIs above from the browser** (API-Football,
  GDELT, TheSportsDB) — keys, CORS, and rate limits all forbid it. Supabase
  is the one deliberate exception: its anon key is meant to be public, which
  is exactly why the RLS/RPC discipline in CLAUDE.md matters.

## The merge layer (the genuinely fiddly part)

Combining APIs costs **the join**, not money. Every source has its own player
IDs, name spellings, and date formats. "Kylian Mbappé" is `K. Mbappe` in one
feed and a different numeric ID in each. API-Football IDs in particular can
behave as if scoped to team/competition/season — test joins, expect duplicates.

### Rule 1 — Canonical ID

`slug(name + '-' + team)` is the **single source of truth** for player identity
(the app already uses this). Every feed must resolve to a slug *before* its data
is used. Maintain a crosswalk next to each player:

```
slug → { footballDataId, apiFootballId, statsbombId, sportsdbId }
```

The crosswalk is the thing that breaks on transfers, new call-ups, and accented
names — keep it in code/config, review it when squads change.

### Rule 2 — One source of truth *per field*, not per player

Never average conflicting feeds. Assign each field an owner:

| Field | Owner |
|-------|-------|
| fixtures, scores, lineups | football-data.org |
| player events (goals/assists/minutes/cards) | API-Football |
| xG / advanced metrics | StatsBomb (where covered) |
| images (badges/photos) | TheSportsDB |
| news-tone hype | GDELT (DOC 2.0 ToneChart) |

When two sources disagree on, say, assists, the **designated owner wins**. No
ambiguity, no blending.

### Rule 3 — Fallback waterfall

If API-Football's daily calls run out or it's down, fall back to
football-data.org's coarser goals/result data so prices still update that day,
just less precisely. **Graceful degradation beats a broken snapshot.**

## Build order — add sources lazily

Do **not** wire all six feeds together on day one. That's how these projects
stall. Sequence:

1. **API-Football → compute prices → live `prices.json` → static page.**
   Get the whole pipeline working end-to-end with one source.
2. Add **TheSportsDB** (images) — zero stat-join risk, instant polish.
3. Add **Google Trends + GDELT** (hype basket).
4. Add **StatsBomb** offline to sharpen the rating.
5. Add **football-data.org** as the fallback/backbone.

The crosswalk grows one source at a time instead of being a big upfront tax.

## Licensing notes (revisit if/when monetized)

- "Free for commercial use" differs per source: API-Football allows it on free;
  TheSportsDB needs its paid tier; football-data.org restricts commercial on
  free.
- Never store or republish licensed third-party *ratings*. Our rating is
  derived from raw events and is our own — that's the legally clean path.
- While FootyStock is genuinely no-money / entertainment, this is fine. If it
  ever monetizes, audit the per-source terms before launch.
