#!/usr/bin/env node
// One-off, read-only diagnostic for the "daily reward re-prompts every
// reload despite claiming" report. Two theories to check against the real
// table, neither of which is visible from client-side code alone:
// 1. Duplicate rows per token — if `portfolios.token` isn't actually a
//    unique/primary key in the live schema, submitScore()/persist()'s
//    `Prefer: resolution=merge-duplicates` upsert can't merge on conflict
//    and may silently insert a new row instead of updating the existing
//    one. Supa.get('portfolios','token=eq.'+token) has no explicit
//    `order=`, so it'd return whichever row Postgres feels like first —
//    often the OLDEST (pre-claim) one — making every claim look like it
//    silently reverted on next load, even though it uses today's login and
//    even though cash/holdings look fine (that's just each individual read
//    happening to land on a "good enough" row).
// 2. last_claim just not landing — writes succeed but that specific column
//    is empty/null across the board (e.g. it never actually changes value).
//
// Usage: node scripts/debug-daily-reward.mjs [username]
// With a username, also looks up that specific account's leaderboard +
// portfolios rows (token, streak, last_claim, updated_at) to see exactly
// what's actually stored for them, rather than just aggregate stats.

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function getAll(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: HDR });
  if (!resp.ok) throw new Error(`${table} fetch failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function main() {
  const rows = await getAll('portfolios', 'select=token,streak,last_claim,updated_at,cash&order=updated_at.desc');
  console.log(`Total portfolios rows: ${rows.length}`);

  const byToken = new Map();
  for (const r of rows) {
    if (!byToken.has(r.token)) byToken.set(r.token, []);
    byToken.get(r.token).push(r);
  }
  const dupTokens = [...byToken.entries()].filter(([, v]) => v.length > 1);
  console.log(`Unique tokens: ${byToken.size}, tokens with >1 row: ${dupTokens.length}`);
  if (dupTokens.length) {
    console.log('\n--- DUPLICATE TOKENS (confirms missing unique constraint) ---');
    for (const [token, dupes] of dupTokens.slice(0, 10)) {
      console.log(token, JSON.stringify(dupes.map(d => ({ streak: d.streak, last_claim: d.last_claim, updated_at: d.updated_at }))));
    }
  }

  const withClaim = rows.filter(r => r.last_claim);
  const withoutClaim = rows.filter(r => !r.last_claim);
  console.log(`\nRows with last_claim set: ${withClaim.length}, without: ${withoutClaim.length}`);
  console.log('Sample rows with last_claim set (most recently updated):');
  console.log(JSON.stringify(withClaim.slice(0, 5).map(r => ({ token: r.token.slice(0, 8) + '…', streak: r.streak, last_claim: r.last_claim, updated_at: r.updated_at })), null, 2));

  // What Supa.get('portfolios','token=eq.'+token) (no explicit order) would
  // actually return for any token that has duplicates — this is the exact
  // query syncFromCloud() runs.
  if (dupTokens.length) {
    const [sampleToken] = dupTokens[0];
    const unordered = await getAll('portfolios', `token=eq.${encodeURIComponent(sampleToken)}&select=streak,last_claim,updated_at`);
    console.log(`\nWhat syncFromCloud()'s query (no order=) returns for a duplicated token, rows[0] would be used:`);
    console.log(JSON.stringify(unordered, null, 2));
  }

  const username = process.argv[2];
  if (username) {
    console.log(`\n--- Looking up "${username}" ---`);
    const lbRows = await getAll('leaderboard', `name=eq.${encodeURIComponent(username)}&select=token,name,holdings_public,updated_at,net_worth,trading_pnl`);
    if (!lbRows.length) { console.log('No leaderboard row found for that exact name.'); return; }
    console.log('leaderboard row:', JSON.stringify(lbRows, null, 2));
    for (const lb of lbRows) {
      const portRows = await getAll('portfolios', `token=eq.${encodeURIComponent(lb.token)}&select=token,streak,last_claim,updated_at,cash`);
      console.log(`portfolios row(s) for token ${lb.token}:`, JSON.stringify(portRows, null, 2));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
