# EdgePlay Sports Lab

EdgePlay is a bright, responsive sports-fan experience for matchup analysis, live scores, ESPN play-by-play, and quick interactive games.

## Models

- **Tennis:** Elo probability model only.
- **NFL, NBA, NHL, MLB, Premier League:** transparent team form/power baseline, not Elo.
- **Odds:** theoretical fair odds generated from model probabilities; not sportsbook odds.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Render deployment

The repository includes `render.yaml`. You can deploy it as a Blueprint, or configure a Node Web Service with:

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/health`
- `SYNC_INTERVAL_MINUTES=30`

## Public data

The app uses public ESPN feeds for scores and play-by-play and public ATP/WTA/team sources for roster synchronization. These feeds can change or rate-limit requests; the app uses short server-side caching for score endpoints. Review the provider's terms before operating at scale.

## Production notes

The free Render filesystem is ephemeral. SQLite is convenient for a demo, but persistent public use should move ratings, predictions, and user data to managed PostgreSQL. Add authentication, a real reverse-proxy rate limiter, monitoring, and provider-approved data access before commercial launch.

Predictions are informational estimates, not guarantees or gambling advice.
