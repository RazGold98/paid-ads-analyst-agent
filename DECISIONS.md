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
- Monorepo: apps/agent + apps/mock-meta-api, each deployed as its own Railway service.
- TypeScript/Node: the stack I know best and the stack of the role.
- Webhook in production (protected by secret_token), polling locally; separate dev/prod bots so they don't conflict.
- Config validated with zod at startup → fail fast with a clear error instead of failing mid-request.
- Secrets live only in .env (gitignored) locally and in Railway environment variables in production.
- Hosting: Railway (always-on, deploys from GitHub). 
