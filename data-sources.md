# FootyStock — Data Sources & Merge

This is the spec for where data comes from and how feeds are combined. Read it
before touching anything that fetches, stores, or merges external data.
Everything here is built around staying **$0 until the game is popular**.

## The free stack (each source has one job)

No single free source does it all, so we layer complementary ones. Division of
labor:

| Source              | Role | Notes / free-tier reality |
|---------------------|------|---------------------------|
| **API-Football** (api-sports.io), free tier | Per-player events: goals, assists, cards, minutes | ~100 requests/day cap; player stats + events on free; commercial use allowed on free. The primary performance feed. |
| **football-data.org**, free | Skeleton: fixtures, schedules, final scores, lineups | Free forever, ~10 req/min, professional-grade. Thin on per-player stats on free (goals via scorers endpoint; assists/minutes/shots behind a paid add-on). Use as the reliable backbone + fallback. |
| **StatsBomb Open Data** (GitHub) | Offline model building/validation; xG depth | Free, rich event data incl. xG, but **static & historical, not live**. Attribution to StatsBomb required. Use to tune the rating before paying for anything. |
| **TheSportsDB**, free | Media layer: club badges, player photos | Crowd-sourced; image accuracy doesn't matter. Commercial use needs the ~$9/mo tier — fine while non-commercial. Do NOT trust it for performance stats. |
| **Google Trends** (`trendspyg` / `pytrends-modern`) | Hype: search interest | Free, ~real-time. Values are *relative* — include a stable anchor keyword in every pull to compare across players. Throttle / cache; it 429s under load. |
| **GDELT** | Hype: news / transfer-rumor volume + tone | Free. Weight by recency so rumors decay. |

### Deliberately NOT used

- **X / Twitter API** — pay-per-use, ~$0.005/read, 2M/mo cap, no real free
  tier. Third-party scrapers are cheaper but ToS-grey and fragile. Hype comes
  from Trends + news + odds instead.
- **FotMob / SofaScore ratings** — no clean official API, and the data is
  licensed (Opta/Stats Perform). We compute our **own** rating instead (see
  `pricing-model.md`). This is a hard rule, not a preference.

## Why 100 req/day is fine

We update **once a day**, not live. After matches finish, one batched pull
(by fixture/league, not per-player) covers a few dozen players inside the cap.
This matches the app's existing daily-snapshot behavior — it's automation, not
a downgrade. Live in-play is the one thing we deliberately skip until paid.

## Architecture ($0, almost no backend)

```
GitHub Action (daily cron)
  → pulls API-Football (+ football-data.org fallback, Trends, GDELT)
  → resolves every record to our canonical slug ID
  → computes each player's price (see pricing-model.md)
  → writes prices.json, commits it to the repo
Static frontend
  → fetches prices.json, renders the market
User portfolios/trades
  → stay in localStorage (per-user, no server needed yet)
```

- **GitHub Actions** runs the cron for free (generous free minutes; unlimited
  on public repos). A daily pull is seconds of compute.
- **No database yet.** Prices live in `prices.json`; portfolios in
  `localStorage`. Only add a DB (Supabase free tier) when cross-device
  portfolios or a real cross-user leaderboard require it. The daily Action
  doubles as the "keep-alive" that stops a free Supabase project from pausing.
- **Never fetch from the browser.** Keys, CORS, and rate limits all forbid it.

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
| search-interest hype | Google Trends |
| news/rumor hype | GDELT |

When two sources disagree on, say, assists, the **designated owner wins**. No
ambiguity, no blending.

### Rule 3 — Fallback waterfall

If API-Football's daily calls run out or it's down, fall back to
football-data.org's coarser goals/result data so prices still update that day,
just less precisely. **Graceful degradation beats a broken snapshot.**

## Build order — add sources lazily

Do **not** wire all six feeds together on day one. That's how these projects
stall. Sequence:

1. **API-Football free → compute prices → `prices.json` → static page.**
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
