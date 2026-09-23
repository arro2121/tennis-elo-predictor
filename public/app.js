const $ = (id) => document.getElementById(id);
let participants = [];

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

function fillSports(list) {
  const html = list.map((s) => `<option value="${s.key}">${s.name}</option>`).join('');
  $('sport').innerHTML = html;
  $('board-sport').innerHTML = html;
}

async function loadParticipants() {
  participants = await api(`/api/participants?sport=${encodeURIComponent($('sport').value)}`);

  const options = participants.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');
  $('home-options').innerHTML = options;
  $('away-options').innerHTML = options;

  if (participants.length > 1) {
    $('home').value = participants[0].name;
    $('away').value = participants[1].name;
  }

  await Promise.all([loadBoard(), loadMatches()]);
}

async function loadBoard() {
  const sport = $('board-sport').value;
  const data = await api(`/api/leaderboard?sport=${encodeURIComponent(sport)}`);

  $('leaderboard').innerHTML = data.participants.slice(0, 8).map((p, i) => `
    <div class="leader-row">
      <span class="rank">${String(i + 1).padStart(2, '0')}</span>
      <span class="competitor">${p.name}<small>${p.matches_played} matches</small></span>
      <strong>${Math.round(p.rating)}</strong>
    </div>
  `).join('');
}

async function loadMatches() {
  const sport = $('sport').value;
  const list = await api(`/api/matches?sport=${encodeURIComponent(sport)}`);

  $('matches').innerHTML = list.length
    ? list.slice(0, 7).map((m) => `
        <div class="history-row">
          <span>${m.home.name}<b> vs </b>${m.away.name}</span>
          <small>${m.status}</small>
        </div>
      `).join('')
    : '<p class="muted">No analyses yet for this sport.</p>';
}

function formatOdds(o) {
  if (!o) return '—';
  return `${o.decimal} (${o.american})`;
}

function statRows(a, b, sport) {
  const map = {
    tennis: [
      ['Serve', 'serve'],
      ['Return', 'return'],
      ['Form', 'form'],
      ['Win rate', 'winRate']
    ],
    nfl: [
      ['Offense', 'offense'],
      ['Defense', 'defense'],
      ['Form', 'form'],
      ['Efficiency', 'efficiency']
    ],
    nhl: [
      ['Attack', 'attack'],
      ['Defense', 'defense'],
      ['Form', 'form'],
      ['Goaltending', 'goaltending']
    ],
    mlb: [
      ['Offense', 'offense'],
      ['Pitching', 'pitching'],
      ['Form', 'form'],
      ['Depth', 'depth']
    ],
    nba: [
      ['Offense', 'offense'],
      ['Defense', 'defense'],
      ['Form', 'form'],
      ['Tempo', 'tempo']
    ],
    'premier-league': [
      ['Attack', 'attack'],
      ['Defense', 'defense'],
      ['Form', 'form'],
      ['Control', 'control']
    ]
  };

  const fields = map[sport] || map.tennis;

  return fields.map(([label, key]) => `
    <div class="stat-row">
      <div class="stat-label">${label}</div>
      <div class="stat-bars">
        <span>${a.stats[key] ?? 0}</span>
        <div class="bar-track"><i style="width:${(a.stats[key] ?? 0)}%"></i></div>
        <div class="bar-track reverse"><i style="width:${(b.stats[key] ?? 0)}%"></i></div>
        <span>${b.stats[key] ?? 0}</span>
      </div>
    </div>
  `).join('');
}

function renderResult(data) {
  $('empty').classList.add('hidden');
  $('results').classList.remove('hidden');

  const p = data.probabilities;
  const showDraw = !!p.draw;

  $('results').innerHTML = `
    <div class="result-head">
      <div>
        <span class="eyebrow">MATCHUP REPORT · ${data.sport.toUpperCase()}</span>
        <h2>${data.home.name} <span>vs</span> ${data.away.name}</h2>
      </div>
      <div class="confidence">
        ${data.confidence}%
        <small>confidence</small>
      </div>
    </div>

    <div class="prob-grid">
      <div class="prob-card featured">
        <span>${data.home.name}</span>
        <strong>${pct(p.home)}</strong>
        <small>win probability</small>
        <b>Fair ${formatOdds(data.odds.home)}</b>
      </div>

      ${showDraw ? `
        <div class="prob-card">
          <span>Draw</span>
          <strong>${pct(p.draw)}</strong>
          <small>probability</small>
          <b>Fair ${formatOdds(data.odds.draw)}</b>
        </div>
      ` : ''}

      <div class="prob-card">
        <span>${data.away.name}</span>
        <strong>${pct(p.away)}</strong>
        <small>win probability</small>
        <b>Fair ${formatOdds(data.odds.away)}</b>
      </div>
    </div>

    <div class="stats-card">
      <div class="stats-title">
        <span>COMPARATIVE STATS</span>
        <small>Elo rating · ${data.home.name} vs ${data.away.name}</small>
      </div>

      <div class="rating-line">
        <b>${data.home.stats.rating}</b>
        <span>ELO RATING</span>
        <b>${data.away.stats.rating}</b>
      </div>

      ${statRows(data.home, data.away, data.sport)}
    </div>
  `;
}

$('sport').addEventListener('change', loadParticipants);
$('board-sport').addEventListener('change', loadBoard);

$('swap').addEventListener('click', () => {
  const x = $('home').value;
  $('home').value = $('away').value;
  $('away').value = x;
});

$('predict').addEventListener('click', async () => {
  const button = $('predict');
  const label = button.querySelector('span');
  label.textContent = 'Analyzing…';
  button.disabled = true;

  try {
    const result = await api('/api/predict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sport: $('sport').value,
        home: $('home').value,
        away: $('away').value
      })
    });

    renderResult(result);
    await loadParticipants();
  } catch (error) {
    alert(error.message);
  } finally {
    label.textContent = 'Run matchup analysis';
    button.disabled = false;
  }
});

(async () => {
  try {
    const sports = await api('/api/sports');
    fillSports(sports);
    await loadParticipants();
  } catch (error) {
    $('empty').innerHTML = `<h2>Could not load the model</h2><p>${error.message}</p>`;
  }
})();
