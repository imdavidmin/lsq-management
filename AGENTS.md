# AGENTS.md

Orientation for an AI agent working in this repo. The design is already
specified in depth; your job is to **follow it**, not re-derive it. This file
is the router — it tells you which doc is authoritative for what, and the few
invariants that are easy to break if you skip the reading.

## What this is

A Board-owned ticket + performance-scoring system for the Lansbury Square
residential estate (~200 units). It supplements Dwellent (D1). The point is to
tie the managing agent's fee to measurable SLA delivery. Runs on Cloudflare:
**three Workers sharing one D1** — `server` (Hono API + daily Cron), `email` +
`ai` (inbound email via a queue, D20) — plus Email Routing, R2, and Workers AI
(email summarisation only). Scale is trivial; every design choice optimises for
zero-cost, board-maintained ownership, **not** throughput.

## Read before you write

Docs are the source of truth for intent. Load the one that owns your area
before editing code — the code comments assume you have.

| If you're touching…                    | Read first                          |
| --------------------------------------- | ----------------------------------- |
| anything — the settled decisions + why  | `docs/decisions.md` (**D1–D21**)    |
| features / the scoring rubric           | `docs/requirements.md` (authoritative) |
| email ingest, scoring, cron, roles      | `docs/architecture.md`              |
| routes / permissions / worker topology  | `docs/api.md` + `server/openapi.yaml` |
| login, sessions, OTP                    | `docs/authentication.md` (D17)      |
| authz, rate limiting, RBAC posture      | `docs/security.md`                  |
| PII, opt-out, read-audit                | `docs/gdpr.md`                      |
| surveys (one-vote, scoring gate)        | `docs/surveys.md`                   |
| SLA definitions + evaluation (D21)      | `docs/plan/plan-scoring-sla.md`     |
| the data model                          | `migrations/0001_init.sql` (annotated) |

**Decisions are append-only.** A new design decision adds a `D<n>` section to
`docs/decisions.md` with its rationale; superseding one edits the old section
to point forward (see D10→D13). Don't silently contradict a D-number in code —
if the code needs to diverge, record why there first.

## Load-bearing invariants

Break one of these and you've broken the design, not just a test:

1. **`events` is the append-only audit spine (D7, D19).** Never UPDATE/DELETE an
   event (sole exception: the D30 erasure scrub of `actor_email`). All state changes — comments, status, classification, clock stamps,
   chases, board disputes — are new rows. Rows name their subject
   polymorphically (`subject_type`/`subject_id`: `ticket` today, `metric_value`
   next). No DB FK on `subject_id`; the app validates the referent.
2. **Authorization is data, not code (D18).** `accounts` = identity only. Access
   = a `grant` (role scoped to estate/building/unit/organization/ticket) whose
   role carries the permission and whose scope covers the resource
   (estate ⊇ building ⊇ unit ⊇ ticket). Gate routes with
   `requirePermission(perm, scopeResolver)`; never add `is_board`-style columns
   or hard-code role checks.
3. **Email threading is pure regex on the recipient address, never AI (D3, D9).**
   `<ticketId>@TICKET_EMAIL_DOMAIN` (`ticket.` subdomain, D25) → ticket. Email only *updates* an existing ticket;
   creation is UI-only. The `no ai` opt-out skips summarisation **only** — it
   must never affect threading or SLA timing.
4. **Scoring is on-demand, never cached/nightly (D13).** Auto metrics are
   recomputed per dashboard/report request. Only manual/survey inputs and board
   disputes get stored (`metric_values`, latest-row-wins). The one Cron runs
   the daily chase + SLA-reminder pass, the auth cleanup (D27), and the monthly
   report on `REPORT_DAY_OF_MONTH` (D14/D15/D24). Nothing else.
5. **Don't build anti-gaming or speculative flexibility (D8).** No role
   inheritance, ABAC, per-field ACLs, DMARC flagging, Durable-Object alarms —
   all explicitly deferred in the docs. Add only when a real rule needs it, and
   record the decision.

## Code layout & conventions

npm-workspaces monorepo. **Three Workers** deploy independently
(`deploy:server|email|ai`), sharing one D1: `server` serves `web/dist` static +
routes `/api/*` and runs the cron; `email` + `ai` handle inbound mail (D20).
Shared dependency-free code lives in `common/` (`queue.ts`, `roles.ts`,
`permissions.ts`, `tickets.ts`, `auth.ts`), imported by path from each package.

- `server/src/index.ts` — the `server` Worker: `fetch` (Hono app) + `scheduled`
  (cron). Inbound `email()` is NOT here — see `email/` and `ai/`.
- `email/src/index.ts` — `email()` handler: validate ticket id → R2 + queue.
- `ai/src/{index,process}.ts` — queue consumer: resolve sender + AI summary →
  `events`. Its own tiny `db.ts` (self-contained, not coupled to `server`).
- `server/src/app.ts` — Hono root; mounts segment routers under `/api`.
- `server/src/segments/<name>/` — one folder per logical service
  (`auth`, `tickets`, `directory`, `engagement`; `scoring` per api.md).
  `routes.ts` (HTTP + zod validation + permission gates) delegates to
  `service.ts` (D1 queries, business logic). Keep routes thin.
- `server/src/middleware/` — `session.ts` (D17 cookie → account + grants),
  `rbac.ts` (`requirePermission`, `readableGrants`).
- `server/src/lib/` — shared helpers. **Reuse these before writing new ones:**
  `errors.ts` (`badRequest`/`forbidden`/`notFound`/… → OpenAPI error shape),
  `scope.ts` (grant-covers-resource resolution), `validate.ts` (`body(c, schema)`),
  `crypto.ts`, `cookies.ts`, `ratelimit.ts`, `workdays.ts`.
- `server/src/scheduler/cron.ts` — the cron handler (chase + monthly report).
- `server/src/config/*.json` — holiday + schedule calendars (config, not tables —
  they change rarely and are never queried).
- `web/` — Vite + React + Fluent UI v9, softened theme (D16). Feature screens
  live in `web/src/features/<area>/`.
- `web/src/components/` — shared FE components that go **beyond vanilla Fluent**
  (composites, domain widgets). Every component here ships a colocated
  `*.stories.tsx`; Storybook runs via `npm --workspace web run storybook`.
  Vanilla Fluent composed inline inside a feature needs no component or story —
  only promote to `components/` when it's reused or non-trivial.

Conventions in force (match them):
- Routes validate with zod and gate with `requirePermission` before doing work.
- Errors go through `lib/errors.ts` so the body matches `openapi.yaml`'s `Error`.
- SQLite has no booleans: columns are `0/1`; serialize to real booleans at the
  route boundary (see `serializeTicket`).
- `openapi.yaml` is the HTTP contract — update it when you change a route.

## Code style

The bar is **the next reader**, not the cleverest possible solution.

- **Readability over cleverness.** Boring, obvious code wins. If someone has to
  decode it at 3am, it's wrong. No premature generalisation.
- **No unnecessary abstractions.** No interface with one implementation, no
  wrapper/factory/config for a value that never varies, no indirection that
  saves nothing. Inline the one-off; extract only once a real second case exists.
- **Don't `export` until there's a second consumer.** Functions, consts, types
  stay module-private by default. A thing used in exactly one place lives next to
  its use, unexported. Widen the surface when the second caller actually arrives,
  not in anticipation.
- **Comments are short signposts, not documentation.** One concise sentence
  labelling what a block does or the reason it exists — enough to orient a
  reader skimming the file. Don't narrate line by line, and don't unpack the
  full rationale inline: deep *why*, trade-offs and rejected alternatives belong
  in a doc (`docs/decisions.md`), referenced by `D<n>`. Source code is not the
  place for docs.
- **Important decisions go in a doc, not a comment.** Anything a future reader
  would need to weigh — a rejected alternative, a real trade-off, a
  cross-cutting rule — belongs in `docs/decisions.md` (a new `D<n>`) or the
  relevant doc, referenced by number from the code (`(D18)`), not buried as a
  wall of inline text.
- **Delete over keep.** No dead code, no commented-out blocks, no "might need it
  later" scaffolding — git remembers. Smallest change that works.

## Build / test / run

```
npm install            # root, hoists both workspaces
npm test               # vitest on @cloudflare/vitest-pool-workers (real D1 in miniflare)
npm run typecheck      # tsc -p server/tsconfig.json
npm run be             # wrangler dev (server)
npm run fe             # vite (web)
npm run migrate:local  # apply migrations/ to local D1
```

- Tests apply `migrations/` into an isolated D1 per file; use
  `server/test/helpers.ts` (`login()`, `seedAccount`, `addGrant`) rather than
  hand-rolling sessions.
- **Any non-trivial change ships one runnable check.** There's a test per
  segment already — extend the matching one.

## Two gotchas

- **Edit `0001_init.sql` in place while the data is disposable.** Only a dev
  preview is deployed (every push to `main` runs `.github/workflows/deploy.yml`:
  test → `migrate:remote` → deploy). Change the model by editing
  `migrations/0001_init.sql` (schema) / `0002_seed.sql` (seed) directly, then
  reset local D1 (`rm -rf .wrangler/state/v3/d1 && npm run migrate:local`).
  Already-applied migrations don't re-run remotely, so an in-place edit also
  needs the remote D1 wiped by hand. Switch to append-only `0003_*.sql` once
  real data must be kept.
- **SLAs are data, evaluated on read (D21).** Don't store per-ticket SLA state
  or write `clock` events; add a start/stop kind to `common/sla.ts` only when a
  real rule needs it. The manual scoring exclusion is still open
  (`docs/sla-tracking.md`).
