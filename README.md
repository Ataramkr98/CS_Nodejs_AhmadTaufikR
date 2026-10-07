# CS Pintar Backend

Multi-tenant NestJS/Fastify backend for Customer Service Pintar. It provides RAG-backed Web Chat, Socket.IO streaming, operator-console APIs, free-provider routing, pgvector retrieval, Redis/BullMQ jobs, and explicit feature-capability states for later PRD phases.

## Run locally

1. Copy `.env.example` to `.env` and retain `AI_MODE=demo` for a credential-free walkthrough.
2. Start PostgreSQL + Redis with `docker compose up -d postgres redis`.
3. Run `npm install`, `npx prisma migrate deploy`, then `npm run start:dev`.
4. Visit `http://localhost:3001/api/docs` and `http://localhost:3001/api/health`.

`docker compose up --build` starts the complete stack. The workspace used for this implementation does not have Docker installed, so run that command on a Docker-enabled machine.

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

- `/api/dashboard/overview`, `/api/analytics`, `/api/insights`, `/api/usage`
- `/api/kb`, `/api/conversations`, `/api/chat-logs`
- `/api/tenants/me`, `/api/settings`, `/api/providers`, `/api/api-keys`
- `/api/capabilities` reports non-MVP functions as unavailable instead of returning mock data.

Run `npm run typecheck`, `npm test`, `npm run test:e2e`, and `npm run build` before deployment.

## Demo seed

`prisma/seed.ts` provisions the portfolio demo in one step: tenant
`CS Pintar Demo` (`demo-widget-key`), owner `demo@cspintar.io` /
`DemoPassword123!`, an agent account, provider-routing defaults, one READY
knowledge source with 4 chunks, two conversation threads (WEB + WHATSAPP) with
assistant citations and `LlmUsage` rows, plus seed audit/conversation events —
so every console screen renders real data immediately.
