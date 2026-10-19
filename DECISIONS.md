# Decisions

## Assumptions
- Asked Eshkol (my one question) about the mock Meta Ads API mentioned in the brief;
  they confirmed none exists and invited me to build one.
- Built it as a separate deployed service so the pause action is a real call
  to an external system and failures are realistic.
- Mock uses a simple flat schema; messy data is injected as specific,
  documented defects rather than mimicking Meta's full format.
- Data rows are stored as "days ago" and mapped to real dates on each request, so the data stays fresh during the 10-day test window.

## Step 0 – Skeleton & deploy
- Monorepo: apps/agent + apps/mock-meta-api, each deployed as its own Railway service.
- TypeScript/Node: the stack I know best and the stack of the role.
- Telegram: webhook in production (protected by secret_token so only Telegram can call it),
  long-polling locally (no public URL on my laptop). Separate dev/prod bots so local
  development never breaks the deployed bot.
- Config validated with zod at startup → fail fast. This caught a real issue during deploy:
  an invalid NODE_ENV value made the service refuse to start with a clear error.
- Secrets: .env (gitignored) locally, Railway environment variables in production. Never committed.
- Hosting: Railway (always-on, auto-deploys on push to main). Currently on the trial
  ($5 credit / 30 days); will confirm plan + monthly cost before submitting.

## Step 1 – Mock Meta Ads API
- Separate service with bearer-token auth: pausing an ad set is a real network call to an external system.
- The data is a static, human-readable fixture (src/data/insights.fixture.json): 6 ad sets x 30 days.
  Rows are keyed by "days_ago" and mapped to real dates at request time, so the data always ends
  yesterday and stays fresh during the 10-day test window, while staying fully deterministic for evals.
- I first generated the data at runtime from scenario formulas, then replaced it with a static fixture:
  same numbers, but anyone can open the file and see exactly what the API returns.
- Planted scenarios with known correct interpretations (apps/mock-meta-api/SCENARIOS.md):
  creative fatigue, healthy winner, budget burner, small sample, tracking outage,
  and a prompt-injection string inside an ad set name.
- Deliberate data defects written directly into the fixture (missing day, duplicate row, null value,
  negative spend, number as string) so the agent's data-cleaning layer has real work to do.
- Only ad set statuses are persisted (MongoDB Atlas); insights come from the fixture,
  so there is nothing to keep in sync.
- Status changes require an Idempotency-Key, so a retry after a failure never applies an action twice.
- Failure injection (FAIL_PAUSE_ADSET_IDS) applies the change and then returns 500, to exercise the
  "failed halfway" path where the client must verify the real state instead of trusting the error.
- Atlas IP access is 0.0.0.0/0 because Railway has no static egress IP; access is protected by
  DB credentials, and the mock itself by a bearer token.

  ## Steps 2–3 – Data layer (client, cleaning, metrics, tools)
- Read-only API client: 8s timeout, retries (x2) only for GET on network errors, timeouts and 5xx;
  never on 4xx. Writes are not retried blindly — the pause action (step 6) uses an Idempotency-Key.
- Responses are validated with zod but permissively: numeric strings are accepted and reported by the
  cleaning layer instead of failing the whole request. Non-numeric strings are rejected.
- Cleaning never invents data: unknown or impossible values (null conversion value, negative spend)
  become null, not 0; missing days are reported, not filled; duplicates keep the first row.
  Every problem is returned as a DataIssue (what happened + what was done) so the agent can explain it.
- Tracking outage: flagged only when ≥ 2 ad sets on the same date all have 0 conversions despite clicks.
  One ad set at zero is a bad day, not evidence. Outage dates still count toward spend, impressions and
  clicks, but are excluded from conversions, conversion value, CPA and ROAS.
- Tools fetch the whole account and filter afterwards: an outage is only visible across all ad sets.
- Each ratio uses only rows where all its inputs are known, for numerator and denominator alike
  (e.g. a day with unknown spend is excluded from both sides of CPA). Division by zero returns null.
- Low sample: fewer than 10 conversions sets lowSample. A simple rule of thumb, not a statistical test;
  it is a hint for the agent, not an automatic decision.
- Rounding only in tool output (money 2 decimals, CTR/ROAS 4, % change 1); all math is unrounded.
- Requested dates are clamped to the 30-day window the API serves. comparePeriods is capped at 15 days
  so both periods are equal length; the days actually used are returned in the result.
- Every tool returns { result, issues, sources }, so a number never reaches the agent without its
  data problems and the endpoint it came from.

