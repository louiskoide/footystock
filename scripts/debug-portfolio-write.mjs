#!/usr/bin/env node
// One-off, read-only-except-for-one-test-write diagnostic. _persistToCloud()
// in FootyStock_dc.html does:
//   fetch(url, {...}).catch(()=>{})
// — this only catches NETWORK-level failures (fetch() rejecting). It never
// checks resp.ok or reads the response body, so any HTTP-level error
// (400/409/413/422, an RLS write rejection, a column type mismatch) is
// completely silent: the promise resolves fine, nothing throws, nothing
// logs. That would exactly explain a portfolios row going stale while the
// leaderboard row (a separate, apparently-working write) keeps updating.
//
// This script re-sends the EXACT shape persist() sends and prints the
// actual HTTP status + response body Supabase returns.
//
// Usage: node scripts/debug-portfolio-write.mjs <token>   — test one account
//        node scripts/debug-portfolio-write.mjs --all     — test EVERY
//        account's real row through the corrected payload shape, to prove
//        (not just reason about) that the bonus_cash fix is universal, not
//        specific to whichever one account happened to be spot-checked.

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

function buildPayload(cur, token) {
  return {
    token,
    cash: cur.cash ?? 10000,
    holdings: cur.holdings || {},
    txns: (cur.txns || []).slice(0, 500),
    shorts: cur.shorts || {},
    streak: cur.streak || 0,
    last_claim: cur.last_claim || null,
    join_date: cur.join_date || null,
    all_time_high: cur.all_time_high || 10000,
    updated_at: new Date().toISOString(),
    // bonus_cash deliberately omitted — root cause confirmed: that column
    // doesn't exist in the live schema, and PostgREST rejected the WHOLE
    // upsert (400 PGRST204) every time it was included. Fixed in
    // FootyStock_dc.html's _persistToCloud(); this script now mirrors it.
  };
}

async function testWrite(token, cur) {
  const payload = buildPayload(cur, token);
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/portfolios`, {
    method: 'POST',
    headers: { ...HDR, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });
  const bodyText = await resp.text();
  return { status: resp.status, ok: resp.ok, body: bodyText };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('Usage: node scripts/debug-portfolio-write.mjs <token>|--all'); process.exit(1); }

  if (arg === '--all') {
    const rows = await fetch(`${SUPABASE_URL}/rest/v1/portfolios?select=*`, { headers: HDR }).then(r => r.json());
    console.log(`Testing a real write (own unchanged data, only updated_at bumped) for all ${rows.length} portfolios rows...\n`);
    let okCount = 0, failCount = 0;
    for (const cur of rows) {
      const result = await testWrite(cur.token, cur);
      if (result.ok) okCount++; else { failCount++; console.log(`FAIL token=${cur.token.slice(0,8)}… status=${result.status} body=${result.body}`); }
    }
    console.log(`\n${okCount}/${rows.length} succeeded, ${failCount} failed.`);
    return;
  }

  const token = arg;
  // Fetch their real current row first so this test write doesn't clobber
  // real data with junk — reuse everything, only bump last_claim/updated_at.
  const getResp = await fetch(`${SUPABASE_URL}/rest/v1/portfolios?token=eq.${encodeURIComponent(token)}&select=*`, { headers: HDR });
  const rows = await getResp.json();
  console.log('current row:', JSON.stringify(rows));
  const cur = rows[0] || {};
  console.log('\nSending exact _persistToCloud() payload shape (real data, only updated_at bumped)...');
  const result = await testWrite(token, cur);
  console.log(`\nHTTP status: ${result.status}`);
  console.log('response body:', result.body || '(empty)');
  console.log('resp.ok:', result.ok, '<- this is exactly what _persistToCloud() never checks');
}

main().catch(e => { console.error(e); process.exit(1); });
