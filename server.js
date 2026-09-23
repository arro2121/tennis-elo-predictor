const express = require('express');
const path = require('path');
const db = require('./db');
const { syncAll, scheduleSync } = require('./sync-data');

const app = express();
const port = Number(process.env.PORT || 3000);
const syncMinutes = Math.max(5, Number(process.env.SYNC_INTERVAL_MINUTES || 30));
const ESPN_PATHS = {
  nfl: 'football/nfl', nba: 'basketball/nba', nhl: 'hockey/nhl',
  mlb: 'baseball/mlb', 'premier-league': 'soccer/eng.1', tennis: 'tennis/atp'
};

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const sportByKey = db.prepare('SELECT * FROM sports WHERE key = ?');
const participantByName = db.prepare('SELECT p.*, r.rating, r.matches_played FROM participants p JOIN ratings r ON r.participant_id = p.id WHERE p.sport_id = ? AND lower(p.name) = lower(?)');
const participantById = db.prepare('SELECT p.*, r.rating, r.matches_played FROM participants p JOIN ratings r ON r.participant_id = p.id WHERE p.id = ?');
const participantList = db.prepare('SELECT p.id,p.name,p.short_name,p.gender,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id = p.id WHERE p.sport_id = ? ORDER BY r.rating DESC,p.name');

function getSport(key, res) {
  const sport = sportByKey.get(String(key || '').toLowerCase());
  if (!sport) { res.status(404).json({ error: 'Unsupported sport.' }); return null; }
  return sport;
}
function cleanName(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function getParticipant(sport, raw) {
  const name = cleanName(raw);
  if (!name || name.length > 80) return null;
  const existing = participantByName.get(sport.id, name);
  if (existing) return existing;
  const id = db.prepare('INSERT INTO participants(sport_id,name,short_name) VALUES (?,?,?)').run(sport.id, name, name).lastInsertRowid;
  db.prepare('INSERT INTO ratings(participant_id,rating) VALUES (?,1500)').run(id);
  return participantById.get(id);
}
function tennisEloProbability(home, away) {
  return 1 / (1 + 10 ** ((away.rating - home.rating) / 400));
}
function teamFormProbability(home, away) {
  // Separate from Elo: a simple form/power baseline with home advantage.
  const logit = 0.006 * (home.rating - away.rating) + 0.28;
  return 1 / (1 + Math.exp(-logit));
}
function probabilities(sport, home, away) {
  const homeWin = sport.key === 'tennis' ? tennisEloProbability(home, away) : teamFormProbability(home, away);
  if (!sport.supports_draw) return { home: homeWin, draw: 0, away: 1 - homeWin };
  const draw = Math.min(0.3, 0.16 + Math.abs(homeWin - 0.5) * 0.04);
  return { home: (1 - draw) * homeWin, draw, away: (1 - draw) * (1 - homeWin) };
}
function fairOdds(probability) {
  if (!probability) return null;
  const american = probability >= 0.5 ? -Math.round(100 * probability / (1 - probability)) : Math.round(100 * (1 - probability) / probability);
  return { decimal: Number((1 / probability).toFixed(2)), american: american > 0 ? `+${american}` : String(american) };
}
async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'EdgePlay/1.0' } });
  if (!response.ok) throw new Error(`Provider returned ${response.status}`);
  return response.json();
}
function normalizeEvent(event) {
  const competitors = event.competitions?.[0]?.competitors || [];
  const home = competitors.find((item) => item.homeAway === 'home') || competitors[0];
  const away = competitors.find((item) => item.homeAway === 'away') || competitors[1];
  const status = event.status?.type || {};
  return {
    id: event.id, name: event.name, date: event.date,
    state: status.state || 'pre', status: status.shortDetail || status.detail || 'Scheduled',
    completed: Boolean(status.completed),
    home: home && { name: home.team?.displayName || home.athlete?.displayName || 'Home', score: home.score ?? '-', logo: home.team?.logo || null },
    away: away && { name: away.team?.displayName || away.athlete?.displayName || 'Away', score: away.score ?? '-', logo: away.team?.logo || null }
  };
}
function classifyPlay(play) {
  const text = String(play.text || play.shortText || '').toLowerCase();
  if (/strike|ball four|walk|pitch/.test(text)) return 'baseball';
  if (/touchdown|pass complete|interception|quarterback|rush|punt|field goal/.test(text)) return 'football';
  if (/goal|shot|save|power play|penalty/.test(text)) return 'hockey';
  if (/three pointer|dunk|free throw|rebound|assist|foul/.test(text)) return 'basketball';
  if (/goal|shot|corner|yellow card|red card/.test(text)) return 'soccer';
  return 'default';
}

app.get('/api/health', (_, res) => res.json({ ok: true, service: 'edgeplay' }));
app.get('/api/sports', (_, res) => res.json(db.prepare('SELECT key,name,kind,supports_draw FROM sports ORDER BY name').all()));
app.get('/api/participants', (req, res) => { const sport = getSport(req.query.sport, res); if (sport) res.json(participantList.all(sport.id)); });
app.get('/api/leaderboard', (req, res) => { const sport = getSport(req.query.sport || 'tennis', res); if (sport) res.json({ sport: sport.key, participants: participantList.all(sport.id) }); });

app.get('/api/scores', async (req, res) => {
  const key = String(req.query.sport || 'nba');
  if (!ESPN_PATHS[key]) return res.status(400).json({ error: 'Unsupported score sport.' });
  try {
    const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATHS[key]}/scoreboard`);
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ sport: key, updatedAt: new Date().toISOString(), events: (data.events || []).map(normalizeEvent) });
  } catch (error) { res.status(502).json({ error: 'Live scores are temporarily unavailable.' }); }
});

app.get('/api/play-by-play', async (req, res) => {
  const key = String(req.query.sport || 'nba');
  const eventId = String(req.query.event || '');
  if (!ESPN_PATHS[key] || !eventId) return res.status(400).json({ error: 'Sport and event are required.' });
  try {
    const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATHS[key]}/summary?event=${encodeURIComponent(eventId)}`);
    const competitors = data.header?.competitions?.[0]?.competitors || [];
    res.set('Cache-Control', 'public, max-age=15');
    res.json({
      name: competitors.map((item) => item.team?.displayName || item.athlete?.displayName).join(' vs '),
      plays: (data.plays || []).slice().reverse().map((play, index) => ({ id: play.id || index, clock: play.clock || '', period: play.period?.number || play.period || '', text: play.text || play.shortText || 'Game update', scoring: Boolean(play.scoring), animation: classifyPlay(play) }))
    });
  } catch (error) { res.status(502).json({ error: 'Play-by-play is temporarily unavailable.' }); }
});

app.get('/api/matches', (req, res) => {
  const sport = getSport(req.query.sport || 'tennis', res); if (!sport) return;
  const rows = db.prepare('SELECT m.id,m.status,h.name home_name,a.name away_name FROM matches m JOIN participants h ON h.id=m.home_participant_id JOIN participants a ON a.id=m.away_participant_id WHERE m.sport_id=? ORDER BY m.id DESC LIMIT 50').all(sport.id);
  res.json(rows.map((row) => ({ id: row.id, status: row.status, home: { name: row.home_name }, away: { name: row.away_name } })));
});

app.post('/api/predict', (req, res) => {
  const sport = getSport(req.body?.sport, res); if (!sport) return;
  const home = getParticipant(sport, req.body?.home); const away = getParticipant(sport, req.body?.away);
  if (!home || !away || home.id === away.id) return res.status(400).json({ error: 'Enter two different competitors.' });
  const probabilitiesResult = probabilities(sport, home, away);
  const match = db.prepare('INSERT INTO matches(sport_id,home_participant_id,away_participant_id,scheduled_at) VALUES (?,?,?,?)').run(sport.id, home.id, away.id, new Date().toISOString());
  const model = sport.key === 'tennis' ? 'Tennis Elo' : 'Sports form baseline';
  const id = db.prepare('INSERT INTO predictions(match_id,sport_id,home_probability,draw_probability,away_probability,model_version) VALUES (?,?,?,?,?,?)').run(match.lastInsertRowid, sport.id, probabilitiesResult.home, probabilitiesResult.draw, probabilitiesResult.away, sport.key === 'tennis' ? 'tennis-elo-v4' : 'sport-form-v2').lastInsertRowid;
  res.json({ id, matchId: match.lastInsertRowid, sport: sport.key, home: home.name, away: away.name, probabilities: probabilitiesResult, odds: { home: fairOdds(probabilitiesResult.home), draw: fairOdds(probabilitiesResult.draw), away: fairOdds(probabilitiesResult.away) }, model });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => { console.log(`EdgePlay listening on port ${port}`); syncAll().catch(console.error); scheduleSync(syncMinutes * 60000); });
