# AI usage log
Where AI helped, and where it was wrong or misleading.

## Step 0 – Skeleton
- Helped: Claude Code scaffolded the agent service (config, bot, server, entry point) and
  self-tested config validation and /health with a fake token.
- Helped: explained Railway setup step by step (root directory, build/start commands, variables).
- Wrong/missed: didn't add .DS_Store to .gitignore → 3 .DS_Store files got committed;
  I removed them in a follow-up commit.
- Missed: the scaffolding didn't account for deploying from the repo root; my first Railway
  build failed until I set Root Directory = apps/agent.
- Wrong: a bulk shell command the AI chat gave me for updating these docs nested a code
  fence inside another, which broke the copy-paste; caught it before running.
- Limitation: couldn't test real Telegram without a token; I verified ping/pong manually.
