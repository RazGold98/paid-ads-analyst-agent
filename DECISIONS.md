# Decisions

## Assumptions
- Asked Eshkol (my one question) about the mock Meta Ads API mentioned in the brief;
  they confirmed none exists and invited me to build one.
- Built it as a separate deployed service so the pause action is a real call
  to an external system and failures are realistic.
- Mock uses a simple flat schema; messy data is injected as specific,
  documented defects (missing day, duplicate row, null, invalid value,
  prompt-injection in a name) rather than mimicking Meta's full format.
- Data is generated relative to "today" so it stays fresh during the 10-day test window.

## Step 0 – Skeleton & deploy
- Monorepo: apps/agent (+ apps/mock-meta-api next), each deployed as its own Railway service.
- TypeScript/Node: the stack I know best and the stack of the role.
- Telegram: webhook in production (protected by secret_token so only Telegram can call it),
  long-polling locally (no public URL on my laptop). Separate dev/prod bots so local
  development never breaks the deployed bot.
- Config validated with zod at startup → fail fast. This caught a real issue during deploy:
  an invalid NODE_ENV value made the service refuse to start with a clear error,
  instead of failing later at runtime.
- Secrets: .env (gitignored) locally, Railway environment variables in production. Never committed.
- Hosting: Railway (always-on, auto-deploys on push to main). Currently on the trial
  ($5 credit / 30 days); will confirm plan + monthly cost before submitting.
- /health endpoint for basic liveness checks.
