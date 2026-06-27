// Shared by scripts/update-prices.mjs and scripts/live-worker/: derives the
// player/team/slug crosswalk straight from FootyStock_dc.html so it never
// drifts out of sync with the live roster. See CLAUDE.md: players are keyed
// by slug(name + '-' + team) — that slug is the canonical ID project-wide.
import { readFileSync } from 'fs';

export function slug(name) {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function normName(name) {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, '').trim();
}

// football-data.org / API-Football sometimes name a country differently than
// our DATA(). Map API name -> the nation key we use internally.
export const NATION_ALIASES = {
  'usa': 'USA', 'united states': 'USA',
  'ivory coast': 'Ivory Coast', "cote d'ivoire": 'Ivory Coast', 'côte d’ivoire': 'Ivory Coast',
  'dr congo': 'DR Congo', 'congo dr': 'DR Congo', 'congo democratic republic': 'DR Congo',
  'south korea': 'South Korea', 'korea republic': 'South Korea', 'korea south': 'South Korea',
  'cape verde': 'Cape Verde', 'cape verde islands': 'Cape Verde',
};

export function canonNation(apiName) {
  const n = normName(apiName);
  return NATION_ALIASES[n] || apiName;
}

// Pull ROSTER / NATION / EXCLUDED straight out of the app source.
export function loadCrosswalk(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');

  const rosterBlock = html.match(/ROSTER\(\)\{ return `([\s\S]*?)`; \}/);
  if (!rosterBlock) throw new Error('Could not find ROSTER() block in FootyStock_dc.html');
  // Format: Name|Team|Position|Age|Tier
  const rosterByName = {};
  const ageByName = {};
  const positionByName = {};
  for (const line of rosterBlock[1].trim().split('\n')) {
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const name = parts[0].replace(/ dummy$/, '');
    rosterByName[name] = parts[1]; // club team
    positionByName[name] = parts[2];
    ageByName[name] = +parts[3] || null;
  }

  const natBlock = html.match(/const nat=\{\};([\s\S]*?)this\._data=/);
  if (!natBlock) throw new Error('Could not find NATION add() calls in FootyStock_dc.html');
  const nationByName = {};
  const addRe = /add\('([^']+)','([^']+)'\)/g;
  let m;
  while ((m = addRe.exec(natBlock[1]))) {
    const [, country, names] = m;
    for (const n of names.split(',')) nationByName[n.trim()] = country;
  }

  // Every rostered player is a crosswalk candidate, not just the ones with a
  // hand-typed nation tag — the live worker (see live-worker/poll.mjs)
  // discovers nation/squad membership itself from API-Football's official
  // squad lists, so it needs the full roster to match against. `nation` here
  // is kept only as a legacy hint for scripts/update-prices.mjs (the old
  // daily job); the live worker ignores it.
  const players = [];
  for (const name of Object.keys(rosterByName)) {
    const team = rosterByName[name];
    players.push({ name, team, nation: nationByName[name] || null, id: slug(name + '-' + team),
      position: positionByName[name] || null, age: ageByName[name] });
  }
  return players;
}
