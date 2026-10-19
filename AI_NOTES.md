# AI usage log
Where AI helped, and where it was wrong or misleading.

## Step 0 – Skeleton
- Helped: Claude Code scaffolded the agent service (config, bot, server, entry point) and
  self-tested config validation and /health with a fake token.
- Helped: explained Railway setup step by step (root directory, build/start commands, variables).
- Limitation: couldn't test real Telegram without a token; I verified ping/pong manually.

## Step 1 – Mock Meta Ads API
- Designed the scenarios, data defects and failure-injection behaviour, then used Claude Code to
  implement the service and generator tests from that spec.
- Verified the generated data manually against the spec (30-day window, burner spend/conversions,
  outage day, negative spend, idempotent replay, write-then-500 failure), locally and on Railway.
