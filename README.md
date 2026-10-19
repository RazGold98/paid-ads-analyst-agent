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
