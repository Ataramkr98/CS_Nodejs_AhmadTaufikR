# CS Pintar Backend

Multi-tenant NestJS/Fastify backend for Customer Service Pintar. It provides knowledge-grounded Web Chat, Socket.IO streaming, operator-console APIs, provider fallback, hybrid pgvector/text retrieval, and Redis/BullMQ jobs.

**Live demo:** [CS Pintar reviewer demo](https://cs-pintar-ataramkr98.vercel.app/demo).
**API reference:** [Swagger UI](https://cs-pintar-ataramkr98.vercel.app/api/docs).

This repository contains the backend submitted for review. The hosted demo also
includes a Next.js operator console; its source is maintained separately.

## Two-minute reviewer walkthrough

1. Open the live demo and send **Which shipping carriers are available?**.
2. Ask a follow-up about returns or bank transfers. The assistant retrieves the
   corresponding policies and keeps the conversation in AI mode when evidence is sufficient.
3. Open **CS Inbox**, select **Fill**, and sign in with `demo@cspintar.io` /
   `DemoPassword123!`. The link opens the same visitor conversation.
4. Inspect the reply model, retrieved citations and token usage. The public
   deployment uses **Groq API — `openai/gpt-oss-20b`**.
5. Select **Take over**, send an operator reply, and observe it in the visitor
   widget. **Back to AI** resumes automatic replies.

The shared demo contains synthetic data. Questions with unsupported requirements
can be escalated for human review; this is an intentional part of the flow.

## Architecture and AI behavior

```text
Visitor widget / operator console
              -> NestJS + Fastify -> tenant-scoped Prisma transaction
                      |                       -> PostgreSQL + pgvector
                      -> knowledge retrieval -> Groq / compatible provider
                      -> committed reply + citations -> transcript / Socket.IO
```

- Retrieval combines semantic similarity, when an embedding provider is available,
  with tenant-scoped keyword search. Lexical relevance is the fraction of distinct
  query concepts present in the source, including English/Indonesian aliases.
  Duplicate chunks use their strongest retrieval signal. **Knowledge match** is a
  relevance score, not a calibrated probability that an answer is correct.
- Generation receives retrieved facts, the last conversation turns, workspace
  language and tone. Unknown details are clarified or escalated rather than invented.
- A human takeover during generation prevents the pending automatic answer from
  being delivered. Retries do not duplicate messages.
- Streaming usage totals are read from the provider when available. Otherwise the
  estimate includes system instructions, retrieved knowledge, conversation and
  message framing. Historical rows may contain the earlier estimates. Daily
  auto-throttle blocks new calls after the recorded budget is reached; it does not
  reserve tokens atomically or prevent an in-flight reply from exceeding the budget.
- `AI_MODE=demo` is an explicit offline demonstration. `AI_MODE=live` requires a
  configured, enabled provider and never falls back to the offline provider.

## Run locally

Prerequisites: Node.js 24, npm, and PostgreSQL with pgvector. Redis is optional
unless queues are enabled.

1. Copy `.env.example` to `.env` and retain `AI_MODE=demo` for a credential-free walkthrough.
2. Start PostgreSQL + Redis with `docker compose up -d postgres redis`.
3. Run `npm ci`, `npx prisma generate`, `npx prisma migrate deploy`, and `npm run prisma:seed`, then `npm run start:dev`.
4. Visit `http://localhost:3001/api/docs` and `http://localhost:3001/api/health`.

`docker compose up --build` starts the API, database and Redis. The example database
URLs match the Compose database credentials for running Node on the host. Compose
overrides its API connections with the internal `postgres` hostname. Keep secrets
in the ignored `.env`; production requires persistent JWT signing keys and HTTPS
cookies. Apply database migrations before deploying a new container runtime release.

For live Groq responses, set `AI_MODE=live` and `GROQ_API_KEY`, then enable the
desired Groq model. Fresh demo seeds include `openai/gpt-oss-20b` and an offline
provider that is available only in explicit demo mode. Optional semantic embeddings
use `HF_TOKEN` or `OLLAMA_URL`; keyword retrieval works without either.

## Core flow

1. `POST /api/auth/signup` creates a tenant, owner, settings, widget key, and provider configuration.
2. `POST /api/kb` creates a text source, or `POST /api/kb/upload` accepts PDF, DOCX, and Markdown. BullMQ extracts, chunks, embeds, and indexes it.
3. `POST /api/public/widgets/:widgetKey/sessions` starts a public Web Chat session and returns a visitor token.
4. `POST /api/public/conversations/:id/messages` persists the customer message and queues the reply.
5. Connect Socket.IO using path `/ws` to receive `assistant.stream.*`, conversation, and knowledge-source events.

## Security and privacy

- Operator sessions use HttpOnly RS256 cookies, rotated hashed refresh tokens, role guards, and CSRF validation for cookie-authenticated writes.
- Widget tokens are scoped to exactly one conversation and a tenant-configured origin allowlist.
- Repository predicates plus transaction-local PostgreSQL RLS protect tenant data; the Compose API uses a non-owner `csp_app` role while migrations use the owner connection. `KnowledgeChunk` is also filtered before pgvector similarity search.
- Gemini is disabled by default. `openrouter/free` is opt-in. Demo responses only occur when `AI_MODE=demo` is explicitly configured.

## Console endpoints

`POST /api/conversations/:id/draft` generates an editable AI suggestion for an
owner, admin or agent. It uses the tenant's knowledge base and provider routing,
records token usage, and leaves the conversation and its messages unchanged.
The operator reviews and sends the draft from the Inbox.

Drafts use the full conversation, including operator replies, and the workspace
brand voice. An optional `previousDraft` (up to 8,000 characters) supplies a
wording reference for regeneration. When a policy detail is unknown, the draft
asks targeted clarifying questions instead of promising an automatic handoff.
READY knowledge chunks without vectors remain searchable through tenant-scoped
text retrieval. The displayed match score then measures query-concept coverage.

The AI gateway requires an active subscription for `AI_API_KEY`. Empty replies
and subscription-expiry notices returned as HTTP 200 trigger provider fallback.
If no enabled provider works, the console shows the failure instead of sending
an empty reply or the gateway's account details.

- `/api/dashboard/overview`, `/api/analytics`, `/api/insights`, `/api/usage`
- `/api/kb`, `/api/conversations`, `/api/chat-logs`
- `/api/tenants/me`, `/api/settings`, `/api/providers`, `/api/api-keys`
- `/api/capabilities` reports non-MVP functions as unavailable instead of returning mock data.

Run `npm run typecheck`, `npm test`, `npm run test:e2e`, and `npm run build` before deployment.

## Demo seed

`prisma/seed.ts` provisions `demo-widget-key`, the demo owner plus agent/viewer
accounts, four knowledge sources, historical sample conversations and usage rows,
and a second tenant for isolation checks. It is intended for a new local database;
never re-seed a production database to deploy code.

## Verification and limitations

```bash
npm run verify
npm run test:e2e  # requires the configured development database
```

CI runs type checking, lint, unit tests and a production build with Node.js 24.
Regression coverage includes multilingual retrieval, unsupported-question handoff,
provider fallback, reported/full-prompt token accounting, scoped visitor sessions,
authentication, and takeover races. Provider calls in unit tests are mocked.

Web chat is implemented. WhatsApp, email and Telegram integrations, billing and
CSAT collection are not implemented; the public capability endpoint discloses
availability. Monetary costs are unavailable without a maintained model price list.
