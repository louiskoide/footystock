#!/usr/bin/env node
// One-off, read-only: pre-launch sanity check that tables the app writes to
// but never documents a schema for (leaderboard, portfolios, comments,
// referrals) actually exist and hold real data — i.e. writes are truly
// landing, not just "the endpoint didn't 404." Mirrors the class of bug
// found in portfolios (bonus_cash schema mismatch, silently rejected every
// write) — this is a blind spot check for the other undocumented tables.
const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function check(table, query) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: HDR });
    const body = await resp.text();
    console.log(`${table}: HTTP ${resp.status}${resp.ok ? '' : ' <-- PROBLEM'}`);
    if (resp.ok) {
      const rows = JSON.parse(body);
      console.log(`  ${rows.length} row(s) returned. Sample:`, JSON.stringify(rows.slice(0, 2)));
    } else {
      console.log('  body:', body);
    }
  } catch (e) {
    console.log(`${table}: FETCH ERROR`, e.message);
  }
}

await check('leaderboard', 'select=token,name,updated_at&order=updated_at.desc&limit=3');
await check('portfolios', 'select=token,updated_at&order=updated_at.desc&limit=3');
await check('comments', 'select=id,player_id,username,body,created_at&order=created_at.desc&limit=3');
await check('referrals', 'select=id,referred_token,created_at&order=created_at.desc&limit=3');
await check('clubs', 'select=id,name,created_at&order=created_at.desc&limit=3');
await check('club_messages', 'select=id,type,created_at&order=created_at.desc&limit=3');
await check('shares', 'select=player_id,remaining,total&limit=3');
