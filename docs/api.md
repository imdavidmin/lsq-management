# API Route Map

All HTTP endpoints, grouped by the Worker (service) that owns them. The full
request/response contract is in [`openapi.yaml`](../openapi.yaml); this file is
the at-a-glance map and the worker-topology.

> **Deployment note:** the HTTP services below all ship as modules behind one
> Worker (`server`) + router — split later without touching a route. Inbound
> email is already separate: two dedicated Workers, `email` → queue → `ai`, with
> no HTTP surface (D20). The cron (`scheduled`) runs on the `server` Worker.

## Topology

```
                 api.lansburysquare.co.uk  (path-routed → service)
  ┌──────────┬───────────┬────────────┬───────────┬──────────────┐
  │  auth    │  tickets  │ directory  │  scoring  │  engagement  │
  └──────────┴───────────┴────────────┴───────────┴──────────────┘
        shared: session-cookie check + grant/permission middleware
    all five segments ship as one Worker (server); cron runs here too
                              │  D1  (shared by every Worker)
  ─────────────────────────── not HTTP ───────────────────────────
   email  (Email Routing → email(): validate → R2 + queue)   [Worker lsq-email]
   ai     (queue → resolve sender + AI summary → events)       [Worker lsq-ai]
   cron   (Cron → scheduled(): daily chase + monthly report)   [on server]
```

Auth for every route below the `auth` service: a valid `session` cookie (D17),
then a grant whose role carries the listed permission and whose scope covers the
target (D18). `public` = no session (login only).

## auth · `/auth/*`

| Method | Path                | Perm    | Purpose                                         | UJ    |
| ------ | ------------------- | ------- | ----------------------------------------------- | ----- |
| POST   | `/auth/otp/request` | public  | Email a login code (always 204, no enumeration) | D17   |
| POST   | `/auth/otp/verify`  | public  | Verify code → set session cookie                | D17   |
| POST   | `/auth/logout`      | session | Delete current session                          | D17   |
| GET    | `/auth/me`          | session | Current account + effective grants/permissions  | UJ-09 |

## tickets · `/tickets/*`

| Method | Path                   | Perm             | Purpose                                          | UJ           |
| ------ | ---------------------- | ---------------- | ------------------------------------------------ | ------------ |
| GET    | `/tickets`             | `ticket:read`    | List tickets visible to caller (filters, paging) | UJ-09        |
| POST   | `/tickets`             | `ticket:create`  | Create ticket (creator picks category, optional) | UJ-01, UJ-05 |
| GET    | `/tickets/{id}`        | `ticket:read`    | Ticket detail + event timeline                   | UJ-02        |
| PATCH  | `/tickets/{id}`        | `ticket:update`  | Status / category (reassign) / flags             | UJ-06        |
| GET    | `/tickets/{id}/events` | `ticket:read`    | Timeline (comments, clock, chase)                | UJ-02        |
| POST   | `/tickets/{id}/events` | `ticket:comment` | Add a UI comment/update                          | UJ-02        |

## directory · identity, access, external parties

| Method | Path                       | Perm             | Purpose                                              | UJ           |
| ------ | -------------------------- | ---------------- | ---------------------------------------------------- | ------------ |
| GET    | `/accounts`                | `account:read`   | List accounts                                        | UJ-07        |
| POST   | `/accounts`                | `account:manage` | Create/invite an account                             | —            |
| GET    | `/accounts/{id}`           | `account:read`   | Account detail + grants                              | —            |
| PATCH  | `/accounts/{id}`           | `account:manage` | Rename / activate / deactivate                       | D17          |
| GET    | `/accounts/{id}/grants`    | `grant:read`     | Grants held by an account                            | UJ-09        |
| POST   | `/grants`                  | `grant:manage`   | Assign a role scoped to a thing (incl. ticket share) | UJ-08        |
| DELETE | `/grants/{id}`             | `grant:manage`   | Revoke a grant                                       | —            |
| GET    | `/roles`                   | `role:read`      | Roles + their permissions                            | —            |
| POST   | `/roles`                   | `role:manage`    | Create a role                                        | —            |
| PUT    | `/roles/{key}/permissions` | `role:manage`    | Set a role's permission set                          | —            |
| GET    | `/buildings`               | `dir:read`       | Buildings                                            | —            |
| POST   | `/buildings`               | `dir:manage`     | Add a building                                       | —            |
| GET    | `/buildings/{id}/units`    | `dir:read`       | Units in a building                                  | —            |
| POST   | `/units`                   | `dir:manage`     | Add a unit                                           | —            |
| GET    | `/organizations`           | `org:read`       | Agent + contractors                                  | —            |
| POST   | `/organizations`           | `org:manage`     | Add an organization                                  | —            |
| PATCH  | `/organizations/{id}`      | `org:manage`     | Edit an organization                                 | —            |
| GET    | `/senders`                 | `sender:read`    | Sender rules; `?status=new` = unknown queue          | UJ-04, UJ-07 |
| POST   | `/senders`                 | `sender:manage`  | Add an email/domain → org rule                       | UJ-07        |
| PATCH  | `/senders/{id}`            | `sender:manage`  | Link to org / ignore                                 | UJ-07        |
| DELETE | `/senders/{id}`            | `sender:manage`  | Remove a rule                                        | —            |

## scoring · `/score`, `/metrics`, `/reports`

| Method | Path                         | Perm            | Purpose                                             | UJ           |
| ------ | ---------------------------- | --------------- | --------------------------------------------------- | ------------ |
| GET    | `/score`                     | `score:read`    | Live fee + per-domain/metric breakdown (`?year=`)   | UJ-10        |
| GET    | `/metrics`                   | `metric:read`   | Metric config                                       | —            |
| PATCH  | `/metrics/{key}`             | `metric:manage` | Edit weight / mode / threshold / active             | D6           |
| GET    | `/metric-values`             | `metric:read`   | Manual/computed values (`?year=&metric=`)           | —            |
| POST   | `/metric-values`             | `metric:enter`  | Enter a manual value OR board dispute (superseding) | UJ-15, UJ-08 |
| PATCH  | `/metric-values/{id}/attest` | `metric:attest` | Board sign-off on a value                           | UJ-15        |
| GET    | `/reports/monthly`           | `report:read`   | Monthly performance report (`?month=YYYY-MM`)       | UJ-11        |

## engagement · `/surveys/*`, `/site-info`

| Method | Path                            | Perm             | Purpose                             | UJ    |
| ------ | ------------------------------- | ---------------- | ----------------------------------- | ----- |
| GET    | `/surveys`                      | `survey:read`    | Surveys (current + past)            | UJ-13 |
| POST   | `/surveys`                      | `survey:manage`  | Create a survey                     | UJ-14 |
| PATCH  | `/surveys/{id}`                 | `survey:manage`  | Open / close                        | UJ-14 |
| POST   | `/surveys/{id}/responses`       | `survey:respond` | Resident submits (one per resident) | UJ-13 |
| GET    | `/surveys/{id}/responses`       | `survey:manage`  | View responses                      | UJ-14 |
| PATCH  | `/surveys/{id}/responses/{rid}` | `survey:manage`  | Flag/unflag outlier                 | UJ-14 |
| GET    | `/site-info`                    | `config:read`    | Site info markdown (contacts etc.)  | —     |
| PUT    | `/site-info`                    | `config:manage`  | Replace site info markdown (admin)  | —     |

## Event-triggered workers (no HTTP)

Inbound email is split across two Workers plus a queue (D20); the cron stays on
`server`:

- **email** (`lsq-email`) — Cloudflare Email `email()`: parse
  `<id>@lansburysquare.co.uk`, reject unknown ticket ids at the door, stash the
  raw message in R2, and enqueue its key. Deliberately tiny (tight budget).
- **ai** (`lsq-ai`) — queue consumer: fetch raw from R2, resolve sender (UJ-04),
  AI summary unless "no ai" (UJ-16), append the `comment` `events` row (UJ-03).
  Failures retry, then dead-letter.
- **cron** (on `server`) — `scheduled()`: daily chase pass (UJ-12) and the
  monthly report on the configured day (`REPORT_DAY_OF_MONTH`, not fixed to the
  1st; UJ-11, same generator as `GET /reports/monthly`).
