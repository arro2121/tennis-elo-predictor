# EdgePlay Sports Lab

A publishable sports-fan app for matchup analysis, live scores, ESPN play-by-play, and lightweight interactive games.

## Features

- Light, responsive sports-dashboard UI
- Tennis predictions use Elo only
- NFL, NBA, NHL, MLB, and Premier League use a separate transparent form baseline
- ESPN live-score feed with selectable league
- ESPN play-by-play feed with sport-specific animated event classes
- ATP/WTA ranking and team roster refresh through the existing sync job
- Browser-based arcade score stored locally
- Health endpoint for Render

## Deploy to Render

The repository includes `render.yaml`. In Render, create a new Blueprint and select this repository, or create a Web Service with:

- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Environment variable: `SYNC_INTERVAL_MINUTES=30`

## Local development

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Data and model notes

ESPN endpoints used here are public feeds and may change or rate-limit access. Cache and request behavior should be reviewed before heavy public traffic. Fair odds are mathematical model outputs and are not sportsbook odds. The app does not provide gambling advice.

The free Render filesystem is ephemeral. SQLite is suitable for a demo, but production persistence requires a managed PostgreSQL database or a persistent disk.

## API

- `GET /api/health`
- `GET /api/sports`
- `GET /api/participants?sport=nba`
- `GET /api/scores?sport=nba`
- `GET /api/play-by-play?sport=nba&event=EVENT_ID`
- `POST /api/predict`

Example prediction request:

```json
{
  "sport": "tennis",
  "home": "Novak Djokovic",
  "away": "Carlos Alcaraz"
}
```
