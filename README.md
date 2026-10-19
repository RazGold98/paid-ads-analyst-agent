# paid-ads-analyst-agent

Telegram bot service lives in `apps/agent/`.

## Local setup

```sh
cd apps/agent
npm install
cp .env.example .env   # set TELEGRAM_BOT_TOKEN; leave PUBLIC_URL empty for polling mode
npm run dev
```

Check it: `curl localhost:3000/health`, then send `/start` or `ping` to the bot.

## Deploy

TODO. Build with `npm run build` and run `npm start` with `NODE_ENV=production`,
`PUBLIC_URL` (public HTTPS URL of the service) and `TELEGRAM_WEBHOOK_SECRET` set.
The service registers its webhook at `${PUBLIC_URL}/telegram/webhook` on startup.
