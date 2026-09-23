const express = require('express');
const path = require('path');
const db = require('./db');
const { syncAll } = require('./sync-data');
const app = express();
const port = Number(process.env.PORT || 3000);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const sportByKey = db.prepare('SELECT * FROM sports WHERE key=?');
const participantById = db.prepare('SELECT p.*,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.id=?');
const participantByName = db.prepare('SELECT p.*,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? AND lower(p.name)=lower(?)');
const participantList = db.prepare('SELECT p.id,p.name,p.short_name,p.gender,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? ORDER BY r.rating DESC,p.name');
const createParticipant = db.prepare('INSERT INTO participants(sport_id,name,short_name) VALUES (?,?,?)');
const createRating = db.prepare('INSERT INTO ratings(participant_id,rating) VALUES (?,1500)');
function sportOr404(key,res){const sport=sportByKey.get(key);if(!sport){res.status(404).json({error:`Unknown sport: ${key}`});return null;}return sport;}
function expected(a,b){return 1/(1+Math.pow(10,(b-a)/400));}
function cleanName(v){return String(v||'').trim().replace(/\s+/g,' ');}
function getOrCreate(sport,raw){const name=cleanName(raw);if(!name||name.length>80)return null;let p=participantByName.get(sport.id,name);if(p)return p;const id=createParticipant.run(sport.id,name,name).lastInsertRowid;createRating.run(id);return participantById.get(id);}
function probabilities(sport,h,a){const homeP=expected(h.rating+(sport.key==='tennis'?0:35),a.rating);if(!sport.supports_draw)return{home:homeP,draw:0,away:1-homeP};const draw=Math.min(.3,.16+Math.abs(homeP-.5)*.04);return{home:(1-draw)*homeP,draw,away:(1-draw)*(1-homeP)};}
function odds(p){if(!p)return null;const american=p>=.5?-Math.round(100*p/(1-p)):Math.round(100*(1-p)/p);return{decimal:Number((1/p).toFixed(2)),american:american>0?`+${american}`:`${american}`};}
function profile(s,p){const rating=Math.round(p.rating),matchesPlayed=p.matches_played||0,form=Math.max(40,Math.min(95,Math.round(55+(rating-1500)/10)));const stat=(offset=0)=>Math.max(40,Math.min(96,Math.round(68+(rating-1500)/8+offset)));if(s.key==='tennis')return{rating,matchesPlayed,form,serve:stat(2),return:stat(-1),winRate:Math.max(35,Math.min(82,Math.round(50+(rating-1500)/12))),surface:stat(-3)};if(s.key==='nfl')return{rating,matchesPlayed,form,offense:stat(2),defense:stat(),efficiency:stat(-2)};if(s.key==='nhl')return{rating,matchesPlayed,form,attack:stat(1),defense:stat(),goaltending:stat(3)};if(s.key==='mlb')return{rating,matchesPlayed,form,offense:stat(2),pitching:stat(),depth:stat(-2)};if(s.key==='nba')return{rating,matchesPlayed,form,offense:stat(3),defense:stat(),tempo:stat(-2)};return{rating,matchesPlayed,form,attack:stat(2),defense:stat(),control:stat(-2)};}
app.get('/api/health',(_,res)=>res.json({ok:true}));
app.get('/api/sports',(_,res)=>res.json(db.prepare('SELECT key,name,kind,supports_draw FROM sports ORDER BY name').all()));
app.get('/api/sync',async(_,res)=>{res.status(202).json({ok:true,message:'Data refresh started'});syncAll().then(r=>console.log('Data refresh',r)).catch(console.error);});
app.get('/api/participants',(req,res)=>{const s=sportOr404(req.query.sport,res);if(!s)return;res.json(participantList.all(s.id));});
app.post('/api/participants',(req,res)=>{const s=sportOr404(req.body?.sport,res);if(!s)return;const p=getOrCreate(s,req.body?.name);if(!p)return res.status(400).json({error:'Enter a valid name up to 80 characters.'});res.status(201).json({...p,stats:profile(s,p)});});
app.get('/api/leaderboard',(req,res)=>{const s=sportOr404(req.query.sport||'tennis',res);if(!s)return;res.json({sport:s.key,participants:participantList.all(s.id)});});
app.get('/api/matches',(req,res)=>{const s=sportOr404(req.query.sport||'tennis',res);if(!s)return;const rows=db.prepare('SELECT m.*,h.id home_id,h.name home_name,rh.rating home_rating,a.id away_id,a.name away_name,ra.rating away_rating FROM matches m JOIN participants h ON h.id=m.home_participant_id JOIN ratings rh ON rh.participant_id=h.id JOIN participants a ON a.id=m.away_participant_id JOIN ratings ra ON ra.participant_id=a.id WHERE m.sport_id=? ORDER BY m.id DESC LIMIT 50').all(s.id);res.json(rows.map(r=>({id:r.id,status:r.status,home:{id:r.home_id,name:r.home_name,rating:r.home_rating},away:{id:r.away_id,name:r.away_name,rating:r.away_rating}})));});
app.post('/api/predict',(req,res)=>{const s=sportOr404(req.body?.sport,res);if(!s)return;const h=getOrCreate(s,req.body?.home),a=getOrCreate(s,req.body?.away);if(!h||!a||h.id===a.id)return res.status(400).json({error:'Enter two different names.'});const p=probabilities(s,h,a);const match=db.prepare('INSERT INTO matches(sport_id,home_participant_id,away_participant_id,scheduled_at) VALUES (?,?,?,?)').run(s.id,h.id,a.id,new Date().toISOString());const saved=db.prepare('INSERT INTO predictions(match_id,sport_id,home_probability,draw_probability,away_probability,model_version) VALUES (?,?,?,?,?,?)').run(match.lastInsertRowid,s.id,p.home,p.draw,p.away,'elo-v3');const confidence=Math.round(Math.min(96,52+Math.abs(p.home-p.away)*90));res.json({id:saved.lastInsertRowid,matchId:match.lastInsertRowid,sport:s.key,home:{name:h.name,gender:h.gender,stats:profile(s,h)},away:{name:a.name,gender:a.gender,stats:profile(s,a)},probabilities:p,odds:{home:odds(p.home),draw:odds(p.draw),away:odds(p.away)},confidence,model:'Elo v3'});});
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(port,()=>{console.log(`EdgePlay listening on port ${port}`);syncAll().then(r=>console.log('Initial data refresh',r)).catch(console.error);});
