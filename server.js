const express = require('express');
const path = require('path');
const db = require('./db');
const { syncAll, scheduleSync } = require('./sync-data');

const app = express();
const port = Number(process.env.PORT || 3000);
const syncMinutes = Math.max(5, Number(process.env.SYNC_INTERVAL_MINUTES || 30));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sportByKey = db.prepare('SELECT * FROM sports WHERE key = ?');
const participantById = db.prepare('SELECT p.*, r.rating, r.matches_played FROM participants p JOIN ratings r ON r.participant_id = p.id WHERE p.id = ?');
const participantByName = db.prepare('SELECT p.*, r.rating, r.matches_played FROM participants p JOIN ratings r ON r.participant_id = p.id WHERE p.sport_id = ? AND lower(p.name) = lower(?)');
const participantList = db.prepare('SELECT p.id, p.name, p.short_name, p.gender, r.rating, r.matches_played FROM participants p JOIN ratings r ON r.participant_id = p.id WHERE p.sport_id = ? ORDER BY r.rating DESC, p.name');
const createParticipant = db.prepare('INSERT INTO participants(sport_id, name, short_name) VALUES (?, ?, ?)');
const createRating = db.prepare('INSERT INTO ratings(participant_id, rating) VALUES (?, 1500)');

const scoreboardPaths = {
  nfl: 'football/nfl', nba: 'basketball/nba', nhl: 'hockey/nhl',
  mlb: 'baseball/mlb', 'premier-league': 'soccer/eng.1',
  tennis: 'tennis/atp'
};

function sportOr404(key, res) {
  const sport = sportByKey.get(key);
  if (!sport) { res.status(404).json({ error: `Unknown sport: ${key}` }); return null; }
  return sport;
}

function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function cleanName(value) { return String(value || '').trim().replace(/\s+/g, ' '); }

function getOrCreate(sport, rawName) {
  const name = cleanName(rawName);
  if (!name || name.length > 80) return null;
  const existing = participantByName.get(sport.id, name);
  if (existing) return existing;
  const id = createParticipant.run(sport.id, name, name).lastInsertRowid;
  createRating.run(id);
  return participantById.get(id);
}

function probabilities(sport, home, away) {
  const homeProbability = expected(home.rating + (sport.key === 'tennis' ? 0 : 35), away.rating);
  if (!sport.supports_draw) return { home: homeProbability, draw: 0, away: 1 - homeProbability };
  const draw = Math.min(0.3, 0.16 + Math.abs(homeProbability - 0.5) * 0.04);
  return { home: (1 - draw) * homeProbability, draw, away: (1 - draw) * (1 - homeProbability) };
}

function odds(probability) {
  if (!probability) return null;
  const american = probability >= 0.5
    ? -Math.round(100 * probability / (1 - probability))
    : Math.round(100 * (1 - probability) / probability);
  return { decimal: Number((1 / probability).toFixed(2)), american: american > 0 ? `+${american}` : `${american}` };
}

function stats(sport, participant) {
  const rating = Math.round(participant.rating);
  const form = Math.max(40, Math.min(95, Math.round(55 + (rating - 1500) / 10)));
  const metric = (offset = 0) => Math.max(40, Math.min(96, Math.round(68 + (rating - 1500) / 8 + offset)));
  if (sport.key === 'tennis') return { rating, matchesPlayed: participant.matches_played || 0, form, serve: metric(2), return: metric(-1), winRate: Math.max(35, Math.min(82, Math.round(50 + (rating - 1500) / 12))) };
  if (sport.key === 'nfl') return { rating, matchesPlayed: participant.matches_played || 0, form, offense: metric(2), defense: metric(), efficiency: metric(-2) };
  if (sport.key === 'nhl') return { rating, matchesPlayed: participant.matches_played || 0, form, attack: metric(1), defense: metric(), goaltending: metric(3) };
  if (sport.key === 'mlb') return { rating, matchesPlayed: participant.matches_played || 0, form, offense: metric(2), pitching: metric(), depth: metric(-2) };
  if (sport.key === 'nba') return { rating, matchesPlayed: participant.matches_played || 0, form, offense: metric(3), defense: metric(), tempo: metric(-2) };
  return { rating, matchesPlayed: participant.matches_played || 0, form, attack: metric(2), defense: metric(), control: metric(-2) };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'EdgePlay/1.0' } });
  if (!response.ok) throw new Error(`Sports feed returned ${response.status}`);
  return response.json();
}

function scoreEvent(event) {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const home = competitors.find((item) => item.homeAway === 'home') || competitors[0];
  const away = competitors.find((item) => item.homeAway === 'away') || competitors[1];
  const status = event.status?.type || {};
  return {
    id: event.id,
    name: event.name,
    date: event.date,
    league: event.league?.name || event.season?.name || '',
    state: status.state || 'pre',
    status: status.shortDetail || status.detail || 'Scheduled',
    completed: Boolean(status.completed),
    clock: status.displayClock || null,
    period: status.period || null,
    home: home ? { name: home.team?.displayName || home.athlete?.displayName || 'Home', abbreviation: home.team?.abbreviation || '', score: home.score ?? '0', winner: Boolean(home.winner), logo: home.team?.logo || null } : null,
    away: away ? { name: away.team?.displayName || away.athlete?.displayName || 'Away', abbreviation: away.team?.abbreviation || '', score: away.score ?? '0', winner: Boolean(away.winner), logo: away.team?.logo || null } : null
  };
}

app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/sports', (_, res) => res.json(db.prepare('SELECT key, name, kind, supports_draw FROM sports ORDER BY name').all()));
app.get('/api/participants', (req, res) => { const sport = sportOr404(req.query.sport, res); if (!sport) return; res.json(participantList.all(sport.id)); });
app.get('/api/leaderboard', (req, res) => { const sport = sportOr404(req.query.sport || 'tennis', res); if (!sport) return; res.json({ sport: sport.key, participants: participantList.all(sport.id) }); });

app.get('/api/scores', async (req, res) => {
  const key = req.query.sport || 'nba';
  if (!scoreboardPaths[key]) return res.status(400).json({ error: 'Live scores are not available for that sport yet.' });
  try {
    const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${scoreboardPaths[key]}/scoreboard`);
    res.json({ sport: key, updatedAt: new Date().toISOString(), events: (data.events || []).map(scoreEvent) });
  } catch (error) {
    res.status(502).json({ error: 'Live scores are temporarily unavailable.', detail: error.message });
  }
});

app.get('/api/matches', (req, res) => {
  const sport = sportOr404(req.query.sport || 'tennis', res); if (!sport) return;
  const rows = db.prepare(`SELECT m.*, h.id home_id, h.name home_name, rh.rating home_rating, a.id away_id, a.name away_name, ra.rating away_rating FROM matches m JOIN participants h ON h.id=m.home_participant_id JOIN ratings rh ON rh.participant_id=h.id JOIN participants a ON a.id=m.away_participant_id JOIN ratings ra ON ra.participant_id=a.id WHERE m.sport_id=? ORDER BY m.id DESC LIMIT 50`).all(sport.id);
  res.json(rows.map((row) => ({ id: row.id, status: row.status, home: { id: row.home_id, name: row.home_name, rating: row.home_rating }, away: { id: row.away_id, name: row.away_name, rating: row.away_rating } })));
});

app.post('/api/predict', (req, res) => {
  const sport = sportOr404(req.body?.sport, res); if (!sport) return;
  const home = getOrCreate(sport, req.body?.home); const away = getOrCreate(sport, req.body?.away);
  if (!home || !away || home.id === away.id) return res.status(400).json({ error: 'Enter two different names.' });
  const p = probabilities(sport, home, away);
  const match = db.prepare('INSERT INTO matches(sport_id,home_participant_id,away_participant_id,scheduled_at) VALUES (?,?,?,?)').run(sport.id, home.id, away.id, new Date().toISOString());
  const saved = db.prepare('INSERT INTO predictions(match_id,sport_id,home_probability,draw_probability,away_probability,model_version) VALUES (?,?,?,?,?,?)').run(match.lastInsertRowid, sport.id, p.home, p.draw, p.away, sport.key === 'tennis' ? 'tennis-elo-v3' : 'form-model-v1');
  res.json({ id: saved.lastInsertRowid, matchId: match.lastInsertRowid, sport: sport.key, home: { name: home.name, gender: home.gender, stats: stats(sport, home) }, away: { name: away.name, gender: away.gender, stats: stats(sport, away) }, probabilities: p, odds: { home: odds(p.home), draw: odds(p.draw), away: odds(p.away) }, confidence: Math.round(Math.min(96, 52 + Math.abs(p.home - p.away) * 90)), model: sport.key === 'tennis' ? 'Tennis Elo' : 'Sports form model' });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => {
  console.log(`EdgePlay listening on port ${port}`);
  syncAll().catch(console.error);
  scheduleSync(syncMinutes * 60 * 1000);
});
