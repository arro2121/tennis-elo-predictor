# Multi-Sport Elo Predictor

A real SQLite-backed web app for Elo predictions across:

- Tennis
- NFL
- NHL
- MLB
- NBA
- Premier League

## Run locally

Requirements: Node.js 18+

```bash
npm install
npm start
```

Open http://localhost:3000. The database is created automatically at `data/predictions.sqlite` and is intentionally ignored by Git.

## What is included

- SQLite schema for sports, participants, ratings, matches, and predictions
- Seed participants for all six sports
- Generic Elo rating engine with sport-specific K factors
- Home advantage for team sports
- Draw probabilities for NHL and Premier League
- Saved predictions and match results
- Responsive browser UI
- REST API

## API examples

```bash
curl http://localhost:3000/api/sports
curl 'http://localhost:3000/api/participants?sport=nba'
curl -X POST http://localhost:3000/api/predict \
  -H 'content-type: application/json' \
  -d '{"sport":"tennis","home":"Novak Djokovic","away":"Carlos Alcaraz"}'
```

To add real data, load provider data into the `participants` and `matches` tables, then call the prediction endpoint before a match and `/api/matches/:id/result` after it finishes. Do not claim predictions are guaranteed; add provider licensing, authentication, validation, and rate limiting before production use.

## Elo notes

The initial seed ratings are 1500 because they are demo participants, not official ratings. Replace them with historical ratings/results or import match history and replay it chronologically to create meaningful ratings. Random train/test splitting should not be used for sports time series.
