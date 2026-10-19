# Paid Ads Analyst Agent

AI agent that helps a media-buying team understand Meta ad performance, explains what changed,
and pauses ad sets only after explicit human approval.

## Local setup

    cd apps/agent
    npm install
    cp .env.example .env   # DEV bot token; leave PUBLIC_URL empty for polling mode
    npm run dev

## Deploy (Railway)
- Service root directory: `apps/agent`
- Build: `npm run build` · Start: `npm start`
- Environment variables (see `apps/agent/.env.example`):
  - `NODE_ENV=production`
  - `TELEGRAM_BOT_TOKEN` – from @BotFather
  - `PUBLIC_URL` – the service's public HTTPS URL (enables webhook mode)
  - `TELEGRAM_WEBHOOK_SECRET` – random string (A-Z, a-z, 0-9, _ , -)
- `PORT` is set automatically by Railway.
- Health check: `GET /health`

### Mock Meta Ads API (second Railway service)
- Service root directory: `apps/mock-meta-api`
- Build: `npm run build` · Start: `npm start`
- Environment variables (see `apps/mock-meta-api/.env.example`):
  - `NODE_ENV=production`
  - `MOCK_API_TOKEN` – random bearer token; the agent uses the same value
  - `MONGODB_URI` – MongoDB Atlas connection string
  - `MONGODB_DB=mock_meta`
  - `FAIL_PAUSE_ADSET_IDS=as_lookalike` – ad sets whose pause call writes then returns 500
- Scenarios and data defects are documented in `apps/mock-meta-api/SCENARIOS.md`.
