const express = require('express');
const path = require('path');
const db = require('./db');
const { syncAll, scheduleSync } = require('./sync-data');

const app = express();
const port = Number(process.env.PORT || 3000);
const syncIntervalMs = Number(process.env.SYNC_INTERVAL_MINUTES || 30) * 60 * 1000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sportByKey = db.prepare('SELECT * FROM sports WHERE key=?');
const participantById = db.prepare('SELECT p.*,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.id=?');
const participantByName = db.prepare('SELECT p.*,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? AND lower(p.name)=lower(?)');
const participantList = db.prepare('SELECT p.id,p.name,p.short_name,p.gender,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? ORDER BY r.rating DESC,p.name');
const createParticipant = db.prepare('INSERT INTO participants(sport_id,name,short_name) VALUES (?,?,?)');
const createRating = db.prepare('INSERT INTO ratings(participant_id,rating) VALUES (?,1500)');

function sportOr404(key, res) {
  const sport = sportByKey.get(key);
  if (!sport) {
    res.status(404).json({ error: `Unknown sport: ${key}` });
    return null;
  }
  return sport;
}

function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

function cleanName(v) {
  return String(v || '').trim().replace(/\s+/g, ' ');
}

function getOrCreate(sport, raw) {
  const name = cleanName(raw);
  if (!name || name.length > 80) return null;

  let participant = participantByName.get(sport.id, name);
  if (participant) return participant;

  const id = createParticipant.run(sport.id, name, name).lastInsertRowid;
  createRating.run(id);
  return participantById.get(id);
}

function probabilities(sport, home, away) {
  const homeP = expected(home.rating + (sport.key === 'tennis' ? 0 : 35), away.rating);
  if (!sport.supports_draw) return { home: homeP, draw: 0, away: 1 - homeP };
  const draw = Math.min(0.3, 0.16 + Math.abs(homeP - 0.5) * 0.04);
  return { home: (1 - draw) * homeP, draw, away: (1 - draw) * (1 - homeP) };
}

function odds(probability) {
  if (!probability) return null;
  const american = probability >= 0.5
    ? -Math.round((100 * probability) / (1 - probability))
    : Math.round((100 * (1 - probability)) / probability);

  return {
    decimal: Number((1 / probability).toFixed(2)),
    american: american > 0 ? `+${american}` : `${american}`
  };
}

function profile(sport, participant) {
  const rating = Math.round(participant.rating);
  const matchesPlayed = participant.matches_played || 0;
  const form = Math.max(40, Math.min(95, Math.round(55 + (rating - 1500) / 10)));
  const stat = (offset = 0) => Math.max(40, Math.min(96, Math.round(68 + (rating - 1500) / 8 + offset)));

  if (sport.key === 'tennis') {
    return { rating, matchesPlayed, form, serve: stat(2), return: stat(-1), winRate: Math.max(35, Math.min(82, Math.round(50 + (rating - 1500) / 12))), surface: stat(-3) };
  }
  if (sport.key === 'nfl') {
    return { rating, matchesPlayed, form, offense: stat(2), defense: stat(), efficiency: stat(-2) };
  }
  if (sport.key === 'nhl') {
    return { rating, matchesPlayed, form, attack: stat(1), defense: stat(), goaltending: stat(3) };
  }
  if (sport.key === 'mlb') {
    return { rating, matchesPlayed, form, offense: stat(2), pitching: stat(), depth: stat(-2) };
  }
  if (sport.key === 'nba') {
    return { rating, matchesPlayed, form, offense: stat(3), defense: stat(), tempo: stat(-2) };
  }
  return { rating, matchesPlayed, form, attack: stat(2), defense: stat(), control: stat(-2) };
}

app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/sports', (_, res) => res.json(db.prepare('SELECT key,name,kind,supports_draw FROM sports ORDER BY name').all()));

app.get('/api/sync', async (_, res) => {
  try {
    const result = await syncAll();
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/participants', (req, res) => {
  const sport = sportOr404(req.query.sport, res);
  if (!sport) return;
  res.json(participantList.all(sport.id));
});

app.post('/api/participants', (req, res) => {
  const sport = sportOr404(req.body?.sport, res);
  if (!sport) return;

  const participant = getOrCreate(sport, req.body?.name);
  if (!participant) return res.status(400).json({ error: 'Enter a valid name up to 80 characters.' });

  res.status(201).json({ ...participant, stats: profile(sport, participant) });
});

app.get('/api/leaderboard', (req, res) => {
  const sport = sportOr404(req.query.sport || 'tennis', res);
  if (!sport) return;
  res.json({ sport: sport.key, participants: participantList.all(sport.id) });
});

app.get('/api/matches', (req, res) => {
  const sport = sportOr404(req.query.sport || 'tennis', res);
  if (!sport) return;

  const rows = db.prepare(`
    SELECT
      m.*, h.id home_id, h.name home_name, rh.rating home_rating,
      a.id away_id, a.name away_name, ra.rating away_rating
    FROM matches m
    JOIN participants h ON h.id = m.home_participant_id
    JOIN ratings rh ON rh.participant_id = h.id
    JOIN participants a ON a.id = m.away_participant_id
    JOIN ratings ra ON ra.participant_id = a.id
    WHERE m.sport_id = ?
    ORDER BY m.id DESC
    LIMIT 50
  `).all(sport.id);

  res.json(rows.map((row) => ({
    id: row.id,
    status: row.status,
    home: { id: row.home_id, name: row.home_name, rating: row.home_rating },
    away: { id: row.away_id, name: row.away_name, rating: row.away_rating }
  })));
});

app.post('/api/predict', (req, res) => {
  const sport = sportOr404(req.body?.sport, res);
  if (!sport) return;

  const home = getOrCreate(sport, req.body?.home);
  const away = getOrCreate(sport, req.body?.away);

  if (!home || !away || home.id === away.id) {
    return res.status(400).json({ error: 'Enter two different names.' });
  }

  const p = probabilities(sport, home, away);
  const match = db.prepare('INSERT INTO matches(sport_id,home_participant_id,away_participant_id,scheduled_at) VALUES (?,?,?,?)')
    .run(sport.id, home.id, away.id, new Date().toISOString());

  const saved = db.prepare('INSERT INTO predictions(match_id,sport_id,home_probability,draw_probability,away_probability,model_version) VALUES (?,?,?,?,?,?)')
    .run(match.lastInsertRowid, sport.id, p.home, p.draw, p.away, 'elo-v3');

  const confidence = Math.round(Math.min(96, 52 + Math.abs(p.home - p.away) * 90));

  res.json({
    id: saved.lastInsertRowid,
    matchId: match.lastInsertRowid,
    sport: sport.key,
    home: { name: home.name, gender: home.gender, stats: profile(sport, home) },
    away: { name: away.name, gender: away.gender, stats: profile(sport, away) },
    probabilities: p,
    odds: { home: odds(p.home), draw: odds(p.draw), away: odds(p.away) },
    confidence,
    model: 'Elo v3'
  });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => {
  console.log(`EdgePlay listening on port ${port}`);
  syncAll().then((result) => console.log('Initial data refresh', result)).catch(console.error);
  scheduleSync(syncIntervalMs);
  console.log(`Background sync interval: ${syncIntervalMs / 60000} minutes`);
});
