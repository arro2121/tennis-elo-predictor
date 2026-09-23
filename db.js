const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'predictions.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sports (id INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('individual','team')),supports_draw INTEGER NOT NULL DEFAULT 0,k_factor REAL NOT NULL DEFAULT 32);
CREATE TABLE IF NOT EXISTS participants (id INTEGER PRIMARY KEY AUTOINCREMENT,sport_id INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,name TEXT NOT NULL,short_name TEXT,external_id TEXT,gender TEXT,UNIQUE(sport_id,name));
CREATE TABLE IF NOT EXISTS ratings (participant_id INTEGER PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,rating REAL NOT NULL DEFAULT 1500,matches_played INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS matches (id INTEGER PRIMARY KEY AUTOINCREMENT,sport_id INTEGER NOT NULL REFERENCES sports(id),home_participant_id INTEGER NOT NULL REFERENCES participants(id),away_participant_id INTEGER NOT NULL REFERENCES participants(id),scheduled_at TEXT,status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','final')),home_score REAL,away_score REAL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,CHECK(home_participant_id <> away_participant_id));
CREATE TABLE IF NOT EXISTS predictions (id INTEGER PRIMARY KEY AUTOINCREMENT,match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,sport_id INTEGER NOT NULL REFERENCES sports(id),home_probability REAL NOT NULL,draw_probability REAL NOT NULL DEFAULT 0,away_probability REAL NOT NULL,predicted_home_score REAL,predicted_away_score REAL,model_version TEXT NOT NULL DEFAULT 'elo-v2',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_participants_sport ON participants(sport_id);
CREATE INDEX IF NOT EXISTS idx_matches_sport_date ON matches(sport_id,scheduled_at);
CREATE INDEX IF NOT EXISTS idx_predictions_match ON predictions(match_id,created_at);
`);

try { db.exec('ALTER TABLE participants ADD COLUMN gender TEXT'); } catch (error) { if (!String(error.message).includes('duplicate column')) throw error; }

const sports = [['tennis','Tennis','individual',0,32],['nfl','NFL','team',0,28],['nhl','NHL','team',1,24],['mlb','MLB','team',0,20],['nba','NBA','team',0,24],['premier-league','Premier League','team',1,24]];
const addSport = db.prepare('INSERT OR IGNORE INTO sports(key,name,kind,supports_draw,k_factor) VALUES (?,?,?,?,?)');
for (const sport of sports) addSport.run(...sport);
const seed = { tennis:['Novak Djokovic','Carlos Alcaraz','Jannik Sinner','Iga Swiatek','Aryna Sabalenka','Coco Gauff'], nfl:['Kansas City Chiefs','Buffalo Bills'], nhl:['Boston Bruins','Colorado Avalanche'], mlb:['Los Angeles Dodgers','New York Yankees'], nba:['Boston Celtics','Denver Nuggets'], 'premier-league':['Arsenal','Liverpool'] };
const findSport = db.prepare('SELECT id FROM sports WHERE key=?');
const addParticipant = db.prepare('INSERT OR IGNORE INTO participants(sport_id,name,short_name) VALUES (?,?,?)');
const addRating = db.prepare('INSERT OR IGNORE INTO ratings(participant_id,rating) VALUES (?,1500)');
for (const [key,names] of Object.entries(seed)) { const sport = findSport.get(key); for (const name of names) { const result = addParticipant.run(sport.id,name,name); const participant = result.changes ? {id:result.lastInsertRowid} : db.prepare('SELECT id FROM participants WHERE sport_id=? AND name=?').get(sport.id,name); addRating.run(participant.id); } }
module.exports = db;
