// Thin client for api-sports.io's API-Football v3. Server-side only — never
// called from the browser (see CLAUDE.md rule 1). The paid tier's rate limit
// is generous (per-minute, not per-day) but we still serialize requests with
// a small gap to be a good citizen.
const BASE = 'https://v3.football.api-sports.io';
const MIN_REQUEST_GAP_MS = 350;

let lastRequestAt = 0;

export function makeClient(apiKey) {
  async function apiGet(path) {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastRequestAt = Date.now();

    const res = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': apiKey } });
    const body = await res.json();
    if (!res.ok) throw new Error(`API-Football HTTP ${res.status} for ${path}: ${JSON.stringify(body).slice(0, 300)}`);
    if (body.errors && Object.keys(body.errors).length) {
      throw new Error(`API-Football errors for ${path}: ${JSON.stringify(body.errors)}`);
    }
    return body.response;
  }

  return {
    fixtures: (params) => apiGet(`/fixtures?${new URLSearchParams(params)}`),
    fixtureStatistics: (fixtureId) => apiGet(`/fixtures/statistics?fixture=${fixtureId}`),
    fixturePlayers: (fixtureId) => apiGet(`/fixtures/players?fixture=${fixtureId}`),
    fixtureEvents: (fixtureId) => apiGet(`/fixtures/events?fixture=${fixtureId}`),
    playersSquad: (teamId) => apiGet(`/players/squads?team=${teamId}`),
  };
}
