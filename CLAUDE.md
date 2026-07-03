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
- **The worker only serves JSON APIs, not the page.**
  `scripts/live-worker/server.mjs` serves `/health`, `/prices.json` (and `/`,
  same handler, returning `publicSnapshot(state)`), plus routes backing the
  Supabase-based features (Architecture rule 3): `/trade`, `/shares.json`,
  `/price-closes`, `/leaderboard` (GET+POST). It also has three `/debug/*`
  diagnostics and `/admin/repair-stale-events` (POST) — these four are gated
  behind an `ADMIN_SECRET` header and return 403 until that secret is set via
  `fly secrets set ADMIN_SECRET=... --app footystock`, since they can trigger
  extra API-Football calls or expose internal matching state. It reads
  `FootyStock_dc.html` at boot purely to build the player crosswalk
  (`loadCrosswalk(HTML_PATH)`) — it never serves that file's markup to a
  browser. `footystock.fly.dev` is the live data source the frontend's
  `LIVE_WORKER_URL` fetches from, not a page host.
  `.github/workflows/deploy-worker.yml` redeploys this worker to Fly on every
  push to `main` touching `scripts/live-worker/`, `scripts/lib/`, `fly.toml`,
  or `Dockerfile`. **It deliberately does NOT trigger on `FootyStock_dc.html`**
  anymore. The worker's `state` (teams/players/fixture history) is persisted
  to a mounted Fly volume (`footystock_data` at `/data/state-cache.json`,
  see `saveState`/`loadState` in `server.mjs`) and reloaded on boot, so an
  **ordinary redeploy does NOT wipe accumulated data or force a cold
  re-fetch** — verified 2026-07-02: a redeploy loaded "cached state v5 (age:
  2m, players: 379)" instead of starting from zero. Data is only cleared
  deliberately, by bumping `STATE_VERSION` in `server.mjs` for a schema
  migration (e.g. a matching-logic or rating-formula fix that needs a clean
  rebuild) — see the comment above `STATE_VERSION` for what that preserves
  vs. wipes. A frontend-only chart/styling tweak still shouldn't restart the
  live worker (no reason to, and it does cost a brief re-squad-discovery +
  whatever fixtures/grace-polls the STATE_VERSION migration wiped), but an
  ordinary worker-code redeploy on an unchanged STATE_VERSION is safe and
  keeps all prior polling progress. (The crosswalk baked from
  `FootyStock_dc.html` into the Docker image does go stale until the next
  *worker-code* deploy — acceptable, since the roster rarely changes
  mid-tournament; trigger `workflow_dispatch` manually if it ever needs a
  forced refresh.)
- **The static frontend has no confirmed automatic deploy right now.**
  `.github/workflows/pages.yml` was removed after failing on all 371 of its
  runs (`Get Pages site failed` — GitHub Pages was never enabled in repo
  settings for `louiskoide/footystock`). `vercel.json` exists in the repo and
  the "Deployment discipline" section below manages a Vercel 100-deploys/day
  limit as if Vercel is the real, active host — but nothing in this repo
  confirms that connection is actually live. Don't assume pushing to `main`
  publishes `FootyStock_dc.html` anywhere until that's verified; treat it as
  opened directly/locally for testing until then.

## Architecture rules — do not violate

1. **Never call third-party data APIs from the browser.** Keys would leak,
   CORS blocks it, and per-user requests blow the rate limits. *All*
   API-Football/GDELT/TheSportsDB fetching happens server-side, inside the
   live worker only. Supabase is the one deliberate exception (rule 3) — its
   anon key is meant to be public, which is why the RLS/RPC discipline below
   matters.
2. **Prices are shared state** → every browser fetches the same live
   `prices.json` from the worker. Every user must see the same prices.
3. **A Supabase Postgres backend is live and in real use** — not a future
   maybe. `leaderboard`, `portfolios`, `comments`, `clubs`, `competitions`,
   `referrals`, `shares`, and `price_history` tables hold real accounts
   (username, salted password hash, optional email/phone) and cross-device
   portfolio/leaderboard data, fetched directly from the browser with the
   public anon key baked into `FootyStock_dc.html`. RLS is disabled
   network-wide, so **any column granted `SELECT`/`INSERT`/`UPDATE` to
   `anon` is world-readable/-writable — there is no per-row ownership
   check.** The pattern this codebase relies on instead: keep genuinely
   sensitive columns (`password_hash`; as of the 2026-07 fix, also `token`,
   `email`, `phone` on `leaderboard`, and `referrer_token`/`referred_token`
   on `referrals`) out of the public grant entirely, and put anything that
   needs a real check (password match, "does this token really belong to
   this account", referral not-already-claimed) behind a `SECURITY DEFINER`
   RPC that does the check server-side and returns only the minimal safe
   result — see `verify_password`, `verify_password_by_token`,
   `get_my_account`, `lookup_reset_token`, `credit_referral` in the SQL
   comment block near `SUPABASE_URL` in `FootyStock_dc.html`. Extend this
   same pattern for any new field or table that shouldn't be bulk-readable
   or bulk-writable by anyone holding the anon key — don't add a raw table
   grant as a shortcut.
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
  GDELT (news-tone hype) and serves live `prices.json` over HTTP, plus the
  Supabase-backed trade/leaderboard/referral routes (Architecture rule 3).
  This is the live data path; `scripts/update-prices.mjs` is the old
  free-tier daily-batch script, kept only as a manual fallback if the worker
  is ever down for a while.
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

## Deployment discipline — IMPORTANT

Vercel (the static frontend host) has a **100 deployments/day** limit on the
free plan. With multiple Claude sessions each pushing after every small change,
this limit can be exhausted in under 2 hours.

**Rule: batch all commits, push once at the end of a session.**

- Make as many local commits as needed during a session.
- Only `git push origin main` **once**, as the very last step, after all
  changes for the session are committed.
- Never push after every individual fix or commit — stage and commit locally,
  but hold the push until the session is done.
- Exception: worker-only changes (`scripts/live-worker/`, `scripts/lib/`,
  `fly.toml`, `Dockerfile`) that need CI to redeploy Fly.io can be pushed
  earlier since they don't count toward the Vercel limit meaningfully, but
  even then batch where possible.

## Status / non-goals (for now)

- **No longer free-tier-only.** The project now pays for API-Football
  (7,500 req/day) specifically to support live in-play polling — see
  `data-sources.md`. Other infra (Fly.io worker, GitHub Actions, Supabase)
  stays on free tiers. `pages.yml` was removed — it failed on all 371 of its
  runs; GitHub Pages was never enabled for this repo. Don't add further paid
  infra without a flag in the task.
- No betting, no real currency, no payouts. Keep it clearly "for fun."
