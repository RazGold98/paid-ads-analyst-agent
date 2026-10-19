# AI usage
How I used AI tools during the build, what I verified myself, and where I chose differently.

## Approach
- I wrote the specs (structure, scenarios, data rules, failure behaviour) and used Claude Code to
  implement them. Every generated file was reviewed before committing.
- I used an AI assistant as a sounding board for design trade-offs and deployment setup.
- Anything that affects correctness (data, scenarios, failure paths) was verified by tests and by
  calling the deployed services directly.

## Step 0 – Skeleton & deploy
- Delegated: project scaffolding (config validation, bot, health endpoint, entry point).
- Verified: config fail-fast behaviour, webhook vs. polling modes, and the deployed bot end to end.
- Corrected: the generated .gitignore did not exclude OS files (.DS_Store); fixed in a follow-up commit.

## Step 1 – Mock Meta Ads API
- Delegated: implementation of the mock service and its tests from my spec.
- Chose differently: the AI suggested mirroring Meta's exact response format (numbers as strings,
  nested actions[] arrays). I chose a simple flat schema plus a small set of explicit, documented defects.
- Chose differently: the first version computed the data at runtime from scenario formulas (seeded
  random numbers). It worked, but it was harder to read and explain than it needed to be for a test
  fixture. I replaced it with a static JSON fixture (same data), keeping only the days_ago -> date mapping.
- Verified: 30-day rolling window, scenario shapes (fatigue, burner, outage), each injected defect,
  idempotent replay, and the write-then-500 failure path, both locally and on Railway.

  ## Steps 2–3 – Data layer

- Verified: each planted defect and scenario against the deployed mock via a smoke script
  (npm run check:data): fatigue, burner, winner, small sample, tracking outage.
- Corrected: the outage issue told the user that outage days were excluded from CPA and ROAS, but the
  metrics still included them. I made the metrics match the report and added tests for it.
- Corrected: comparePeriods with more than 15 days silently compared a full current period against a
  truncated previous one (e.g. 20 vs 10 days). Found in code review; capped at 15 and added a test.
- Chose differently: per-ad-set fetching was simpler, but it cannot detect an account-wide tracking
  outage, so tools fetch the whole account and filter in code.

## Step 6 – Pause with human approval

- Verified: 13 unit tests for every path, including the "failed halfway" case, double approval,
  expiry and non-approvers. Then an end-to-end run against the real MongoDB and mock API (two concurrent
  approvals executed once; the injected 500-after-write was reported as paused), and the full flow in
  the production bot, confirmed in the production audit log.
- Corrected (found during deployment): new required variables were pushed before they existed in
  Railway, so the deploy refused to start (MONGODB_URI: Required). The fail-fast config made the cause
  obvious; I added the variable and redeployed.
- Chose differently: the AI suggested a separate "approved" state and a background job for expiry.
  I kept an atomic pending → executing transition and checked expiry on click, which is less code
  with the same safety.
