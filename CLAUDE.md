# FootyStock

A football ("soccer") **stock market game**: each player has a "stock price"
that moves with their real-life performances, recent form, and overall hype.
Entertainment only — **no real money is involved**.

## How it works (the mental model)

- **Always-on live worker**, not a daily snapshot. An always-on Fly.io worker
  (`scripts/live-worker/`) continuously polls API-Football — every 30s while a
  tracked World Cup match is live, every 5 min when idle — and serves the
  result as `prices.json`-shaped JSON over HTTP. We're on a **paid
  API-Football tier (7,500 req/day)**, which is what makes this live-polling
  model affordable; see `data-sources.md` for the budget math.
- **Hype** (GDELT news volume + tone) refreshes separately, every ~2h, with its
  own exponential backoff if GDELT starts throttling the worker — see
  `scripts/live-worker/hype.mjs`. (Replaced Google Trends, whose scraped
  endpoint IP-blocked the worker so hype was stuck at 0.)
- The static frontend polls the worker's `/prices.json` every 30s and merges
  it live. If the worker is unreachable, it degrades silently to the
  hand-typed `STARS`/`NEWS` fallback already baked into `DATA()`.
- **The worker only serves the JSON API, not the page.**
  `scripts/live-worker/server.mjs` has exactly three routes: `/health`,
  `/prices.json` (and `/`, same handler) returning `publicSnapshot(state)` as
  JSON, and a 404 fallback. It reads `FootyStock_dc.html` at boot purely to
  build the player crosswalk (`loadCrosswalk(HTML_PATH)`) — it never serves
  that file's markup to a browser. `footystock.fly.dev` is the live data
  source the frontend's `LIVE_WORKER_URL` fetches from, not a page host.
  `.github/workflows/deploy-worker.yml` redeploys this worker to Fly on every
  push to `main` touching `scripts/live-worker/`, `scripts/lib/`, `fly.toml`,
  or `Dockerfile`. **It deliberately does NOT trigger on `FootyStock_dc.html`**
  anymore — the worker's `state` (teams/players/fixture history) lives only
  in memory with zero persistence (`makeInitialState()` in `poll.mjs`), so a
  redeploy mid-tournament wipes everything accumulated so far and forces a
  cold re-fetch from API-Football. A frontend-only chart/styling tweak must
  never restart the live worker. (The crosswalk baked from `FootyStock_dc.html`
  into the Docker image does go stale until the next *worker-code* deploy —
  acceptable, since the roster rarely changes mid-tournament; trigger
  `workflow_dispatch` manually if it ever needs a forced refresh.)
- **The static frontend has no confirmed automatic deploy right now.**
  `.github/workflows/pages.yml` fails on every run (`Get Pages site failed` —
  GitHub Pages was never enabled in repo settings for `louiskoide/footystock`),
  so don't assume pushing to `main` makes `FootyStock_dc.html` show up
  anywhere publicly. Until Pages is enabled (or another static host is wired
  up), treat `FootyStock_dc.html` as opened directly/locally for testing.

## Architecture rules — do not violate

1. **Never call data APIs from the browser.** Keys would leak, CORS blocks it,
   and per-user requests blow the rate limits. *All* data fetching happens
   server-side, inside the live worker only.
2. **Prices are shared state** → every browser fetches the same live
   `prices.json` from the worker. Every user must see the same prices.
3. **Portfolios and trades are per-user** → keep them in `localStorage` for now.
   **Do not add a database** until cross-device portfolios or a real cross-user
   leaderboard actually require one (then: Supabase free tier).
4. **Compute our own player rating** from raw event data (goals, assists, xG,
   minutes, opponent, result). **Never scrape, store, or resell** FotMob /
   Opta / SofaScore-style ratings — that data is licensed and republishing it
   invites legal trouble. Our number is our own.
5. **Live polling is intentional now** — we pay for API-Football specifically
   to support in-play polling during matches. Don't revert to a once-daily
   batch job without an explicit reason; that was the old free-tier
   constraint, not a design preference.

## Where to look before changing things

- **Any pricing / rating / form / hype logic** → read `pricing-model.md`
  first. The price is a deliberate formula, not ad-hoc.
- **Anything touching data sources, APIs, or merging feeds** → read
  `data-sources.md` first. There are firm rules about IDs and precedence.

## Project layout

- `FootyStock_dc.html` — the app (template + `buildDB()` pricing logic).
- `support.js` — generated runtime; **do not hand-edit** (rebuild from source).
- `scripts/live-worker/` — the always-on Fly.io worker: polls API-Football +
  Google Trends and serves live `prices.json` over HTTP. This is the live
  data path; `scripts/update-prices.mjs` is the old free-tier daily-batch
  script, kept only as a manual fallback if the worker is ever down for a
  while.
- `fly.toml` / `Dockerfile` — Fly.io deploy config for the live worker.
- `pricing-model.md`, `data-sources.md` — the model and data specs (the "why"
  behind the code).
- `.github/workflows/deploy-worker.yml` — auto-deploys the worker to Fly.
- `.github/workflows/pages.yml` — auto-deploys the static frontend.

## Conventions

- Players are keyed by `slug(name + '-' + team)`. This slug is the **canonical
  ID** for the whole project — every external data feed must resolve to it.
- Market values live in the `VAL()` table (€M, Transfermarkt-style). These are
  the *anchor* for price, not the whole price (see the model doc).
- Keep changes minimal and reversible; prefer editing existing structures
  (`buildDB`, the `signals` object) over rewrites.

## Commands

- `npm run dev` — local preview (adjust if the project uses a different runner).
- `fly deploy --app footystock` — manual worker deploy (normally not needed;
  CI does this on push, see above). `fly logs --app footystock` to tail it.
- `fly secrets set API_FOOTBALL_KEY=... --app footystock` — set/rotate the key.

## Status / non-goals (for now)

- **No longer free-tier-only.** The project now pays for API-Football
  (7,500 req/day) specifically to support live in-play polling — see
  `data-sources.md`. Other infra (Fly.io worker, GitHub Actions, GitHub Pages)
  stays on free tiers. Don't add further paid infra without a flag in the
  task.
- No betting, no real currency, no payouts. Keep it clearly "for fun."
