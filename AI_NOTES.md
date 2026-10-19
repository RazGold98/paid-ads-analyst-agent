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
- Delegated: implementation of the mock service and generator tests from my spec.
- Chose differently: the AI suggested mirroring Meta's exact response format (numbers as strings,
  nested actions[] arrays). I chose a simple flat schema plus a small set of explicit, documented
  defects. It keeps the focus on how the agent handles bad data, not on format plumbing.
- Verified: 30-day rolling window, scenario shapes (fatigue, burner, outage), each injected defect,
  idempotent replay, and the write-then-500 failure path, both locally and on Railway.
