const express = require('express');
const path = require('path');
const db = require('./db');
const { syncAll, scheduleSync } = require('./sync-data');

const app = express();
const port = Number(process.env.PORT || 3000);
const ESPN = { nfl: 'football/nfl', nba: 'basketball/nba', nhl: 'hockey/nhl', mlb: 'baseball/mlb', 'premier-league': 'soccer/eng.1', tennis: 'tennis/atp' };
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sportByKey = db.prepare('SELECT * FROM sports WHERE key=?');
const byName = db.prepare('SELECT p.*,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? AND lower(p.name)=lower(?)');
const byId = db.prepare('SELECT p.*,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.id=?');
const list = db.prepare('SELECT p.id,p.name,p.short_name,p.gender,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? ORDER BY r.rating DESC,p.name');
const insertParticipant = db.prepare('INSERT INTO participants(sport_id,name,short_name) VALUES (?,?,?)');
const insertRating = db.prepare('INSERT INTO ratings(participant_id,rating) VALUES (?,1500)');

function getSport(key, res) { const sport = sportByKey.get(key); if (!sport) { res.status(404).json({ error: `Unknown sport: ${key}` }); return null; } return sport; }
function getParticipant(sport, raw) { const name = String(raw || '').trim().replace(/\s+/g, ' '); if (!name || name.length > 80) return null; const found = byName.get(sport.id, name); if (found) return found; const id = insertParticipant.run(sport.id, name, name).lastInsertRowid; insertRating.run(id); return byId.get(id); }
function eloExpected(a, b) { return 1 / (1 + 10 ** ((b - a) / 400)); }
function prediction(sport, home, away) {
  // Elo is intentionally used only for tennis. Team sports use a separate transparent form baseline.
  const isTennis = sport.key === 'tennis';
  const difference = isTennis ? home.rating - away.rating : (home.rating - away.rating) * 0.72;
  const homeProbability = eloExpected(difference + (isTennis ? 0 : 35), 0);
  if (!sport.supports_draw) return { home: homeProbability, draw: 0, away: 1 - homeProbability, model: isTennis ? 'Tennis Elo' : 'Sport form baseline' };
  const draw = Math.min(0.30, 0.16 + Math.abs(homeProbability - 0.5) * 0.04);
  return { home: (1 - draw) * homeProbability, draw, away: (1 - draw) * (1 - homeProbability), model: isTennis ? 'Tennis Elo' : 'Sport form baseline' };
}
function odds(p) { if (!p) return null; const american = p >= .5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p); return { decimal: Number((1 / p).toFixed(2)), american: american > 0 ? `+${american}` : `${american}` }; }
async function fetchJson(url) { const r = await fetch(url, { headers: { 'user-agent': 'EdgePlay/1.0' } }); if (!r.ok) throw Error(`ESPN returned ${r.status}`); return r.json(); }
function normalizeEvent(event) { const teams = event.competitions?.[0]?.competitors || []; const home = teams.find(x => x.homeAway === 'home') || teams[0]; const away = teams.find(x => x.homeAway === 'away') || teams[1]; const status = event.status?.type || {}; return { id: event.id, name: event.name, date: event.date, state: status.state || 'pre', status: status.shortDetail || status.detail || 'Scheduled', completed: !!status.completed, home: home && { name: home.team?.displayName || home.athlete?.displayName || 'Home', score: home.score ?? '-', logo: home.team?.logo }, away: away && { name: away.team?.displayName || away.athlete?.displayName || 'Away', score: away.score ?? '-', logo: away.team?.logo } }; }
function classifyPlay(play) { const text = String(play.text || play.shortText || '').toLowerCase(); if (/strike|ball four|walk|pitch/.test(text)) return 'baseball'; if (/touchdown|pass complete|interception|quarterback|rush|punt|field goal/.test(text)) return 'football'; if (/goal|shot|save|power play|penalty/.test(text)) return 'hockey'; if (/three pointer|dunk|free throw|rebound|assist|foul/.test(text)) return 'basketball'; if (/goal|shot|corner|yellow card|red card/.test(text)) return 'soccer'; return 'default'; }

app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/sports', (_, res) => res.json(db.prepare('SELECT key,name,kind,supports_draw FROM sports ORDER BY name').all()));
app.get('/api/participants', (req, res) => { const s = getSport(req.query.sport, res); if (s) res.json(list.all(s.id)); });
app.get('/api/leaderboard', (req, res) => { const s = getSport(req.query.sport || 'tennis', res); if (s) res.json({ sport: s.key, participants: list.all(s.id) }); });
app.get('/api/scores', async (req, res) => { const key = req.query.sport || 'nba'; if (!ESPN[key]) return res.status(400).json({ error: 'Unsupported score sport.' }); try { const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${ESPN[key]}/scoreboard`); res.json({ sport: key, updatedAt: new Date().toISOString(), events: (data.events || []).map(normalizeEvent) }); } catch (e) { res.status(502).json({ error: 'Live scores unavailable.', detail: e.message }); } });
app.get('/api/play-by-play', async (req, res) => { const key = req.query.sport || 'nba'; const event = String(req.query.event || ''); if (!ESPN[key] || !event) return res.status(400).json({ error: 'Sport and event are required.' }); try { const data = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${ESPN[key]}/summary?event=${encodeURIComponent(event)}`); const header = data.header?.competitions?.[0]?.competitors || []; res.json({ name: header.map(x => x.team?.displayName || x.athlete?.displayName).join(' vs '), plays: (data.plays || []).slice().reverse().map((p, index) => ({ id: p.id || index, clock: p.clock || '', period: p.period?.number || p.period || '', text: p.text || p.shortText || 'Game update', scoring: !!p.scoring, animation: classifyPlay(p) })) }); } catch (e) { res.status(502).json({ error: 'Play-by-play unavailable.', detail: e.message }); } });
app.get('/api/matches', (req, res) => { const s = getSport(req.query.sport || 'tennis', res); if (!s) return; const rows = db.prepare('SELECT m.id,m.status,h.name home_name,a.name away_name FROM matches m JOIN participants h ON h.id=m.home_participant_id JOIN participants a ON a.id=m.away_participant_id WHERE m.sport_id=? ORDER BY m.id DESC LIMIT 50').all(s.id); res.json(rows.map(x => ({ id: x.id, status: x.status, home: { name: x.home_name }, away: { name: x.away_name } }))); });
app.post('/api/predict', (req, res) => { const s = getSport(req.body?.sport, res); if (!s) return; const home = getParticipant(s, req.body?.home); const away = getParticipant(s, req.body?.away); if (!home || !away || home.id === away.id) return res.status(400).json({ error: 'Enter two different competitors.' }); const p = prediction(s, home, away); const match = db.prepare('INSERT INTO matches(sport_id,home_participant_id,away_participant_id,scheduled_at) VALUES (?,?,?,?)').run(s.id, home.id, away.id, new Date().toISOString()); const id = db.prepare('INSERT INTO predictions(match_id,sport_id,home_probability,draw_probability,away_probability,model_version) VALUES (?,?,?,?,?,?)').run(match.lastInsertRowid, s.id, p.home, p.draw, p.away, s.key === 'tennis' ? 'tennis-elo' : 'sport-form').lastInsertRowid; res.json({ id, matchId: match.lastInsertRowid, sport: s.key, home: home.name, away: away.name, probabilities: p, odds: { home: odds(p.home), draw: odds(p.draw), away: odds(p.away) }, model: p.model }); });
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(port, () => { console.log(`EdgePlay listening on ${port}`); syncAll().catch(console.error); scheduleSync(Math.max(5, Number(process.env.SYNC_INTERVAL_MINUTES || 30)) * 60000); });
