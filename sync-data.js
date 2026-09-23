const db = require('./db');

const ESPN_LEAGUES = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  nhl: 'hockey/nhl',
  mlb: 'baseball/mlb',
  'premier-league': 'soccer/eng.1'
};
const TENNIS_SOURCES = [
  ['men', 'https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/rankings_current.csv'],
  ['women', 'https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/rankings_current.csv']
];

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { values.push(value); value = ''; }
    else value += char;
  }
  values.push(value);
  return values;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

async function json(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'EdgePlay/1.0' } });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response.json();
}

async function text(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'EdgePlay/1.0' } });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response.text();
}

function sportId(key) { return db.prepare('SELECT id FROM sports WHERE key=?').get(key)?.id; }
function upsert(sportIdValue, name, externalId, gender = null, rating = 1500) {
  const existing = db.prepare('SELECT id FROM participants WHERE sport_id=? AND lower(name)=lower(?)').get(sportIdValue, name);
  let id;
  if (existing) {
    id = existing.id;
    db.prepare('UPDATE participants SET external_id=?, gender=? WHERE id=?').run(externalId || null, gender, id);
  } else {
    id = db.prepare('INSERT INTO participants(sport_id,name,short_name,external_id,gender) VALUES (?,?,?,?,?)').run(sportIdValue, name, name, externalId || null, gender).lastInsertRowid;
  }
  db.prepare('INSERT OR IGNORE INTO ratings(participant_id,rating) VALUES (?,?)').run(id, rating);
  return id;
}

async function syncTeams() {
  let total = 0;
  for (const [sport, league] of Object.entries(ESPN_LEAGUES)) {
    const data = await json(`https://site.api.espn.com/apis/site/v2/sports/${league}/teams`);
    const teams = data?.sports?.[0]?.leagues?.[0]?.teams || [];
    for (const entry of teams) {
      const team = entry.team || entry;
      if (team.displayName) { upsert(sportId(sport), team.displayName, team.id, null); total += 1; }
    }
  }
  return total;
}

async function syncTennis() {
  let total = 0;
  for (const [gender, url] of TENNIS_SOURCES) {
    const rows = parseCsv(await text(url)).filter((row) => Number(row.ranking) <= 200);
    for (const row of rows) {
      if (!row.player_name) continue;
      const id = upsert(sportId('tennis'), row.player_name, row.player_id, gender, 1500 + Math.max(0, 201 - Number(row.ranking || 200)) * 2);
      db.prepare('UPDATE ratings SET rating=?, updated_at=CURRENT_TIMESTAMP WHERE participant_id=? AND matches_played=0').run(1500 + Math.max(0, 201 - Number(row.ranking || 200)) * 2, id);
      total += 1;
    }
  }
  return total;
}

async function syncAll() {
  const result = { teams: 0, tennis: 0, errors: [] };
  try { result.teams = await syncTeams(); } catch (error) { result.errors.push(`Teams: ${error.message}`); }
  try { result.tennis = await syncTennis(); } catch (error) { result.errors.push(`Tennis: ${error.message}`); }
  return result;
}

module.exports = { syncAll };
