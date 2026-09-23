const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sportByKey = db.prepare('SELECT * FROM sports WHERE key = ?');
const participantById = db.prepare('SELECT p.*, r.rating, r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.id=?');
const participantByName = db.prepare('SELECT p.*, r.rating, r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? AND lower(p.name)=lower(?)');
const participantList = db.prepare('SELECT p.id,p.name,p.short_name,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? ORDER BY r.rating DESC,p.name');

function sportOr404(key, res) {
  const sport = sportByKey.get(key);
  if (!sport) { res.status(404).json({ error: `Unknown sport: ${key}` }); return null; }
  return sport;
}
function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function probabilities(sport, home, away) {
  const homeAdvantage = sport.key === 'tennis' ? 0 : 35;
  const homeP = expected(home.rating + homeAdvantage, away.rating);
  if (!sport.supports_draw) return { home: homeP, draw: 0, away: 1 - homeP };
  const draw = Math.min(0.30, 0.12 + Math.abs(homeP - 0.5) * 0.05);
  return { home: (1 - draw) * homeP, draw, away: (1 - draw) * (1 - homeP) };
}
function matchResponse(row) {
  return { ...row, home: { id: row.home_id, name: row.home_name, rating: row.home_rating }, away: { id: row.away_id, name: row.away_name, rating: row.away_rating } };
}

app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/sports', (_, res) => res.json(db.prepare('SELECT key,name,kind,supports_draw FROM sports ORDER BY name').all()));
app.get('/api/participants', (req, res) => {
  const sport = sportOr404(req.query.sport, res); if (!sport) return;
  res.json(participantList.all(sport.id));
});
app.get('/api/leaderboard', (req, res) => {
  const sport = sportOr404(req.query.sport || 'tennis', res); if (!sport) return;
  res.json({ sport, participants: participantList.all(sport.id) });
});
app.get('/api/matches', (req, res) => {
  const sport = sportOr404(req.query.sport || 'tennis', res); if (!sport) return;
  const rows = db.prepare(`SELECT m.*, h.id home_id,h.name home_name,rh.rating home_rating,a.id away_id,a.name away_name,ra.rating away_rating FROM matches m JOIN participants h ON h.id=m.home_participant_id JOIN ratings rh ON rh.participant_id=h.id JOIN participants a ON a.id=m.away_participant_id JOIN ratings ra ON ra.participant_id=a.id WHERE m.sport_id=? ORDER BY m.scheduled_at DESC,m.id DESC LIMIT 100`).all(sport.id);
  res.json(rows.map(matchResponse));
});
app.post('/api/predict', (req, res) => {
  const { sport: key, home, away, scheduledAt } = req.body || {};
  const sport = sportOr404(key, res); if (!sport) return;
  const h = participantByName.get(sport.id, String(home || '')); const a = participantByName.get(sport.id, String(away || ''));
  if (!h || !a || h.id === a.id) return res.status(400).json({ error: 'Choose two different participants from the selected sport.' });
  const p = probabilities(sport, h, a);
  const match = db.prepare('INSERT INTO matches(sport_id,home_participant_id,away_participant_id,scheduled_at) VALUES (?,?,?,?)').run(sport.id,h.id,a.id,scheduledAt || null);
  const saved = db.prepare('INSERT INTO predictions(match_id,sport_id,home_probability,draw_probability,away_probability,model_version) VALUES (?,?,?,?,?,?)').run(match.lastInsertRowid,sport.id,p.home,p.draw,p.away,'elo-v1');
  res.json({ id: saved.lastInsertRowid, matchId: match.lastInsertRowid, sport: sport.key, home: h.name, away: a.name, probabilities: { home: p.home, draw: p.draw, away: p.away }, ratings: { home: h.rating, away: a.rating }, model: 'Elo v1' });
});
app.post('/api/matches/:id/result', (req, res) => {
  const match = db.prepare('SELECT m.*,s.key,s.k_factor,s.supports_draw FROM matches m JOIN sports s ON s.id=m.sport_id WHERE m.id=?').get(req.params.id);
  if (!match) return res.status(404).json({ error: 'Match not found.' });
  const { winner, homeScore, awayScore } = req.body || {};
  if (!['home','away','draw'].includes(winner) || winner === 'draw' && !match.supports_draw) return res.status(400).json({ error: 'Invalid result for this sport.' });
  const home = participantById.get(match.home_participant_id); const away = participantById.get(match.away_participant_id);
  const p = probabilities(match, home, away); const actual = winner === 'home' ? [1,0] : winner === 'away' ? [0,1] : [0.5,0.5];
  const update = db.prepare('UPDATE ratings SET rating=?,matches_played=matches_played+1,updated_at=CURRENT_TIMESTAMP WHERE participant_id=?');
  const tx = db.transaction(() => { update.run(home.rating + match.k_factor * (actual[0] - p.home), home.id); update.run(away.rating + match.k_factor * (actual[1] - p.away), away.id); db.prepare("UPDATE matches SET status='final',home_score=?,away_score=? WHERE id=?").run(homeScore ?? null, awayScore ?? null, match.id); });
  tx(); res.json({ ok: true, home: participantById.get(home.id), away: participantById.get(away.id) });
});
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => console.log(`Multi-sport Elo app listening on http://localhost:${port}`));
