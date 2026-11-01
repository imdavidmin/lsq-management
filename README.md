# LSQ Site Operations

A Board-owned ticket and tracking system for the Lansbury Square residential
community (~200 units). It supplements — does not replace — Dwellent, which
stays the system of record for service charge, announcements and site info.

## Why it exists

To **align the managing agent's performance fee with measurable delivery**,
using objective data rather than board perception. Today work happens over
email and isn't tracked; goal attainment is a matter of interpretation. This
system:

- tracks issues, key dates, deliverables and large projects;
- integrates with the existing email flow (via CC) so the agent's working
  habits barely change;
- **computes SLA fulfilment and the projected performance fee automatically**,
  visible to agent and board at any time;
- attributes responsibility, flags bottlenecks, and chases stale/overdue items;
- reduces the agent's reporting burden and removes the monthly meeting.

## High-level architecture

Three Workers share one D1. The `server` Worker owns the API + cron; inbound
email is a separate `email` → queue → `ai` pipeline (D20).

```
  Residents / Staff / Board          Contractors & staff (email)
        │  (web UI)                          │  reply to <ticket#>@lansburysquare.co.uk
        ▼                                    ▼
  ┌──────────────┐                  ┌──────────────────────┐
  │  Web app     │                  │ Email Routing        │
  │ create/view  │                  │   → email Worker     │  parse id, reject unknown,
  │ tickets,     │                  │  (lsq-email)         │  stash raw in R2, enqueue key
  │ surveys,     │                  └──────────┬───────────┘
  │ dashboards   │                             ▼  lsq-inbound queue
  └──────┬───────┘                  ┌──────────────────────┐
         │  /api/*                  │ ai Worker (lsq-ai)   │  resolve sender,
         ▼                          │  queue consumer      │  Workers AI summary
  ┌────────────────────────┐        └──────────┬───────────┘  (skip on "no ai"),
  │  server Worker (API)   │                   │              append event
  │ tickets · events ·     │◄──────────────────┘
  │ identity · surveys ·   │        appends to shared D1
  │ scoring · daily cron   │
  └───────────┬────────────┘
              ▼
      ┌──────────────┐   shared by all three Workers
      │  D1 (SQLite) │   see migrations/0001_init.sql
      └──────────────┘
   cron (on server): daily chase + monthly report; scoring is on-demand.
```

**Stack:** Frontend — Vite + React + TypeScript + Fluent UI v9 (softened theme),
ag-grid for advanced tables. Backend — Cloudflare Workers (server + email + ai) +
D1 + Queues + R2 + Workers AI (email summarisation) + Email Routing + Cron
Triggers. Board-maintained, no per-seat vendor licence.
Scale is trivial for ~200 units — infra choice is about zero-cost ownership, not
throughput. Metric scoring runs on-demand; only chase + monthly report are
scheduled.

## Repo layout

npm-workspaces monorepo. Each app declares its **own** dependencies
(`server/package.json` = hono/zod + Workers tooling; `web/package.json` =
React/Vite — no cross-contamination) and builds independently (separate
tsconfigs — the Worker uses `@cloudflare/workers-types`, the FE needs DOM/React
libs, and the two type worlds clash if merged). One `npm install` at root hoists
all. The `server` Worker serves the built frontend as static assets and routes
`/api/*` to its code; the `email` and `ai` Workers deploy separately (`npm run
deploy` fans out to `deploy:server|email|ai`). All three share one D1. A GitHub
push runs the FE build then deploys each Worker — no separate Pages project.

- `package.json` — root workspace: shared devtool (`typescript`) + orchestration
  scripts (`test`, `typecheck`, `dev`, `deploy`). Configs stay here too.
- `server/` — API + cron Worker: `package.json`, `src/`, `test/`, `openapi.yaml`.
- `email/` — inbound `email()` Worker: validate → R2 + queue (own `wrangler.jsonc`).
- `ai/` — queue-consumer Worker: sender resolution + AI summary → events.
- `common/` — dependency-free shared code (`queue.ts`, `roles.ts`,
  `permissions.ts`, `tickets.ts`, `auth.ts`), imported by path from each package.
- `web/` — frontend (Vite + React + Fluent UI).
- `wrangler.jsonc` — the `server` Worker's config; `email/` and `ai/` have their own.
- `migrations/` — D1 migrations (root; applied by wrangler and the test pool).
  `0001_init.sql` is the annotated schema (identity, tickets, audit spine,
  scoring, surveys); `0002_seed.sql` the seed data.
- `docs/requirements.md` — **the authoritative feature list + scoring rubric.**
- `docs/architecture.md` — technical design: email flow, scoring engine, roles.
- `docs/decisions.md` — settled design decisions and their rationale.
- `docs/authentication.md` — passwordless OTP auth + session model (D17).
- `docs/security.md` — consolidated security posture: auth, rate limiting, RBAC.
- `docs/gdpr.md` — PII treatment, read-audit log, survey anonymisation, residual risk.
- `docs/surveys.md` — survey mechanism: one-vote-per-unit, authorisation, scoring gate.
- `docs/sla-tracking.md` — **open** design question: how contractor/agent SLA
  clocks get computed from `events`, plus the manual scoring-exclusion escape hatch.
- `docs/api.md` — route map by segment with permissions and UJ references.

## Getting started

```sh
npm install              # root; hoists all workspaces
npm run migrate:local    # apply migrations/ to the local D1
npm run seed:dev         # optional: demo accounts, orgs, senders (server/dev-seed.sql)
mkdir -p web/dist        # wrangler + the test pool expect it; `npm --workspace web run build` fills it
npm run be               # API Worker (wrangler dev)
npm run fe               # Vite frontend (second terminal)
```

**Local login bypass.** Skip the email OTP by creating `.dev.vars` in the repo
root (gitignored):

```
DEV_LOGIN_EMAIL=alice@lansburysquare.co.uk
```

Restart `npm run be`; every request is signed in as that email. The account is
created if missing and always gets a board/estate grant, so it sees everything
(see `server/src/middleware/session.ts`). Seeded accounts:

| Email                        | Role in dev seed   |
| ---------------------------- | ------------------ |
| `alice@lansburysquare.co.uk` | board, estate      |
| `dave@dwellent.com`          | agent, estate      |
| `bob@example.com`            | resident, unit 1   |
| `carol@example.com`          | resident, unit 4   |

To see a single role's real view, leave `DEV_LOGIN_EMAIL` unset and log in
normally. Tests blank the variable, so the bypass never leaks into them.

```sh
npm test                 # vitest on real D1 (miniflare)
npm run typecheck
```

## Status

Design phase. Schema drafted; Worker email flow and nightly scoring job are the
next build steps.
