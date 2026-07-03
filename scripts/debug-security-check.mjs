#!/usr/bin/env node
// One-off, read-only pre-launch security check: with only the public
// anon/publishable key (the same one shipped client-side in
// FootyStock_dc.html), can an anonymous caller read other users'
// password_hash directly from the leaderboard table? If RLS is disabled
// (matching every other documented table in this file) and no column
// restriction exists, this is a real pre-launch issue: password_hash
// uses client-side SHA-256 salted with just the lowercased username (see
// _hashPw), which is crackable offline at scale if it leaks — and many
// users reuse passwords across sites.
const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

const resp = await fetch(`${SUPABASE_URL}/rest/v1/leaderboard?select=name,password_hash,email&limit=5`, { headers: HDR });
console.log('Direct password_hash read attempt:');
console.log('HTTP status:', resp.status);
const body = await resp.text();
console.log('body:', body);

// If the revoke above still isn't taking effect, it's almost certainly the
// classic Postgres gotcha: a table-wide `grant select on table leaderboard
// to anon` (from the original setup) can't be narrowed by a column-level
// REVOKE — Postgres can't "subtract" a column from a whole-table grant, so
// the REVOKE silently does nothing even though it reports success. The real
// fix is: revoke the whole-table SELECT, then re-grant SELECT on the exact
// safe column list. Print the full column list (currently still exposed)
// so that list can be built without guessing.
console.log('\nFull column list currently exposed via select=* (to build the safe re-grant list):');
const colResp = await fetch(`${SUPABASE_URL}/rest/v1/leaderboard?select=*&limit=1`, { headers: HDR });
console.log('HTTP status:', colResp.status);
const colBody = await colResp.json().catch(() => null);
console.log('columns:', colBody && colBody[0] ? Object.keys(colBody[0]).join(', ') : JSON.stringify(colBody));

// Confirms the verify_password/verify_password_by_token RPC migration was
// actually run in Supabase (FootyStock_dc.html's doVerifyOtp()/doResetPw()
// depend on these existing — without them, login and password-change are
// broken in production). A garbage name/hash should return HTTP 200 with an
// empty array if the function exists, vs. a 404 "function not found" /
// PGRST202 error if the SQL migration was never applied.
console.log('\nverify_password RPC existence check (garbage credentials, should be empty array not a 404):');
const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_password`, {
  method: 'POST',
  headers: { ...HDR, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_name: '__nonexistent_probe_account__', p_hash: 'deadbeef' }),
});
console.log('HTTP status:', rpcResp.status);
console.log('body:', await rpcResp.text());

console.log('\nverify_password_by_token RPC existence check (garbage token, should be empty array not a 404):');
const rpcResp2 = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_password_by_token`, {
  method: 'POST',
  headers: { ...HDR, 'Content-Type': 'application/json' },
  body: JSON.stringify({ p_token: '__nonexistent_probe_token__', p_hash: 'deadbeef' }),
});
console.log('HTTP status:', rpcResp2.status);
console.log('body:', await rpcResp2.text());
