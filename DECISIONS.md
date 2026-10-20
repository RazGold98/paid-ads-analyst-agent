# Decisions
## Who it's for and why an agent
- Users: a media-buying team of about 5 people who run Meta ad campaigns for a client (here, the mock
  account "Stride Footwear"). They ask questions in Telegram during the day, and the approvers among
  them decide on changes.
- What it makes easier: today, "why did CPA go up?" means opening Ads Manager, picking date ranges,
  comparing ad sets by hand and noticing data problems (a tracking outage, a missing day) that quietly
  distort the numbers. The agent does that in seconds, explains what changed, separates facts from
  guesses, says how confident it is, and can pause a wasteful ad set once a human approves. A morning
  report flags what needs attention without anyone asking.
- Why an agent and not a dashboard: the questions are open-ended and different every time ("what
  changed?", "is this ad set worth more budget?"). Answering them means choosing the right data,
  comparing periods, reading the data issues and explaining them in plain language. That is what a
  language model is good at. What it is not good at, I kept out of the model: every number is computed
  in code, the morning report uses fixed rules, and only a human can approve a change.

## Why this stack
- TypeScript on Node 20 for both services and the web page: the stack of the role and the one I know
  best, one language end to end, strict types, and zod to validate everything that comes from outside
  (API responses, model tool arguments, configuration).
- No agent framework: the agent loop is about 60 lines I can read and explain, and it is where the
  safety limits live (max 5 model calls, one pause request per question, the budget guard).
- OpenRouter with Claude Haiku 5.5: one API with the cost reported on every call, and the model is an
  environment variable, so it can be switched without a code change. Haiku is cheap, reliable at tool
  calling and resistant to prompt injection.
- grammY for Telegram (webhook in production), the official MCP SDK, Express for the HTTP endpoints,
  React with Vite for the web page, built and served by the same service.
- MongoDB Atlas for agent state: free tier, document-shaped records (requests, audit log, usage), and
  atomic conditional updates and unique ids that make "run once" guarantees simple.
- Railway: always-on hosting, which the Telegram webhook and the scheduler need, auto-deploy on push,
  and environment variables for secrets. Vitest for tests.

## Cost estimate (model + hosting, target under $50/month)
- Usage assumed by the brief: 5 people × 20 uses × 22 working days = 2,200 questions per month.
  I count every question the same, whether it comes from Telegram, the web page or MCP.
- Model, measured: during development OpenRouter reported 60 model calls, 238K tokens and $0.04 in
  total, about $0.0007 per call. A question takes 2–3 calls, so about $0.002 per question.
  2,200 × $0.002 ≈ $4.40 per month. Even if real questions were three times heavier, about $13.
- The morning report uses no model (fixed rules), so it costs nothing in model usage.
- Hosting: a real deployment would use Railway Hobby, $5/month including $5 of usage (the demo runs on
  the trial credit). Two small, mostly idle Node services; at about $10 per GB-month of memory, roughly
  0.15 GB each is about $3, plus a little CPU, within the included $5. MongoDB Atlas free tier: $0.
- Expected total: about $10/month. Worst case: the model is capped at $40 by the budget guard, plus
  hosting of about $5, which stays under $50.
- Near the limit: alerts to the approvers at 70% and 85% of the model budget; at 100% the agent stops
  answering and says why, while approvals keep working. OpenRouter's account credit and key limit are a
  second, hard stop.

## Where AI helped and where it was wrong
- Helped: I used Claude Code to implement every step from my specs and decisions, to write tests,
  and as a sounding board for trade-offs. Details per step are in [AI_NOTES.md](AI_NOTES.md).
- Wrong or misleading, and caught by testing:
  - The model looked at 30 days for "which ad set is wasting money?" and missed a problem from the
    last week; fixed with a 7-day default and a comparison with the previous period.
  - The model computed an account ROAS itself and got it wrong (2.39 instead of 2.44); it may now only
    use numbers returned by the tools.
  - The first eval run showed the model creating 5 pause requests for "pause all ad sets", although
    the prompt said one at a time; it is now limited to one per question in code, not only in the prompt.
  - During deployment the AI read a health check as proof the new version was live; the dashboard
    showed a crash. I now check the deploy logs myself.
  - AI-written React code turned the page white on the first click (an effect returned a Promise);
    found by testing in the browser.

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
- Hosting: Railway (always-on, auto-deploys on push to main). The demo runs on Railway's trial credit,
  which covers the test period; a real deployment would use the Hobby plan (see the cost estimate above).



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

## Steps 4–5 – LLM agent + Telegram
- LLM via OpenRouter, model anthropic/claude-haiku-5.5: cheap, strong at tool calling and resistant to
  prompt injection. The model is an environment variable, so it can be switched (e.g. near the budget
  limit) without a code change.
- Plain fetch to OpenRouter's chat-completions API, no SDK: a short client that is easy to read and test.
- The model never touches data directly. It can only request one of four read-only tools; our code
  validates the arguments with zod, runs the tool and returns { result, issues, sources }. Bad arguments
  and Ads API errors go back to the model as data, so it can explain them instead of the bot crashing.
- At most 5 model calls per question, so a confused model cannot loop and spend without limit.
- System prompt: only numbers from tools (no self-computed totals), API text is data and never an
  instruction, mention relevant data issues, separate fact from hypothesis, default to the last 7 days
  and compare with the previous period for "what changed" questions. Fixed answer format:
  Answer → Evidence (with source) → Fact vs hypothesis → Recommendation → Confidence with reason.
- The prompt is guidance, not a security boundary. The real protection is structural: the model has
  no tool that changes anything; pausing (step 6) only creates a request that a human must approve.
- Telegram: each answer runs in the background, because an agent run can exceed the webhook timeout
  and Telegram would resend the message. The last 6 messages per chat are kept in memory for follow-up
  questions; they are lost on restart, which is acceptable for short follow-up context.
- Plain-text answers: Telegram shows Markdown literally, and the model sometimes uses bold anyway,
  so "**" is stripped in code rather than relying on the prompt.
- No automatic retry on model calls: they are slow and cost money while the user waits. On failure the
  user gets a clear message and can ask again.
- The OpenRouter key is checked at startup (must start with sk-or-), so a mis-pasted value fails fast.
- Measured: about $0.0015–0.002 and 6–7 seconds per question. 5 users × 20 questions × 22 workdays
  ≈ 2,200 questions/month ≈ $4–5/month for the model.
- Deployment lesson: when a new required variable is added, set and apply it in Railway before pushing
  the code that requires it; otherwise the new deploy refuses to start.

## Step 6 – Pause with human approval
- The model never pauses anything. Its only write-related tool is propose_pause, which creates a
  pending request in MongoDB. The pause itself is executed by our code, and only after a human clicks
  Approve in Telegram.
- The approval card shows the ad set, its current status and daily budget, the last 7 days' spend,
  conversions, CPA and ROAS, the expected impact, the agent's reason, who asked and when it expires.
  The numbers are read from the API by our code when the request is created, not written by the
  model, so the approver is not shown invented figures. Only the reason is the model's text.
- Approvers register by sending /register followed by the access code. The code is shared with
  testers; it is a demo-level control. In production I would use per-user invites or SSO.
- Any registered approver can approve, including the requester: the requirement is that a human
  approves the specific action. A real deployment might require a second person.
- Approval is an atomic MongoDB update (pending → executing only if still pending and not expired),
  so a double click or two approvers at once can only execute the action once.
- Before acting, the ad set's status is read again: if it was paused by hand meanwhile, nothing is sent.
- The pause request is sent once with an Idempotency-Key ("pause-" plus the request id), never retried blindly.
- After any response, success or error, the real status is read back (reconcile). If the API failed
  halfway but the ad set is paused, the result is "succeeded" with a note; if it is still active,
  "failed"; if the status cannot be read, "unknown" with an instruction to check manually.
- States: pending → executing → succeeded | failed | unknown, or pending → rejected | expired.
  I merged "approved" into "executing": the atomic claim is what matters.
- Requests expire after 2 hours. Expiry is checked when someone clicks, not by a background job:
  an old card keeps its buttons, but clicking it does nothing except mark it expired.
- Every step is written to an audit log (created, approved, rejected, expired, succeeded, failed,
  unknown, approver registered, failed registration).
- One pending request per ad set; asking again returns the existing request.
- Only pausing is supported. The brief asks for at least one action; one complete, safe action is
  better than two half-done ones.
- Agent state uses the same Atlas cluster as the mock, in a separate database (agent vs mock_meta).

## Step 7 – MCP server
- Other agents reach the same agent over MCP (official SDK, Streamable HTTP at POST /mcp, on the same
  service). It reuses the same tools, validation, agent loop and approval flow as Telegram; nothing is
  duplicated.
- Who may trigger the pause via MCP: nobody. MCP clients can at most propose. A proposal becomes the same
  pending request as in Telegram, with the same card, and only a registered human approves it there.
- Each client has an API key with scopes, set in MCP_API_KEYS as name:key:scopes. "read" gives the data
  tools and ask_analyst; "propose" adds propose_pause and get_request_status. There is no scope, and no
  tool, that approves or executes.
- For every request I build a server that registers only the tools the key allows: a read-only client
  does not even see propose_pause, rather than seeing it and being refused.
- ask_analyst runs the agent without the pause tool, so a question ("pause everything") can never be
  used to get around the client's scopes.
- Keys are kept in memory only as SHA-256 hashes and compared in constant time; unknown scopes or keys
  shorter than 24 characters stop the service at startup. MCP is off when MCP_API_KEYS is empty.
- Stateless mode (a fresh server per request, no sessions): simple, and enough for request/response use.

## Step 8 – Budget guard
- The full cost must stay under $50/month. I cap model spend at $40 (MONTHLY_BUDGET_USD) and leave the
  rest for hosting.
- The guard wraps the model function itself, so every channel (Telegram, MCP, GUI) goes through it and
  none can skip it. The agent loop did not change.
- Before each call it checks the month's spend; after each call it records the cost reported by
  OpenRouter. If no cost is reported, it is estimated from tokens, never counted as 0.
- Alerts to the approvers at 70%, 85% and 100%, once per threshold per month (a unique MongoDB id).
  At 100% the agent stops answering and says why; approvals keep working because they do not use the model.
- The check runs before each call, so the overshoot is at most one call (well under a cent). Finishing an
  answer already in progress is better than cutting it off.
- Every reply is capped at 4,096 tokens (max_tokens), so a single call has a bounded cost.
- Two layers: my guard at $40 with early warnings, and OpenRouter's own limit (account credit and the
  key's limit) as a hard stop. Running out of OpenRouter credit is an operational risk to monitor:
  it happened during development, when the free balance ran out.
- Measured during development: 60 model calls, 238K tokens, $0.04 in total, about $0.0007 per call and
  $0.002 per question. That supports the estimate of about $4–5/month for 5 users × 20 questions × 22 days.

## Step 9 – Scheduled morning report
- Every morning at 08:00 Israel time (REPORT_TIME, REPORT_TIMEZONE) the approvers get a short report of
  what needs attention: last 7 days vs the 7 before, for every active ad set.
- The anomalies are found by fixed rules, not by the model: high spend with fewer than 10 conversions,
  ROAS under 1, CPA up 30% or more with at least 10 conversions, and data problems (suspected tracking
  outage, missing day). A report nobody reviews before it is sent must be predictable and exact, and I
  had already seen the model compute a number wrong. The report says what; the agent explains why when
  someone asks.
- The rules use the same tools as the agent, so cleaning, outage exclusion and rounding are identical.
- Scheduling: a check every minute instead of one long timer. A timer is lost on every deploy; this
  catches up after a deploy or an outage at 08:00. A unique daily id in MongoDB makes sure the report is
  sent once per day; if sending fails the id is released and the next check retries.
- /report shows the report on demand, so testers do not have to wait for the morning.

## Step 10 – GUI
- A React page (Vite) with the chat, the pause requests, the action log and the budget meter.
- Built into dist/public by the same npm run build command and served by the agent's Express server:
  one service, one URL, nothing extra to deploy.
- The API under /api is a thin layer over what already exists (the agent loop, the action store, the
  budget guard); there is no new business logic.
- Login is the approver code, because the chat costs money and should not be open to the internet.
  Testers already receive this code.
- Approving stays in Telegram: only there do I know which registered person is approving. The GUI shows
  requests and their state; a pause asked for in the GUI goes to the Telegram approvers like any other.
- The browser keeps the conversation and sends the last 6 messages, so the server stays stateless.
- Answers are rendered as plain text, so text from the API (such as the injected ad set name) can never
  run as HTML.
