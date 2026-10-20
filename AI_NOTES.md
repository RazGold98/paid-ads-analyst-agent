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

## Steps 4–5 – LLM agent + Telegram
- Verified: every planted scenario from the terminal (npm run ask) and in the production bot:
  fatigue, burner, winner, small sample, missing day, tracking outage, prompt injection, Hebrew
  questions and follow-ups.
- Corrected (found while testing the scenarios): for "which ad set is wasting money?" the model chose a
  30-day window, where the budget burner still looked acceptable, and missed the recent problem. Added a
  rule: default to 7 days and compare with the previous period.
- Corrected: the model called an ad set that spent $1,900 for 9 conversions "too small a sample to
  conclude". Refined the rule: a low sample means "too early" for good results, but high spend with few
  conversions is itself evidence.
- Corrected: the model computed an account ROAS itself and got it wrong (2.39 vs 2.44 from the tool),
  while labelling it as its own calculation. It is now told never to compute totals and to take them
  from a tool. A number in an answer that appears in no tool result is a useful signal for detecting
  wrong answers in production.
- Corrected: the model used Markdown despite the instruction; stripped in code instead of relying on
  the prompt.
- Misleading: during deployment the AI read a health check as proof the new version was running with
  the right configuration. The Railway dashboard showed a crash: the variable had the wrong name.
  I now check the deploy status and logs myself instead of relying on a single health check.

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

## Step 7 – MCP server
- Verified: tests with the official MCP client over real HTTP (wrong key rejected, a read-only key does
  not see propose_pause, no client has an approve tool), then the same checks against production with
  both keys, including a real pause request that reached Telegram and that I rejected.
- Chose differently: instead of one server that checks permissions inside each tool, I build a server
  per request with only the allowed tools. A tool the client cannot see is harder to misuse than a
  tool that refuses.

## Step 8 – Budget guard
- Verified: unit tests for recording, estimating a missing cost, one alert per threshold and the hard
  stop; then a live run with a tiny budget, where the first question was answered and the next ones were
  refused with a clear message.
- Chose differently: rather than adding a budget check in each channel, I wrapped the model function,
  so no channel can forget it.
- Corrected: model calls did not set max_tokens, so OpenRouter reserved credit for the model's maximum
  (65k tokens) and started refusing calls when the free balance ran out. I capped replies at 4,096
  tokens and added credit to the account.

## Step 9 – Scheduled morning report
- Verified: tests for the rules on the planted scenarios (the small-sample ad set is not flagged), for
  Israel time vs UTC, and for sending once per day across restarts with a retry after a failed send;
  then the real report built from the mock data.
- Chose differently: the AI could have written the report, but I used fixed rules: an automatic report
  must be exact and predictable, and the agent is still there to explain the "why".

## Step 10 – GUI
- Verified: API tests (access code, chat, bad input, budget exhausted) and the full flow in a browser.
- Corrected (found by testing in the browser): clicking a question turned the page white. A React effect
  returned the result of scrollIntoView, which is a Promise in current Chrome, and React tried to call
  it as a cleanup function. Fixed by giving the effect a body that returns nothing.
