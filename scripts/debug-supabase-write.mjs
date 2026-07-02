#!/usr/bin/env node
// One-off diagnostic: write a single test row to price_history and read it
// back in the same process, printing full response bodies/headers. Used to
// debug why scripts/backfill-price-history.mjs reports success but Supabase
// row counts don't change. Safe to delete once the mystery is solved.

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';

const testRow = { player_id: '__debug_write_test__', day_key: '2099-01-01', price: 123.45 };

async function main() {
  console.log('--- WRITE ---');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/price_history`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([testRow]),
  });
  console.log('status:', r.status, r.statusText);
  console.log('headers:', JSON.stringify(Object.fromEntries(r.headers.entries())));
  const body = await r.text();
  console.log('body:', body);

  console.log('\n--- READ BACK ---');
  const r2 = await fetch(
    `${SUPABASE_URL}/rest/v1/price_history?player_id=eq.__debug_write_test__`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  console.log('status:', r2.status, r2.statusText);
  const body2 = await r2.text();
  console.log('body:', body2);

  console.log('\n--- TABLE INFO (OPTIONS) ---');
  const r3 = await fetch(`${SUPABASE_URL}/rest/v1/price_history`, {
    method: 'GET',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'count=exact' },
  });
  console.log('content-range:', r3.headers.get('content-range'));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
