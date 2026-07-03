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
// This script re-sends the EXACT shape persist() sends, for one real
// account already confirmed to have a stale portfolios row, and prints the
// actual HTTP status + response body Supabase returns.
//
// Usage: node scripts/debug-portfolio-write.mjs <token>

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function main() {
  const token = process.argv[2];
  if (!token) { console.error('Usage: node scripts/debug-portfolio-write.mjs <token>'); process.exit(1); }

  // Fetch their real current row first so this test write doesn't clobber
  // real data with junk — reuse everything, only bump last_claim/updated_at.
  const getResp = await fetch(`${SUPABASE_URL}/rest/v1/portfolios?token=eq.${encodeURIComponent(token)}&select=*`, { headers: HDR });
  const rows = await getResp.json();
  console.log('current row:', JSON.stringify(rows));
  const cur = rows[0] || {};

  const payload = {
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
  console.log('\nSending exact _persistToCloud() payload shape (real data, only updated_at bumped)...');
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/portfolios`, {
    method: 'POST',
    headers: { ...HDR, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(payload),
  });
  const bodyText = await resp.text();
  console.log(`\nHTTP status: ${resp.status} ${resp.statusText}`);
  console.log('response body:', bodyText || '(empty)');
  console.log('resp.ok:', resp.ok, '<- this is exactly what _persistToCloud() never checks');
}

main().catch(e => { console.error(e); process.exit(1); });
