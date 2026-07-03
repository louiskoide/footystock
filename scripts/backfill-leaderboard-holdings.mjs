#!/usr/bin/env node
// One-off: regenerate every leaderboard row's top_holdings (now with avg
// cost basis + side:'long'/'short', see submitScore() in FootyStock_dc.html)
// from that user's real portfolios row, so public profiles show real P/L
// and hatewatch positions immediately — instead of waiting for each user's
// own browser to call submitScore() again now that the format changed,
// which could take a long time (or never happen) for inactive accounts.
//
// Read-only against portfolios; writes only leaderboard.top_holdings (and
// updated_at) — never touches cash/holdings/shorts/net_worth/trading_pnl.
// Respects each user's current holdings_public setting.
//
// Usage: node scripts/backfill-leaderboard-holdings.mjs [--dry-run]

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const DRY_RUN = process.argv.includes('--dry-run');

const HDR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function getAll(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: HDR });
  if (!resp.ok) throw new Error(`${table} fetch failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// Mirrors submitScore()'s topLong/topShort construction exactly.
function topN(obj, side) {
  return Object.entries(obj || {})
    .sort((a, b) => (b[1].qty || 0) - (a[1].qty || 0))
    .slice(0, 10)
    .map(([id, h]) => ({ id, qty: h.qty || 0, avg: h.avg || 0, side }));
}

async function main() {
  const [portfolios, leaderboard] = await Promise.all([
    getAll('portfolios', 'select=token,holdings,shorts'),
    getAll('leaderboard', 'select=token,name,holdings_public'),
  ]);
  const portByToken = new Map(portfolios.map(p => [p.token, p]));
  console.log(`Portfolios: ${portfolios.length}, leaderboard rows: ${leaderboard.length}`);

  let updated = 0, skippedPrivate = 0, skippedNoPortfolio = 0, failed = 0;
  for (const row of leaderboard) {
    const port = portByToken.get(row.token);
    if (!port) { skippedNoPortfolio++; continue; }
    const isPrivate = row.holdings_public === false;
    if (isPrivate) skippedPrivate++;
    const topHoldings = isPrivate ? [] : [...topN(port.holdings, 'long'), ...topN(port.shorts, 'short')];
    if (DRY_RUN) { updated++; continue; }
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/leaderboard?token=eq.${encodeURIComponent(row.token)}`, {
      method: 'PATCH',
      headers: { ...HDR, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ top_holdings: topHoldings, updated_at: new Date().toISOString() }),
    });
    if (!resp.ok) { console.error(`PATCH failed for ${row.name}: ${resp.status} ${await resp.text()}`); failed++; continue; }
    updated++;
  }
  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${updated}/${leaderboard.length} rows (private: ${skippedPrivate}, no portfolio: ${skippedNoPortfolio}, failed: ${failed}).`);
}

main().catch(e => { console.error(e); process.exit(1); });
