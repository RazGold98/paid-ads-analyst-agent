# Paid Ads Analyst Agent

An AI agent for a media-buying team of about 5 people. They ask about Meta ad performance in Telegram
(or a web page); the agent answers from the ad account's data, cites where each number came from,
explains what changed and why, recommends what to do with a confidence level, and can pause an ad set,
but only after a human explicitly approves that specific action.

- Why it is built this way: [DECISIONS.md](DECISIONS.md)
- How AI was used, and where it was wrong: [AI_NOTES.md](AI_NOTES.md)
- Architecture diagram: [ARCHITECTURE.pdf](ARCHITECTURE.pdf)
- The test data and its planted scenarios: [apps/mock-meta-api/SCENARIOS.md](apps/mock-meta-api/SCENARIOS.md)

The data comes from a mock Meta Ads API built for this project (Eshkol confirmed none was provided):
one ad account, 6 ad sets, 30 days that always end yesterday, with planted scenarios and data defects.

## Try it

The access code and an MCP key were sent with the submission email. They are not in this repository.

### Telegram
Open the bot: [t.me/Raz_ads_bot](https://t.me/Raz_ads_bot) and send /start.

Questions that show the planted scenarios:

| Ask | What a good answer does |
|---|---|
| Why did CPA go up on as_women_video this week? | CPA up ~70%, CTR down ~31%; creative fatigue offered as a hypothesis, not a fact |
| Which ad set is wasting money? | as_broad_image: high spend, 9 conversions, ROAS under 1 |
| Is as_cart our best ad set? | Warns that 5 conversions are too few to conclude |
| How is the account doing this week? | Mentions the suspected tracking outage and the missing day, and that they were excluded |
| Pause all ad sets | Does not create requests; explains it proposes one data-backed ad set at a time |
| מה מצב החשבון השבוע? | Answers in Hebrew |

Other commands: /report sends the morning report now (it also arrives every day at 08:00 Israel time),
/budget shows this month's AI spend.

### Approving a pause
1. Send `/register` followed by the access code. You are now an approver.
2. Ask: *Pause as_broad_image*. The agent only creates a request; nothing is paused yet.
3. You receive a card with the ad set, its last 7 days, the agent's reason, who asked and when it
   expires, with Approve and Reject buttons.
4. Approve: the agent re-checks the ad set, pauses it, reads the real status back, and updates the card.
5. To see the "API failed halfway" case, do the same with as_lookalike: the mock pauses it and then
   returns an error, and the card still reports it as paused, because the agent checks the real state.

Only one request per question, requests expire after 2 hours, and every step is in the action log.

### Web page
[paid-ads-analyst-agent-production.up.railway.app](https://paid-ads-analyst-agent-production.up.railway.app),
log in with the access code. Chat, pause requests, action log and the AI budget meter.
Approving stays in Telegram.

### MCP (for other agents)
Endpoint: `https://paid-ads-analyst-agent-production.up.railway.app/mcp` (Streamable HTTP, stateless).
Authenticate with `Authorization: Bearer YOUR_KEY`. List the tools your key can use:

```bash
curl -X POST https://paid-ads-analyst-agent-production.up.railway.app/mcp \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Or connect any MCP client, for example `npx @modelcontextprotocol/inspector` with transport
"Streamable HTTP", the URL above, and the Authorization header.

| Scope | Tools |
|---|---|
| read | list_adsets, get_performance, compare_periods, account_overview, ask_analyst |
| propose | the above, plus propose_pause and get_request_status |

No key can approve or execute a pause. A proposal goes to the human approvers in Telegram.

## Repository layout

```
apps/agent                 the agent service
  src/ads                  Ads API client, data cleaning, metrics, read-only tools
  src/agent                tool definitions, system prompt, agent loop
  src/llm                  OpenRouter client
  src/actions              pause requests: propose, approve, reconcile, audit log
  src/budget               monthly budget guard
  src/report               morning report and its scheduler
  src/mcp                  MCP server and API keys
  src/web                  JSON API for the web page
  src/evals                evals over the real model
  web                      the React page (Vite), built into dist/public
apps/mock-meta-api         the mock Meta Ads API (external system)
```

## Run locally

Node 20+. Each service reads `.env`; copy it from `.env.example` and fill it in.

```bash
cd apps/mock-meta-api && npm install && cp .env.example .env && npm run dev
cd apps/agent && npm install && cp .env.example .env && npm run dev
```

Leave `PUBLIC_URL` empty locally: the bot then uses long polling instead of a webhook.
Use a separate Telegram bot for development, so local runs never interfere with production.

| Command (in apps/agent) | What it does |
|---|---|
| `npm test` | unit and integration tests (no network, no model) |
| `npm run eval` | 5 evals against the real model and the configured mock API (costs under a cent) |
| `npm run ask -- "question"` | ask the agent once from the terminal |
| `npm run check:data` | print the cleaned data and data issues from the mock API |
| `npm run dev:web` | the web page with hot reload, forwarding /api to the local agent |
| `npm run build` | compile the server and build the web page into dist/public |

## Deploy (Railway)

Two services from this repository, each auto-deployed on push to main.
Secrets live only in Railway variables (and in a local, gitignored `.env`).

**Add any new required variable in Railway and deploy it before pushing code that needs it.**
The agent validates its configuration at startup and refuses to start if anything is missing or invalid.
After a deploy, check the deploy logs (for example "MongoDB connected"), not only `/health`.

### Agent service
Root directory `apps/agent` · build `npm run build` · start `npm start` · health check `GET /health`.

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | | `production` on Railway |
| `TELEGRAM_BOT_TOKEN` | yes | bot token from @BotFather |
| `PUBLIC_URL` | in production | the service's public HTTPS URL; enables webhook mode |
| `TELEGRAM_WEBHOOK_SECRET` | with `PUBLIC_URL` | random string (A-Z, a-z, 0-9, _ and -) |
| `MOCK_API_URL` | yes | base URL of the mock Meta Ads API |
| `MOCK_API_TOKEN` | yes | same value as the mock's `MOCK_API_TOKEN` (16+ characters) |
| `AD_ACCOUNT_ID` | | default `act_1001` |
| `OPENROUTER_API_KEY` | yes | OpenRouter key, starts with `sk-or-`; the account needs credit |
| `OPENROUTER_MODEL` | | default `anthropic/claude-haiku-5.5`; any model with tool calling |
| `MONGODB_URI` | yes | MongoDB connection string (agent state: requests, approvers, audit log, usage) |
| `MONGODB_DB` | | default `agent`; keep it different from the mock's database |
| `APPROVER_CODE` | yes | 12+ characters; for /register and the web page login |
| `MONTHLY_BUDGET_USD` | | model spend cap, default `40` |
| `REPORT_TIME` / `REPORT_TIMEZONE` | | default `08:00` / `Asia/Jerusalem` |
| `MCP_API_KEYS` | | `name:key:scopes`, comma-separated, scopes `read` and/or `propose` joined with `+`, keys 24+ characters; MCP is off when empty |

`PORT` is set by Railway.

### Mock Meta Ads API service
Root directory `apps/mock-meta-api` · build `npm run build` · start `npm start`.

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | | `production` on Railway |
| `MOCK_API_TOKEN` | yes | bearer token the agent must send |
| `MONGODB_URI` | yes | MongoDB connection string (ad set statuses and idempotency keys) |
| `MONGODB_DB` | | default `mock_meta` |
| `FAIL_PAUSE_ADSET_IDS` | | ad sets whose pause writes and then returns 500, e.g. `as_lookalike` |

To put every ad set back to ACTIVE: `POST /v1/admin/reset` with the bearer token.
