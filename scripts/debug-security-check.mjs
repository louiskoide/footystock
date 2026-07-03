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
console.log('HTTP status:', resp.status);
const body = await resp.text();
console.log('body:', body);
