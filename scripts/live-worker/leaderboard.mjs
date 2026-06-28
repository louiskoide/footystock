// Supabase-backed leaderboard — persists across worker redeploys and
// syncs globally across all devices. The anon key is intentionally
// public (Supabase's security model uses RLS policies, not key secrecy).

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';
const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
};

export async function submitScore(token, name, netWorth) {
  const n = String(name).trim().slice(0, 32) || 'Anonymous';
  const nw = Math.max(0, Math.min(10_000_000, Math.round(Number(netWorth) || 10000)));
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/leaderboard`, {
      method: 'POST',
      headers: { ...HEADERS, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ token: String(token).slice(0, 64), name: n, net_worth: nw, updated_at: new Date().toISOString() }),
    });
  } catch (e) { /* degrade silently — trade still executes locally */ }
}

export async function getLeaderboard() {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/leaderboard?order=net_worth.desc&limit=100`, { headers: HEADERS });
    if (!resp.ok) return [];
    const rows = await resp.json();
    return rows.map(r => ({ name: r.name, netWorth: r.net_worth }));
  } catch (e) { return []; }
}
