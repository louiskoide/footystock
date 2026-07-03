#!/usr/bin/env node
// One-off diagnostic for the "permission denied for table leaderboard"
// signup bug. Tries the exact signup INSERT with a few Prefer header
// variations directly against Supabase — bypassing the deployed frontend
// entirely — so we can tell whether return=minimal actually fixes it at the
// API level, independent of whatever the live site currently happens to be
// serving. Cleans up its own test rows at the end either way.
const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

const testTokens = [];

async function tryInsert(label, prefer) {
  const testToken = 'diag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  testTokens.push(testToken);
  const payload = {
    token: testToken,
    name: 'diag_test_' + testToken.slice(-6),
    password_hash: 'deadbeefdeadbeefdeadbeefdeadbeef',
    email: null,
    ref_code: testToken.replace(/\W/g, '').slice(0, 6).toUpperCase(),
    net_worth: 10000,
    updated_at: new Date().toISOString(),
  };
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/leaderboard`, {
    method: 'POST',
    headers: { ...HDR, Prefer: prefer },
    body: JSON.stringify(payload),
  });
  const body = await resp.text();
  console.log(`\n--- ${label} ---`);
  console.log('Prefer:', prefer);
  console.log('HTTP status:', resp.status, resp.ok ? '(OK)' : '(FAILED)');
  console.log('body:', body || '(empty)');
}

console.log('Testing 3 variants of the signup INSERT directly against Supabase...\n');
await tryInsert('1. Plain insert, return=minimal', 'return=minimal');
await tryInsert('2. Upsert (merge-duplicates), return=minimal  <-- this is the current deployed code', 'resolution=merge-duplicates,return=minimal');
await tryInsert('3. Upsert (merge-duplicates), return=representation  <-- the OLD pre-fix behavior, for comparison', 'resolution=merge-duplicates,return=representation');

console.log('\n\nCleaning up test rows...');
for (const t of testTokens) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/leaderboard?token=eq.${encodeURIComponent(t)}`, { method: 'DELETE', headers: HDR });
    console.log(`  deleted ${t}: ${r.status}`);
  } catch (e) {
    console.log(`  cleanup failed for ${t} (harmless, it's an obviously-fake diag_test_ row): ${e.message}`);
  }
}
