/**
 * One-time script: backfill Supabase price_history with estimated past closes.
 *
 * For each player it runs the SAME synthetic 90-day history already computed
 * in buildDB() — Brownian bridge trend, match-event bumps, knockout dips —
 * then upserts every day BEFORE today (days 0..88 of the 90-point array,
 * where index 89 = today). Today's close is left for the live app to write.
 *
 * Only inserts rows that don't already exist (merge-duplicates / upsert).
 * Safe to run multiple times.
 *
 * Usage:  node scripts/backfill-price-history.mjs
 */

const SUPABASE_URL = 'https://pwlszzrvwhflijbjwnnf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1je-5UnGZ7cVl5iafQfICg_RtGpMTA_';

// ── helpers mirrored from FootyStock_dc.html ───────────────────────────────

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = Math.imul(31, h) + str.charCodeAt(i) | 0; }
  return h >>> 0;
}
function mulberry(seed) {
  return function () {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function slug(str) {
  return str.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ── player data (mirrored from FootyStock_dc.html) ─────────────────────────

const ROSTER_RAW = `
Erling Haaland|Man City|ST|25|1
Phil Foden|Man City|AM|25|2
Rodri|Man City|CM|30|2
Savinho|Man City|RW|22|3
Rúben Dias|Man City|CB|27|2
Ederson|Man City|GK|30|3
Kevin De Bruyne|Napoli|AM|34|2
Bernardo Silva|Man City|CM|30|2
Jack Grealish|Man City|LW|29|3
Jeremy Doku|Man City|RW|23|3
Matheus Nunes|Man City|CM|26|3
Erling Haaland dummy 2|Man City|ST|25|1
Kylian Mbappé|Real Madrid|ST|27|1
Vinícius Júnior|Real Madrid|LW|25|1
Jude Bellingham|Real Madrid|AM|22|1
Federico Valverde|Real Madrid|CM|26|2
Luka Modrić|Real Madrid|CM|39|2
Antonio Rüdiger|Real Madrid|CB|32|2
Dani Carvajal|Real Madrid|RB|33|2
Thibaut Courtois|Real Madrid|GK|32|2
Éder Militão|Real Madrid|CB|27|2
Rodrygo|Real Madrid|RW|24|2
Lucas Vázquez|Real Madrid|RB|33|3
Aurélien Tchouaméni|Real Madrid|CM|25|2
Brahim Díaz|Real Madrid|AM|25|3
Erling Haaland dummy 3|Real Madrid|ST|25|1
Lionel Messi|Inter Miami|AM|38|1
Luis Suárez|Inter Miami|ST|38|3
Sergio Busquets|Inter Miami|CM|36|3
Erling Haaland dummy 4|Inter Miami|ST|25|1
Mohamed Salah|Liverpool|RW|33|1
Virgil van Dijk|Liverpool|CB|34|1
Trent Alexander-Arnold|Liverpool|RB|26|1
Andrew Robertson|Liverpool|LB|31|2
Alisson|Liverpool|GK|32|2
Florian Wirtz|Liverpool|AM|22|1
Dominik Szoboszlai|Liverpool|CM|24|2
Cody Gakpo|Liverpool|LW|26|2
Darwin Núñez|Liverpool|ST|25|2
Ibrahima Konaté|Liverpool|CB|26|2
Luis Díaz|Bayern|LW|28|2
Harry Kane|Bayern|ST|31|1
Jamal Musiala|Bayern|AM|22|1
Serge Gnabry|Bayern|RW|29|2
Leroy Sané|Bayern|RW|29|2
Joshua Kimmich|Bayern|CM|29|2
Manuel Neuer|Bayern|GK|39|2
Dayot Upamecano|Bayern|CB|26|2
Alphonso Davies|Bayern|LB|24|2
Kingsley Coman|Bayern|RW|28|3
Min-Jae Kim|Bayern|CB|28|2
Thomas Müller|Bayern|AM|35|3
Erling Haaland dummy 5|Bayern|ST|25|1
Robert Lewandowski|Barcelona|ST|36|1
Lamine Yamal|Barcelona|RW|18|1
Marcus Rashford|Barcelona|LW|27|2
Pedri|Barcelona|CM|23|1
Gavi|Barcelona|CM|20|2
Raphinha|Barcelona|RW|28|2
Frenkie de Jong|Barcelona|CM|27|2
Marc-André ter Stegen|Barcelona|GK|33|2
Jules Koundé|Barcelona|RB|26|2
Ronald Araújo|Barcelona|CB|25|2
Ferrán Torres|Barcelona|RW|25|3
Erling Haaland dummy 6|Barcelona|ST|25|1
Bukayo Saka|Arsenal|RW|23|1
Martin Ødegaard|Arsenal|AM|26|1
Kai Havertz|Arsenal|AM|25|2
William Saliba|Arsenal|CB|24|2
Ben White|Arsenal|RB|27|2
Leandro Trossard|Arsenal|LW|30|3
Gabriel Magalhães|Arsenal|CB|27|2
Declan Rice|Arsenal|CM|26|1
David Raya|Arsenal|GK|29|2
Oleksandr Zinchenko|Arsenal|LB|27|3
Erling Haaland dummy 7|Arsenal|ST|25|1
Kylian Mbappé dummy 2|PSG|ST|27|1
Ousmane Dembélé|Paris SG|RW|27|2
Marquinhos|Paris SG|CB|30|2
Achraf Hakimi|Paris SG|RB|26|2
Gianluigi Donnarumma|Paris SG|GK|26|2
Vitinha|Paris SG|CM|24|2
Michael Olise|Bayern|RW|23|2
Erling Haaland dummy 8|Paris SG|ST|25|1
Bruno Fernandes|Man Utd|AM|30|2
Marcus Rashford dummy 2|Man Utd|LW|27|2
Rasmus Højlund|Man Utd|ST|22|3
Lisandro Martínez|Man Utd|CB|27|2
André Onana|Man Utd|GK|28|2
Matheus Cunha|Man Utd|ST|26|3
Erling Haaland dummy 9|Man Utd|ST|25|1
Son Heung-min|Spurs|LW|32|2
James Maddison|Spurs|AM|28|2
Richarlison|Spurs|ST|27|3
Cristian Romero|Spurs|CB|26|2
Pedro Porro|Spurs|RB|25|3
Rodrigo Bentancur|Spurs|CM|27|3
Erling Haaland dummy 10|Spurs|ST|25|1
Enzo Fernández|Chelsea|CM|24|2
Cole Palmer|Chelsea|AM|22|1
Nicolas Jackson|Chelsea|ST|23|3
Moisés Caicedo|Chelsea|CM|22|2
Reece James|Chelsea|RB|25|2
Marc Cucurella|Chelsea|LB|26|3
Erling Haaland dummy 11|Chelsea|ST|25|1
Ollie Watkins|Aston Villa|ST|29|2
John McGinn|Aston Villa|CM|30|3
Leon Bailey|Aston Villa|RW|27|3
Pau Torres|Aston Villa|CB|27|2
Matty Cash|Aston Villa|RB|27|3
Erling Haaland dummy 12|Aston Villa|ST|25|1
Alexander Isak|Newcastle|ST|25|2
Anthony Gordon|Newcastle|LW|23|3
Miguel Almirón|Newcastle|CM|30|4
Bruno Guimarães|Newcastle|CM|27|2
Nick Pope|Newcastle|GK|32|3
Erling Haaland dummy 13|Newcastle|ST|25|1
Lautaro Martínez|Inter|ST|27|2
Nicolò Barella|Inter|CM|27|2
Federico Dimarco|Inter|LB|26|3
Alessandro Bastoni|Inter|CB|25|2
Hakan Çalhanoğlu|Inter|CM|30|2
Yann Sommer|Inter|GK|35|3
Erling Haaland dummy 14|Inter|ST|25|1
Victor Osimhen|Galatasaray|ST|26|2
Erling Haaland dummy 15|Galatasaray|ST|25|1
Cristiano Ronaldo|Al Nassr|ST|40|1
Erling Haaland dummy 16|Al Nassr|ST|25|1
Khvicha Kvaratskhelia|Napoli|LW|23|2
Victor Osimhen dummy 2|Napoli|ST|26|2
Erling Haaland dummy 17|Napoli|ST|25|1
Antoine Griezmann|Atlético|AM|33|2
Marcos Llorente|Atlético|CM|30|3
Ángel Correa|Atlético|ST|29|4
Jan Oblak|Atlético|GK|31|2
Erling Haaland dummy 18|Atlético|ST|25|1
Rodri dummy 2|Atlético|CM|30|2
Xabi Simons|Leipzig|AM|22|2
Dani Olmo|Leipzig|AM|27|2
Erling Haaland dummy 19|Leipzig|ST|25|1
Federico Chiesa|Liverpool|RW|27|3
Erling Haaland dummy 20|Liverpool|ST|25|1
Gavi dummy 2|Villarreal|CM|20|2
Gio Lo Celso|Villarreal|CM|28|3
Pau Torres dummy 2|Villarreal|CB|27|2
Arnaut Danjuma|Villarreal|LW|27|4
Erling Haaland dummy 21|Villarreal|ST|25|1
Paulo Dybala|Roma|AM|31|3
Erling Haaland dummy 22|Roma|ST|25|1
Riyad Mahrez|Al Ahli|RW|33|3
Erling Haaland dummy 23|Al Ahli|ST|25|1
Mikel Oyarzabal|Real Sociedad|ST|27|3
Erling Haaland dummy 24|Real Sociedad|ST|25|1
Folarin Balogun|Monaco|ST|23|3
Breel Embolo|Monaco|ST|27|3
Erling Haaland dummy 25|Monaco|ST|25|1
Martin Terrier|Rennes|LW|28|4
Erling Haaland dummy 26|Rennes|ST|25|1
Desire Doue|Paris SG|LW|20|3
Erling Haaland dummy 27|Paris SG|LW|20|3
Bradley Barcola|Paris SG|LW|22|3
Erling Haaland dummy 28|Paris SG|LW|22|3
Warren Zaïre-Emery|Paris SG|CM|18|3
Erling Haaland dummy 29|Paris SG|CM|18|3
Mika Godts|Ajax|LW|20|4
Erling Haaland dummy 30|Ajax|LW|20|4
Bart Verbruggen|Brighton|GK|22|3
Erling Haaland dummy 31|Brighton|GK|22|3
Christian Pulisic|Milan|RW|26|2
Rafael Leão|Milan|LW|25|2
Theo Hernández|Milan|LB|27|2
Mike Maignan|Milan|GK|28|2
Erling Haaland dummy 32|Milan|RW|26|2
Julián Quiñones|Club América|ST|27|4
Erling Haaland dummy 33|Club América|ST|27|4
Tijjani Reijnders|Milan|CM|26|3
Erling Haaland dummy 34|Milan|CM|26|3
Pedro Neto|Chelsea|RW|24|3
Erling Haaland dummy 35|Chelsea|RW|24|3
`;

const VAL_RAW = {
  'Erling Haaland': 200, 'Kylian Mbappé': 200, 'Lionel Messi': 120,
  'Vinícius Júnior': 180, 'Jude Bellingham': 180, 'Mohamed Salah': 130,
  'Bukayo Saka': 150, 'Phil Foden': 150, 'Jamal Musiala': 150,
  'Lamine Yamal': 180, 'Florian Wirtz': 170, 'Pedri': 120,
  'Martin Ødegaard': 100, 'Enzo Fernández': 90, 'Cole Palmer': 130,
  'Gavi': 90, 'Declan Rice': 100, 'Virgil van Dijk': 80,
  'Trent Alexander-Arnold': 80, 'Federico Valverde': 90,
  'Bernardo Silva': 70, 'Joshua Kimmich': 60, 'Kevin De Bruyne': 60,
  'Bruno Fernandes': 70, 'Son Heung-min': 60, 'Marcus Rashford': 70,
  'Harry Kane': 80, 'Robert Lewandowski': 50, 'Cristiano Ronaldo': 30,
  'Lautaro Martínez': 90, 'Raphinha': 75, 'Luis Díaz': 80,
  'Ousmane Dembélé': 80, 'Michael Olise': 85, 'Xabi Simons': 80,
  'Dani Olmo': 65, 'Kai Havertz': 70, 'Rodri': 100,
  'William Saliba': 80, 'Alexander Isak': 80, 'Ollie Watkins': 70,
  'Cody Gakpo': 60, 'Darwin Núñez': 60, 'Matheus Cunha': 45,
  'Rasmus Højlund': 65, 'Khvicha Kvaratskhelia': 100, 'Rafael Leão': 80,
  'Christian Pulisic': 55, 'Theo Hernández': 55, 'Folarin Balogun': 35,
  'Breel Embolo': 25, 'Desire Doue': 50, 'Bradley Barcola': 50,
  'Warren Zaïre-Emery': 60, 'Mika Godts': 20, 'Bart Verbruggen': 20,
  'Marcos Llorente': 25, 'Gio Lo Celso': 12, 'Julián Quiñones': 8,
};

const STARS = {
  'kylian-mbappe-real-madrid': [{ d: '06-16', opp: 'Senegal', g: 2, a: 0, rating: 8.4 }, { d: '06-22', opp: 'Iraq', g: 2, a: 0, rating: 8.6 }],
  'erling-haaland-man-city': [{ d: '06-16', opp: 'Senegal', g: 2, a: 0, rating: 8.5 }, { d: '06-22', opp: 'Iraq', g: 1, a: 0, rating: 7.9 }],
  'ousmane-dembele-paris-sg': [{ d: '06-16', opp: 'Senegal', g: 0, a: 1, rating: 7.4 }, { d: '06-22', opp: 'Iraq', g: 1, a: 0, rating: 7.8 }],
  'michael-olise-bayern': [{ d: '06-16', opp: 'Senegal', g: 0, a: 1, rating: 7.6 }, { d: '06-22', opp: 'Iraq', g: 0, a: 2, rating: 8.4 }],
  'vinicius-junior-real-madrid': [{ d: '06-13', opp: 'Morocco', g: 1, a: 0, rating: 7.6 }, { d: '06-19', opp: 'Haiti', g: 1, a: 0, rating: 7.8 }],
  'lamine-yamal-barcelona': [{ d: '06-15', opp: 'Cape Verde', g: 0, a: 0, rating: 6.8 }, { d: '06-21', opp: 'Saudi Arabia', g: 1, a: 1, rating: 8.3 }],
  'jude-bellingham-real-madrid': [{ d: '06-17', opp: 'Croatia', g: 1, a: 0, rating: 7.8 }, { d: '06-23', opp: 'Ghana', g: 0, a: 0, rating: 6.5 }],
  'harry-kane-bayern': [{ d: '06-17', opp: 'Croatia', g: 2, a: 0, rating: 8.6 }, { d: '06-23', opp: 'Ghana', g: 0, a: 0, rating: 6.6 }],
  'marcus-rashford-barcelona': [{ d: '06-17', opp: 'Croatia', g: 1, a: 0, rating: 7.6 }, { d: '06-23', opp: 'Ghana', g: 0, a: 0, rating: 6.3 }],
  'jamal-musiala-bayern': [{ d: '06-15', opp: 'Curaçao', g: 1, a: 1, rating: 8.0 }, { d: '06-18', opp: 'Ivory Coast', g: 0, a: 0, rating: 7.6 }],
  'florian-wirtz-liverpool': [{ d: '06-15', opp: 'Curaçao', g: 1, a: 1, rating: 7.9 }, { d: '06-18', opp: 'Ivory Coast', g: 0, a: 1, rating: 7.5 }],
  'kai-havertz-arsenal': [{ d: '06-15', opp: 'Curaçao', g: 1, a: 0, rating: 7.5 }, { d: '06-18', opp: 'Ivory Coast', g: 0, a: 0, rating: 6.9 }],
  'luis-diaz-bayern': [{ d: '06-17', opp: 'Uzbekistan', g: 1, a: 1, rating: 8.5 }, { d: '06-23', opp: 'DR Congo', g: 0, a: 0, rating: 7.0 }],
  'christian-pulisic-milan': [{ d: '06-12', opp: 'Paraguay', g: 1, a: 1, rating: 7.9 }],
  'folarin-balogun-monaco': [{ d: '06-12', opp: 'Paraguay', g: 1, a: 0, rating: 7.5 }],
  'mikel-oyarzabal-real-sociedad': [{ d: '06-21', opp: 'Saudi Arabia', g: 1, a: 0, rating: 7.6 }],
  'matheus-cunha-man-utd': [{ d: '06-13', opp: 'Morocco', g: 0, a: 0, rating: 6.2 }, { d: '06-19', opp: 'Haiti', g: 2, a: 0, rating: 8.7 }, { d: '06-24', opp: 'Scotland', g: 1, a: 0, rating: 7.9 }],
  'bruno-fernandes-man-utd': [{ d: '06-17', opp: 'DR Congo', g: 0, a: 0, rating: 7.0 }, { d: '06-23', opp: 'Uzbekistan', g: 0, a: 1, rating: 8.0 }],
  'lautaro-martinez-inter': [{ d: '06-16', opp: 'Algeria', g: 0, a: 0, rating: 7.0 }, { d: '06-22', opp: 'Austria', g: 0, a: 0, rating: 7.1 }],
  'lionel-messi-inter-miami': [{ d: '06-16', opp: 'Algeria', g: 3, a: 0, rating: 9.5 }, { d: '06-22', opp: 'Austria', g: 2, a: 0, rating: 9.0 }],
  'cristiano-ronaldo-al-nassr': [{ d: '06-17', opp: 'DR Congo', g: 0, a: 0, rating: 6.8 }, { d: '06-23', opp: 'Uzbekistan', g: 1, a: 0, rating: 8.2 }],
  'john-mcginn-aston-villa': [{ d: '06-13', opp: 'Haiti', g: 1, a: 0, rating: 7.5 }],
  'pedri-barcelona': [{ d: '06-15', opp: 'Cape Verde', g: 0, a: 0, rating: 6.9 }, { d: '06-21', opp: 'Saudi Arabia', g: 0, a: 1, rating: 7.8 }],
  'raphinha-barcelona': [{ d: '06-13', opp: 'Morocco', g: 0, a: 1, rating: 7.3 }, { d: '06-19', opp: 'Haiti', g: 0, a: 0, rating: 7.0 }],
  'miguel-almiron-newcastle': [{ d: '06-19', opp: 'Turkey', g: 0, a: 0, rating: 4.2, red: true }],
};

// nation → WC status (for elimination detection)
const WC_ELIMINATED = new Set([
  'Scotland', 'New Zealand', 'Sweden', 'Iran', 'South Africa', 'South Korea',
  'Bosnia', 'Qatar', 'Haiti', 'Australia', 'Curaçao', 'Ivory Coast', 'Tunisia',
  'Cape Verde', 'Saudi Arabia', 'Senegal', 'Iraq', 'Algeria', 'Austria',
  'DR Congo', 'Uzbekistan', 'Panama',
]);

// last fixture date per nation (for elimination dip placement)
const WC_LAST_FIXTURE = {
  Scotland: '06-24', 'New Zealand': '06-21', Sweden: '06-20', Iran: '06-22',
  'South Africa': '06-15', 'South Korea': '06-21', Bosnia: '06-19', Qatar: '06-19',
  Haiti: '06-24', Australia: '06-22', 'Curaçao': '06-22', 'Ivory Coast': '06-22',
  Tunisia: '06-24', 'Cape Verde': '06-24', 'Saudi Arabia': '06-24',
  Senegal: '06-22', Iraq: '06-22', Algeria: '06-22', Austria: '06-22',
  'DR Congo': '06-23', Uzbekistan: '06-23', Panama: '06-23',
};

// nation per player (cold-start fallback)
const NATION = {
  'Kylian Mbappé': 'France', 'Ousmane Dembélé': 'France', 'Michael Olise': 'France',
  'Erling Haaland': 'Norway', 'Vinícius Júnior': 'Brazil', 'Raphinha': 'Brazil',
  'Matheus Cunha': 'Brazil', 'Lamine Yamal': 'Spain', 'Pedri': 'Spain',
  'Mikel Oyarzabal': 'Spain', 'Marcos Llorente': 'Spain',
  'Jude Bellingham': 'England', 'Harry Kane': 'England', 'Marcus Rashford': 'England',
  'Declan Rice': 'England', 'Bukayo Saka': 'England',
  'Jamal Musiala': 'Germany', 'Florian Wirtz': 'Germany', 'Kai Havertz': 'Germany',
  'Luis Díaz': 'Colombia', 'Christian Pulisic': 'USA', 'Folarin Balogun': 'USA',
  'Lionel Messi': 'Argentina', 'Lautaro Martínez': 'Argentina',
  'Cristiano Ronaldo': 'Portugal', 'Bruno Fernandes': 'Portugal',
  'John McGinn': 'Scotland', 'Vinicius Júnior': 'Brazil',
  'Miguel Almirón': 'Paraguay',
};

// ── pricing logic ──────────────────────────────────────────────────────────

const TODAY = new Date();
const TODAY_KEY = TODAY.toISOString().slice(0, 10);
const tierBase = { 1: 228, 2: 158, 3: 99, 4: 58, 5: 35, 6: 23 };

function offOf(dateStr) {
  // dateStr is "MM-DD", year is 2026
  return Math.round(
    (new Date(TODAY_KEY + 'T00:00:00Z') - new Date('2026-' + dateStr + 'T00:00:00Z')) / 86400000
  );
}

function dayKeyForOffset(offset) {
  const d = new Date(TODAY_KEY + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function computeSyntheticHist(id, name, team, pos, age, tier) {
  const r = mulberry(hash(id));
  const mv = VAL_RAW[name];
  const youth = age <= 21 ? 1 : 0;
  const anchor = (mv != null) ? mv : tierBase[tier] * (0.9 + 0.5 * r()) * (youth ? 1.15 : 1);

  const starsEff = STARS[id] || null;
  const nation = NATION[name] || null;
  const eliminated = nation && WC_ELIMINATED.has(nation);
  const atWC = !!starsEff;

  let events = [];
  if (starsEff) {
    for (const s of starsEff) {
      const g = s.g || 0, a = s.a || 0;
      const goalPart = g * 1.0 + (g >= 2 ? Math.pow(g - 1, 1.6) * 0.9 : 0);
      const assistPart = a * 0.6 + (a >= 2 ? Math.pow(a - 1, 1.4) * 0.4 : 0);
      const ratingExcess = Math.max(0, s.rating - 8.0);
      const isDefPos = /^(CB|LB|RB|WB|GK|DEF|SW)$/i.test(pos);
      const ratingBase = isDefPos ? 6.5 : 6.0;
      const ratingPart = (s.rating - ratingBase) * 1.3 + Math.pow(ratingExcess, 1.8) * 1.5;
      const delta = parseFloat((ratingPart + goalPart + assistPart).toFixed(2));
      events.push({ offset: offOf(s.d), delta });
    }
  }

  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const newsDelta = 0; // no NEWS factored in for backfill
  let change30d = parseFloat((sum(events.map(e => e.delta)) + newsDelta).toFixed(1));

  const ratingVals = starsEff ? starsEff.map(s => s.rating).filter(x => x > 0) : [];
  const avgR = ratingVals.length ? sum(ratingVals) / ratingVals.length : 0;
  const ratingsByRecency = (starsEff || []).slice().sort((a, b) => a.offset - b.offset).map(s => s.rating).filter(x => x > 0);
  let streakLen = 0;
  for (const rt of ratingsByRecency) { if (rt >= 7.4) streakLen++; else break; }

  const fotmob = avgR ? Math.max(8, Math.min(99, (avgR - 2.6) / 7.4 * 100)) : 0;
  let ewmaR = 0, ewmaW = 0, wgt = 1;
  for (const rt of ratingsByRecency.slice(0, 6)) { ewmaR += rt * wgt; ewmaW += wgt; wgt *= 0.75; }
  ewmaR = ewmaW ? ewmaR / ewmaW : 0;
  const formDelta = (ewmaW && avgR) ? (ewmaR - avgR) : 0;
  const formSig = atWC ? Math.max(6, Math.min(99, 46 + formDelta * 22 + streakLen * 4)) : 8;

  const hypeRaw = 0; // no live hype in backfill
  const moodSig = Math.max(6, Math.min(99, (46 + hypeRaw * 1.4 + (starsEff ? 14 : 0)) - (eliminated ? 30 : 0)));
  const transferSig = Math.max(8, Math.min(90, 46 + hypeRaw * 1.4));

  const wPerf = 0.06, wForm = 0.10, wHype = 0.35;
  const hasMatchData = atWC && avgR > 0;
  const notoriety = clamp((anchor - 20) / 180, 0, 1);
  const rawPerf = hasMatchData ? clamp((fotmob - 46) / 18, -1, 1) : 0;
  const rawForm = hasMatchData ? clamp((formSig - 46) / 18, -1, 1) : 0;
  const upMult = 1.55 - 0.8 * notoriety;
  const downMult = 0.60 + 0.8 * notoriety;
  const formDownMult = downMult * (1 + notoriety * 0.4);
  const applyMult = (v, up, dn) => v >= 0 ? v * up : v * dn;
  const applyFormMult = (v) => v >= 0 ? v * upMult : v * formDownMult;
  const perfScore = applyMult(rawPerf, upMult, downMult);
  const formScore = applyFormMult(rawForm);
  const hypeScore = clamp(((moodSig - 46) + (transferSig - 46)) / 2 / 30, -1, 1) * (1.3 - 0.4 * notoriety);

  const fairValueBase = anchor * Math.exp(wPerf * perfScore + wForm * formScore);
  const fairValue = fairValueBase * Math.exp(wHype * hypeScore);
  const price = fairValue; // no demand score for backfill

  // Brownian bridge synthetic history (same as buildDB)
  const hasSignal = atWC;
  const N = 90;
  const hist = [];
  const trend = hasSignal ? clamp(change30d / 100, -0.4, 0.4) : (r() - 0.5) * 0.04;
  const start = price / (1 + trend * 1.05);
  const steps = []; let acc = 0;
  for (let i = 0; i < N; i++) { acc += (r() - 0.5); steps.push(acc); }
  const s0 = steps[0], s1 = steps[N - 1];
  const bridge = steps.map((v, i) => v - (s0 + (s1 - s0) * i / (N - 1)));
  const bridgeMax = Math.max(...bridge.map(Math.abs)) || 1;
  const noiseAmp = price * (hasSignal ? 0.012 : 0.006);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const baseV = start + (price - start) * Math.pow(t, 1.15);
    const noise = (bridge[i] / bridgeMax) * noiseAmp;
    hist.push(Math.max(2, baseV + noise));
  }

  // Match event bumps
  for (const e of events) {
    const idx = N - 1 - e.offset;
    if (idx < 0 || idx >= N) continue;
    const downScale = e.delta < 0 ? 1.0 * (1 + notoriety * 0.25) : 1.0;
    const bump = (e.delta / 100) * price * downScale, ramp = 1, halfLife = 6;
    for (let j = idx; j < N; j++) {
      const daysIn = j - idx + 1;
      const riseK = Math.min(1, daysIn / ramp);
      const eased = riseK * riseK * (3 - 2 * riseK);
      const decay = Math.pow(0.5, Math.max(0, daysIn - ramp) / halfLife);
      hist[j] += bump * eased * decay;
    }
  }

  // Knockout dip
  if (eliminated && nation && WC_LAST_FIXTURE[nation]) {
    const elimOffset = offOf(WC_LAST_FIXTURE[nation]);
    const idx = N - 1 - elimOffset;
    if (idx >= 0 && idx < N) {
      const bump = -price * 0.08, ramp = 2, halfLife = 10;
      for (let j = idx; j < N; j++) {
        const daysIn = j - idx + 1;
        const riseK = Math.min(1, daysIn / ramp);
        const eased = riseK * riseK * (3 - 2 * riseK);
        const decay = Math.pow(0.5, Math.max(0, daysIn - ramp) / halfLife);
        hist[j] += bump * eased * decay;
      }
    }
  }

  // Daily wobble (same seed as buildDB — dayKey-based per player)
  const wR = mulberry(hash(id + ':w:' + TODAY_KEY));
  const wMag = atWC ? 0.02 : 0.006;
  const wobble = 1 + (wR() - 0.5) * 2 * wMag;
  // hist[N-1] is "today" — we apply the same wobble the app would
  for (let i = 0; i < N; i++) hist[i] = Math.max(2, hist[i]);
  hist[N - 1] = Math.max(2, hist[N - 1] * wobble);

  return hist; // 90 values, index 0 = 89 days ago, index 89 = today
}

// ── main ───────────────────────────────────────────────────────────────────

async function upsertBatch(rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/price_history`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Supabase upsert failed: ${r.status} ${txt}`);
  }
}

async function main() {
  const lines = ROSTER_RAW.trim().split('\n');
  const seen = {};
  const allRows = [];

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 5) continue;
    let [name, team, pos, age, tier] = parts;
    name = name.replace(/ dummy.*$/, '').trim();
    tier = parseInt(tier); age = parseInt(age);
    const id = slug(name + '-' + team);
    if (seen[id]) continue;
    seen[id] = 1;

    const hist = computeSyntheticHist(id, name, team, pos, age, tier);
    // Only upsert past days (indices 0..88), skip today (index 89)
    for (let i = 0; i < 89; i++) {
      const offset = 89 - i; // index 0 → offset 89 (oldest), index 88 → offset 1 (yesterday)
      const dayKey = dayKeyForOffset(offset);
      const price = Math.round(hist[i] * 100) / 100;
      allRows.push({ player_id: id, day_key: dayKey, price });
    }
  }

  console.log(`Upserting ${allRows.length} rows for ${Object.keys(seen).length} players…`);

  // Batch in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const batch = allRows.slice(i, i + CHUNK);
    await upsertBatch(batch);
    process.stdout.write(`  ${Math.min(i + CHUNK, allRows.length)}/${allRows.length}\r`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
