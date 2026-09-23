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
const participantById = db.prepare('SELECT p.*, r.rating, r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.id=?');
const participantByName = db.prepare('SELECT p.*, r.rating, r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? AND lower(p.name)=lower(?)');
const participantList = db.prepare('SELECT p.id,p.name,p.short_name,p.gender,r.rating,r.matches_played FROM participants p JOIN ratings r ON r.participant_id=p.id WHERE p.sport_id=? ORDER BY r.rating DESC,p.name');
const createParticipant = db.prepare('INSERT INTO participants(sport_id,name,short_name) VALUES (?,?,?)');
const createRating = db.prepare('INSERT INTO ratings(participant_id,rating) VALUES (?,1500)');

const ESPN_PATHS = { nfl:'football/nfl', nba:'basketball/nba', nhl:'hockey/nhl', mlb:'baseball/mlb', 'premier-league':'soccer/eng.1', tennis:'tennis/atp' };

function sportOr404(key,res){const sport=sportByKey.get(key);if(!sport){res.status(404).json({error:`Unknown sport: ${key}`});return null;}return sport;}
function expected(a,b){return 1/(1+Math.pow(10,(b-a)/400));}
function cleanName(value){return String(value||'').trim().replace(/\s+/g,' ');}
function getOrCreate(sport,raw){const name=cleanName(raw);if(!name||name.length>80)return null;const existing=participantByName.get(sport.id,name);if(existing)return existing;const id=createParticipant.run(sport.id,name,name).lastInsertRowid;createRating.run(id);return participantById.get(id);}
function probabilities(sport,home,away){const homeP=expected(home.rating+(sport.key==='tennis'?0:35),away.rating);if(!sport.supports_draw)return{home:homeP,draw:0,away:1-homeP};const draw=Math.min(.3,.16+Math.abs(homeP-.5)*.04);return{home:(1-draw)*homeP,draw,away:(1-draw)*(1-homeP)};}
function odds(p){if(!p)return null;const a=p>=.5?-Math.round(100*p/(1-p)):Math.round(100*(1-p)/p);return{decimal:Number((1/p).toFixed(2)),american:a>0?`+${a}`:`${a}`};}
function stats(s,p){const rating=Math.round(p.rating),form=Math.max(40,Math.min(95,Math.round(55+(rating-1500)/10))),metric=(o=0)=>Math.max(40,Math.min(96,Math.round(68+(rating-1500)/8+o)));if(s.key==='tennis')return{rating,matchesPlayed:p.matches_played||0,form,serve:metric(2),return:metric(-1),winRate:Math.max(35,Math.min(82,Math.round(50+(rating-1500)/12)))};if(s.key==='nfl')return{rating,matchesPlayed:p.matches_played||0,form,offense:metric(2),defense:metric(),efficiency:metric(-2)};if(s.key==='nhl')return{rating,matchesPlayed:p.matches_played||0,form,attack:metric(1),defense:metric(),goaltending:metric(3)};if(s.key==='mlb')return{rating,matchesPlayed:p.matches_played||0,form,offense:metric(2),pitching:metric(),depth:metric(-2)};if(s.key==='nba')return{rating,matchesPlayed:p.matches_played||0,form,offense:metric(3),defense:metric(),tempo:metric(-2)};return{rating,matchesPlayed:p.matches_played||0,form,attack:metric(2),defense:metric(),control:metric(-2)};}
async function fetchJson(url){const r=await fetch(url,{headers:{'user-agent':'EdgePlay/1.0'}});if(!r.ok)throw new Error(`ESPN returned ${r.status}`);return r.json();}
function scoreEvent(event){const c=event.competitions?.[0],teams=c?.competitors||[],home=teams.find(x=>x.homeAway==='home')||teams[0],away=teams.find(x=>x.homeAway==='away')||teams[1],status=event.status?.type||{};return{id:event.id,name:event.name,date:event.date,league:event.league?.name||event.season?.name||'',state:status.state||'pre',status:status.shortDetail||status.detail||'Scheduled',completed:Boolean(status.completed),clock:status.displayClock||null,period:status.period||null,home:home?{name:home.team?.displayName||home.athlete?.displayName||'Home',score:home.score??'-',winner:Boolean(home.winner),logo:home.team?.logo||null}:null,away:away?{name:away.team?.displayName||away.athlete?.displayName||'Away',score:away.score??'-',winner:Boolean(away.winner),logo:away.team?.logo||null}:null};}
function playItem(play){return{id:play.id||`${play.sequenceNumber}-${play.text}`,text:play.text||play.shortText||'Game update',description:play.description||'',clock:play.clock||null,period:play.period?.number||play.period||null,scoring:!!play.scoring,scoreValue:play.scoreValue||null,type:play.type?.text||''};}

app.get('/api/health',(_,res)=>res.json({ok:true}));
app.get('/api/sports',(_,res)=>res.json(db.prepare('SELECT key,name,kind,supports_draw FROM sports ORDER BY name').all()));
app.get('/api/participants',(req,res)=>{const s=sportOr404(req.query.sport,res);if(!s)return;res.json(participantList.all(s.id));});
app.get('/api/leaderboard',(req,res)=>{const s=sportOr404(req.query.sport||'tennis',res);if(!s)return;res.json({sport:s.key,participants:participantList.all(s.id)});});

app.get('/api/scores',async(req,res)=>{const key=req.query.sport||'nba';if(!ESPN_PATHS[key])return res.status(400).json({error:'Unsupported live-score sport.'});try{const data=await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATHS[key]}/scoreboard`);res.json({sport:key,updatedAt:new Date().toISOString(),events:(data.events||[]).map(scoreEvent)});}catch(e){res.status(502).json({error:'Live scores are temporarily unavailable.',detail:e.message});}});
app.get('/api/play-by-play',async(req,res)=>{const key=req.query.sport||'nba',eventId=String(req.query.event||'');if(!ESPN_PATHS[key]||!eventId)return res.status(400).json({error:'A sport and ESPN event id are required.'});try{const data=await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${ESPN_PATHS[key]}/summary?event=${encodeURIComponent(eventId)}`);const event=data.header?.competitions?.[0]||data.header||{};res.json({sport:key,eventId,updatedAt:new Date().toISOString(),name:data.header?.competitions?.[0]?.competitors?data.header.competitions[0].competitors.map(x=>x.team?.displayName||x.athlete?.displayName).join(' vs '):'',plays:(data.plays||[]).slice(-100).reverse().map(playItem),leaders:data leaders||[]});}catch(e){res.status(502).json({error:'Play-by-play is temporarily unavailable.',detail:e.message});}});

app.get('/api/matches',(req,res)=>{const s=sportOr404(req.query.sport||'tennis',res);if(!s)return;const rows=db.prepare('SELECT m.*,h.id home_id,h.name home_name,rh.rating home_rating,a.id away_id,a.name away_name,ra.rating away_rating FROM matches m JOIN participants h ON h.id=m.home_participant_id JOIN ratings rh ON rh.participant_id=h.id JOIN participants a ON a.id=m.away_participant_id JOIN ratings ra ON ra.participant_id=a.id WHERE m.sport_id=? ORDER BY m.id DESC LIMIT 50').all(s.id);res.json(rows.map(r=>({id:r.id,status:r.status,home:{id:r.home_id,name:r.home_name,rating:r.home_rating},away:{id:r.away_id,name:r.away_name,rating:r.away_rating}})));});
app.post('/api/predict',(req,res)=>{const s=sportOr404(req.body?.sport,res);if(!s)return;const h=getOrCreate(s,req.body?.home),a=getOrCreate(s,req.body?.away);if(!h||!a||h.id===a.id)return res.status(400).json({error:'Enter two different names.'});const p=probabilities(s,h,a);const match=db.prepare('INSERT INTO matches(sport_id,home_participant_id,away_participant_id,scheduled_at) VALUES (?,?,?,?)').run(s.id,h.id,a.id,new Date().toISOString());const saved=db.prepare('INSERT INTO predictions(match_id,sport_id,home_probability,draw_probability,away_probability,model_version) VALUES (?,?,?,?,?,?)').run(match.lastInsertRowid,s.id,p.home,p.draw,p.away,s.key==='tennis'?'tennis-elo-v3':'form-model-v1');res.json({id:saved.lastInsertRowid,matchId:match.lastInsertRowid,sport:s.key,home:{name:h.name,gender:h.gender,stats:stats(s,h)},away:{name:a.name,gender:a.gender,stats:stats(s,a)},probabilities:p,odds:{home:odds(p.home),draw:odds(p.draw),away:odds(p.away)},confidence:Math.round(Math.min(96,52+Math.abs(p.home-p.away)*90)),model:s.key==='tennis'?'Tennis Elo':'Sports form model'});});
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(port,()=>{console.log(`EdgePlay listening on port ${port}`);syncAll().catch(console.error);scheduleSync(syncMinutes*60000);});
