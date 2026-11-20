# Plan — Scoring engine + SLA definitions

> **Status: delivered (D21, D23), reworked for the ball model (D39–D43).** Steps 1–7
> are built, and the ball-model changes (pause, triage, schedule, `next_step`,
> duplicates, read-time email roles) are built on top. The appendix traces are
> worked scenarios checked against the evaluator; D21 links here, so move them
> before deleting this file.
> Out-of-scope items are parked in [parked.md](parked.md).

## Context

SLAs are **defined in the UI** as a few generic types that the system evaluates
from elapsed time between ticket events (D21). This replaces an earlier draft
that hard-coded SLA "clocks" in code. Agreed rules:

- SLAs change only at service-year end. A mid-year edit is allowed and accepted
  to re-score the year (scores are recomputed on read, D13).
- Scores are computed only for the **current** or **just-past** service year.
- At year end, the board generates the final score and stores a **snapshot in
  R2** (score + metric and SLA definitions + per-ticket results). Users must not
  edit SLAs until that snapshot is taken.
- The service year is a setting in the **`config` table**.
- The "no contractor reply in N days" rule is one 6-day SLA (D24). The daily
  cron only emails the agents when an instance is due today; it writes no event.
- **Acknowledged means triaged (D40).** A staff comment doesn't acknowledge; the
  agent's triage action does.
- **The ticket status says who has the ball (D39).** Time spent
  `awaiting_resident` or `awaiting_board` doesn't count against any SLA.
- "Enquiry sent" is **inferred automatically**: an agent emails a contractor with
  the ticket address in CC. "Contractor attended" is a **manual** marker added by
  the on-site team, with notes.

## The model: one generic SLA shape

An SLA = **applies-to filter** + **start event** + **stop event** + **budget
(working days)** + **repeats?** + the **metric** it feeds.

Event vocabulary, a fixed list in a new `common/sla.ts` shared by the server and
web (same pattern as `common/tickets.ts`):

| Kind | Value | Matches an `events` row where |
| --- | --- | --- |
| `ticket_created` | — | (start only) the ticket's creation |
| `scheduled` | — | (start only) a `schedule` event's date arriving (D41) |
| `status` | a `STATUSES` value | `type='status'` and `to_value` = value |
| `event_by` | `staff` \| `contractor` \| `resident` | any event whose `actor_role` is in the group (`staff` = agent, admin, site_staff — D31; `resident` includes `board` — D37). A null role (unknown email sender) matches no group until it is resolved (D43) |
| `marker` | `enquiry_sent` \| `attended` \| `triaged` | `type='marker'` and `to_value` = value |
| `flag` | `needs_contractor` | `type='flag'` and `to_value` = `needs_contractor:1` |
| `next_step` | — | (stop only) any `status` event or a `schedule` event; a comment doesn't match (D41) |

Statuses: `open` (with the agent), `awaiting_resident`, `pending_3rd_party`,
`awaiting_board`, `resolved`, `closed`.

Evaluation, in a pure function in `server/src/lib/sla.ts` that reuses
`workingDaysBetween` from `lib/workdays.ts`:

- Each start match creates one **instance**. With `repeats=0`, only the first
  match counts.
- The stop is the first matching event **strictly after** the start event.
- A `scheduled` start fires on the schedule event's date (midnight UTC), or the
  event's own time if it's later. Nothing runs before the date. A later
  `schedule` event, or a resolve/close, before the date cancels it (D41).
- **Pause (D39).** A status event into `awaiting_resident` or `awaiting_board`
  opens a paused span; the next status event out of those closes it, and a span
  still open runs to now. Days are whole working days: a working day is paused
  if the ticket was paused at the start of it, so a pause and release on the
  same day remove nothing. An instance's days = `wd(start, stop)` minus the
  paused working days inside it.
- Duplicates (`duplicate_of` set, D42) have no instances and are left out of
  every metric denominator.
- An instance is **met** if its days (after pause) `<= budget`. It is
  **breached** if stopped late, or still open past its budget. It is
  **running** if still open within budget, and is then excluded from scoring.
- A metric's value = tickets where **all** of that metric's SLA instances are met
  ÷ tickets with at least one finished or breached instance. That ratio handles
  the contractor metric's "ALL of" rule with no special case.
- The window is tickets created in the service year.

The seeded SLAs from the rubric:

| SLA | Metric | Applies to | Start → stop | Budget | Repeats |
| --- | --- | --- | --- | --- | --- |
| Cleaning resolved | `site.cleaning_tickets` | category=cleaning | ticket_created → status:resolved | 1 | no |
| Acknowledged | `res.ticket_acknowledgement` | all | ticket_created → marker:triaged | 2 | no |
| Back with agent | `res.ticket_acknowledgement` | all | status:open → next_step | 2 | yes |
| 3rd-party follow-up | `res.third_party_follow_up` | all | status:pending_3rd_party → next_step | 5 | yes |
| Follow-up on the date | `res.third_party_follow_up` | all | scheduled → next_step | 1 | yes |
| Enquiry to contractor | `con.contractor_attendance` | needs_contractor | flag:needs_contractor → marker:enquiry_sent | 2 | no |
| Reply to contractor | `con.contractor_attendance` | needs_contractor | event_by:contractor → event_by:staff | 2 | yes |
| Chase silent contractor | `con.contractor_attendance` | needs_contractor | marker:enquiry_sent → event_by:staff | 6 | yes |
| Update after attendance | `con.contractor_attendance` | needs_contractor | marker:attended → next_step | 2 | yes |

`site.site_inspection` stays a hard-coded ratio (an auto metric with no SLAs
linked).

## DB schema (in `migrations/0001_init.sql`)

```sql
-- SLA definitions (D21): evaluated on read against ticket events; never stored per ticket.
CREATE TABLE slas (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  metric_key       TEXT NOT NULL REFERENCES metrics(key),
  category         TEXT,                 -- NULL = any category
  needs_contractor INTEGER,              -- NULL = any; else 0/1
  start_on         TEXT NOT NULL CHECK (start_on IN ('ticket_created','scheduled','status','event_by','marker','flag')),
  start_value      TEXT,
  stop_on          TEXT NOT NULL CHECK (stop_on IN ('status','event_by','marker','flag','next_step')),
  stop_value       TEXT,
  budget_days      INTEGER NOT NULL CHECK (budget_days > 0),
  repeats          INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1
);
```

- The migration seeds the 9 rows above.
- New permissions: `sla:read` (seed for `agent`) and `sla:manage`, plus
  `score:snapshot`. Board and admin already have `*`.
- **No delete.** Deactivate instead (`active=0`).
- **Edits are audited on the spine (D7/D19):** each create or update appends
  `events(subject_type='sla', subject_id=id, type='config', from_value=<old
  JSON>, to_value=<new JSON>)`.
- **New `events.type` values:** `marker`, `config`, `flag`, `schedule` and
  `duplicate` (the column has no CHECK, so no schema change). The comment in
  `migrations/0001_init.sql` lists them.
- Values are validated with zod against `common/sla.ts`:
  - `start_value`/`stop_value` must fit their kind.
  - `metric_key` must be a `source='auto'` metric.

**Config.** Two rows in the existing `config` table, seeded by the migration:
`service_year_start = '08-01'` (MM-DD).

The service year is labelled by the calendar year it starts in. `/score` accepts
only the current or previous year; any other year returns a 400 via
`lib/errors.ts`.

**Snapshot.** Add an R2 binding `SNAPSHOTS` (bucket `lsq-score-snapshots`) to
the root `wrangler.jsonc` and `server/src/env.ts`.

- `POST /score/snapshots {year}` (`score:snapshot`) writes
  `snapshots/{year}/{takenAt}.json` containing the score, metrics, SLAs,
  per-ticket instances, and the year's `sla` config events. It also appends a
  `snapshot` event.
- `GET /score/snapshots` lists snapshots, and `GET /score/snapshots/{key}`
  downloads one.

## Signals feeding the markers

- **`triaged` (manual, D40).** `POST /tickets/{id}/triage` records the
  category, the contractor decision (a `flag` event if it changed) and a next
  step in one action. The marker body reads `Category: <cat>. Contractor: yes|no.`
  The next step is a status other than `open`, or a scheduled date
  (`POST /tickets/{id}/schedule` writes the `schedule` event).
- **`enquiry_sent` (automatic).** In `ai/src/process.ts`, once the sender
  resolves to `agent`, parse the `To` and `Cc` headers from the raw message
  (already fetched from R2). If any recipient matches a contractor sender rule,
  using the same email-then-domain lookup as `resolveSender`, also append a
  `marker` event with `to_value='enquiry_sent'`.
- **`attended` (manual).** Add `POST /tickets/{id}/markers
  {marker:'attended', notes}`, gated by `ticket:update`. On the ticket detail
  page, a "Contractor attended" button opens a dialog with a notes field. The
  notes go in the event `body`.

## Editor UI

The editor is a new **"SLAs"** tab in `web/src/features/scoring/PerformancePage.tsx`,
shown when `has("sla:read")`. It's editable only with `sla:manage`; agents get a
read-only view.

```
┌ SLAs ───────────────────────────────────────────────── [+ New SLA] ┐
│ ⚠ Service year 2025 has no snapshot yet — editing SLAs re-scores it. │
│                                                                     │
│ ▾ Resident & Board Service · res.ticket_acknowledgement, res.third_party_follow_up          │
│   Acknowledged          all tickets   created → staff reply   2 wd  ●│
│   3rd-party follow-up   all tickets   ⟳ pending → staff reply 5 wd  ●│
│ ▾ Contractor Management · con.contractor_attendance  (ticket passes if ALL met)│
│   Enquiry to contractor needs contr.  created → enquiry sent  2 wd  ●│
│   Reply to contractor   needs contr.  ⟳ contractor → staff    2 wd  ●│
│   ...                                                               │
└─────────────────────────────────────────────────────────────────────┘
```

Clicking a row, or "New SLA", opens a Fluent `OverlayDrawer` with a form you
read as a sentence:

```
Name        [ Reply to contractor              ]
Counts toward [ con.contractor_attendance ▾ ]

For  [ any category ▾ ]  tickets  [ needing a contractor ▾ ]
from [ an event by… ▾ ] [ contractor ▾ ]
until[ an event by… ▾ ] [ staff ▾ ]
within [ 2 ] working days    [x] Repeat each time the start happens

Preview: "For tickets needing a contractor, every contractor reply must
          get a staff response within 2 working days."
Active [●]                                   [Cancel] [Save]
```

- The value dropdown changes with the kind (statuses, role groups or markers),
  driven by `common/sla.ts`.
- Group rows by metric domain using the existing
  `web/src/components/CollapsibleGroup.tsx`.
- Hooks (`useSlas`, `useSaveSla`) go in `web/src/features/scoring/api.ts`,
  following the pattern of `useSaveMetrics`.
- The snapshot banner reads `GET /score/snapshots`.
- The **Dashboard** gets a "Take year-end snapshot" button (`score:snapshot`)
  and a list of past snapshots.

## Steps (one PR each, with its test)

1. **Decision and docs.** Add D21 (SLAs as data, evaluated on read, markers,
   config-driven no-reply detection, R2 snapshots). Rewrite
   `docs/plan/plan-scoring-sla.md` and the "what still needs deciding" section of
   `docs/sla-tracking.md`.
2. **Schema and config.** `slas` table in `0001_init.sql`, `common/sla.ts`,
   the SLA + `config` seed rows in `0002_seed.sql`.
3. **SLA API.** `GET/POST/PATCH /slas` in `server/src/segments/scoring/`
   (routes delegate to the service, gated with `requirePermission`), audit
   events, and `openapi.yaml` + `api.md`.
4. **Editor UI.** The SLAs tab and drawer described above.
5. **Signals.** The `enquiry_sent` inference in the ai Worker and the
   `attended` endpoint and button.
6. **Evaluator and score.** `lib/sla.ts`, then `/score` using it, limited to the
   current or previous year (part of the scoring segment from the earlier plan).
7. **Snapshots.** The R2 binding and the snapshot endpoints, plus the Dashboard
   button and list.

## Verification

- `npm install && npm test && npm run typecheck`. Dependencies aren't installed
  locally right now.
- `server/test/scoring.test.ts` (new):
  - SLA CRUD and its permissions (agent can read but not write).
  - An edit appends a `config` event.
  - Invalid kind/value pairs are rejected.
  - `/score` rejects a year older than the previous one.
- An evaluator unit test with event fixtures:
  - met, breached-stopped, breached-open, running.
  - Repeat instances.
  - Stop must come strictly after start.
  - A weekend/holiday crossing.
  - The "ALL of" per-ticket rule.
- `ai/test/process.test.ts`: an agent email with a contractor in Cc → a `marker`
  event; a resident email → no marker.
- `server/test/scheduler.test.ts`: the "due today" email goes out when an
  instance reaches its budget (no event written), and the D39 reminder (day 7)
  and auto-close (day 14) fire once.
- Manual: `npm run be` + `npm run fe`. Edit an SLA in the drawer, see the timeline event and
  score change, then take a snapshot and download it.

---

## Appendix — worked scenarios

Five estate scenarios, each followed through the events it writes and the
outcome of every SLA instance it starts. The numbers were checked against
`server/src/lib/sla.ts` and `workdays.ts`.

Conventions used in every scenario:

- **Dates.** Real 2026 dates: Nov 2 is a Monday. Working days exclude weekends
  and the bank holidays in `holidays.json` (none fall in these traces; Dec 25 and
  Dec 28 are the next ones). Times are UTC.
- **Working days.** `wd(a, b)` = `workingDaysBetween(a, b)`, which counts
  working days *after* `a`'s day up to and including `b`'s day. Same day → 0.
- **Event ordering.** Events are ordered by `(at, id)`. `ticket_created` sits
  before every event row. The ticket's creation events (comment, classify) are
  written by the creator, so a resident-created ticket can't be acknowledged
  by its own creation.
- **Triage writes several rows at the same time**, in this order: a `classify`
  event if the category changed, a `flag` event if the contractor decision
  changed, the `triaged` marker, then the next step (a `status` or `schedule` event).
- **Concierge and agent are one party (D40).** `site_staff` events match
  `event_by:staff`, but a staff comment never triages and never counts as a
  next step.
- **Service year.** Config `service_year_start = '08-01'`, so year 2026 runs
  from 2026-08-01 to 2027-07-31.
- **Instances shown** are those for the SLAs whose filter matches the ticket's
  *current* category and `needs_contractor`; SLAs with no instance are left out.

### 1. Trash left outside the bin stores (duplicate, 3rd party, schedule)

Two residents report the same mess. The concierge clears the bags, but a
mattress needs a council bulky collection.

**Ticket #201** (cleaning), created by the first resident. **#202** is the second
report.

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 1 | Mon 11-09 08:30 | resident | comment | "Bags and a mattress outside the bin stores" |
| 2 | Mon 11-09 08:30 | resident | classify | cleaning |
| 3 | Mon 11-09 11:00 | site_staff | comment | "Bags cleared. Mattress needs a council collection." |
| 4 | Mon 11-09 14:30 | agent | marker | triaged — "Category: cleaning. Contractor: no." |
| 5 | Mon 11-09 14:30 | agent | status | open → pending_3rd_party |
| 6 | Tue 11-10 09:00 | agent | schedule | 2026-11-12 — "Council collection booked" |
| 7 | Thu 11-12 10:00 | site_staff | comment | "Mattress collected" |
| 8 | Fri 11-13 09:30 | agent | status | pending_3rd_party → resolved |

**#202** (second resident, Mon 11-09 10:15) gets the agent's `duplicate` event
(`to_value=201`, Mon 14:00) and then a `status` event to `closed`. It has no
instances, and it is out of every metric (D42). Only #201 is counted.

Evaluator, #201:

| SLA | Start → stop | wd | Outcome |
| -- | -- | -- | -- |
| Cleaning resolved | 11-09 08:30 → #8 11-13 09:30 | 4 | **breached** (budget 1) |
| Acknowledged | creation → #4 11-09 14:30 | 0 | met. The concierge comment #3 isn't a `triaged` marker. |
| 3rd-party follow-up | #5 11-09 14:30 → #6 11-10 09:00 | 1 | met. The `schedule` event is the next step. |
| Follow-up on the date | 11-12 00:00 → #8 11-13 09:30 | 1 | met. #7 is only a comment. |

"Back with agent" never starts: the ticket was created `open` and was never
set back to it. The cleaning SLA is breached because the ticket stayed open
for the mattress. If the agent had resolved #201 on Monday and opened a
separate bulky-waste ticket for the council, "Cleaning resolved" would be 0 wd,
met. That choice is the agent's; the SLA only measures what is recorded.

### 2. Fob entry system down on a Friday evening (weekend, contractor, schedule)

Three residents report the fob system down. The agent deals with it by phone
over the weekend. That work isn't recorded and isn't measured: it is the
agent's responsibility, and nothing in the ticket log shows it.

**Ticket #210** (reactive_fault), created Fri 11-06 18:40. **#211** (Fri 19:05)
and **#212** (Sat 08:10) are the other reports, closed as duplicates of #210 on
Mon 11-09 09:05.

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 1 | Fri 11-06 18:40 | resident | comment | "Fobs not working at the main entrance" |
| 2 | Fri 11-06 18:40 | resident | classify | reactive_fault |
| 3 | Mon 11-09 09:20 | agent | flag | needs_contractor:0 → needs_contractor:1 |
| 4 | Mon 11-09 09:20 | agent | marker | triaged — "Category: reactive_fault. Contractor: yes." |
| 5 | Mon 11-09 09:20 | agent | status | open → pending_3rd_party |
| 6 | Mon 11-09 09:40 | agent | comment | email to the door-entry company, ticket address in Cc (`source=email`) |
| 7 | Mon 11-09 09:40 | agent | marker | enquiry_sent (inferred from the contractor domain rule) |
| 8 | Tue 11-10 11:15 | contractor | comment | "Controller board needs replacing, part on order" |
| 9 | Wed 11-11 10:00 | agent | comment | "Thanks, please confirm the visit date" |
| 10 | Wed 11-11 10:05 | agent | schedule | 2026-11-17 — "Engineer fitting new controller board" |
| 11 | Tue 11-17 12:00 | site_staff | marker | attended — "Board replaced, fobs working" |
| 12 | Wed 11-18 09:00 | agent | status | pending_3rd_party → resolved |

Events #3 to #7 are in the order the app writes them. Evaluator, #210, scored
Fri 11-20:

| SLA | Start → stop | wd | Outcome |
| -- | -- | -- | -- |
| Acknowledged | creation Fri 18:40 → #4 Mon 09:20 | 1 | met (the weekend adds no working days) |
| 3rd-party follow-up | #5 Mon 09:20 → #10 Wed 10:05 | 2 | met |
| Enquiry to contractor | #3 flag Mon 09:20 → #7 Mon 09:40 | 0 | met |
| Reply to contractor | #8 Tue 11:15 → #9 Wed 10:00 | 1 | met |
| Chase silent contractor | #7 Mon 09:40 → #9 Wed 10:00 | 2 | met. #8 is a contractor event, so it doesn't stop the chase. |
| Follow-up on the date | 11-17 00:00 → #12 Wed 11-18 09:00 | 1 | met |
| Update after attendance | #11 Tue 12:00 → #12 Wed 09:00 | 1 | met |

All four contractor-metric instances are met, so #210 passes
`con.contractor_attendance`. Its Acknowledged instance and its two
`res.third_party_follow_up` instances are also met, so it passes those metrics.

### 3. Intermittent hot water (pause, hand-back, late contractor flag, auto-close)

**Ticket #220** (reactive_fault), created Mon 11-02 09:00. The agent triages
it the next morning and asks the resident questions, so the next step is
`awaiting_resident`. The clock stops until the resident answers.

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 1 | Mon 11-02 09:00 | resident | comment | "Hot water cuts out for a few minutes most mornings" |
| 2 | Mon 11-02 09:00 | resident | classify | reactive_fault |
| 3 | Tue 11-03 10:00 | agent | comment | "Which flat and which taps? Is it always the morning?" |
| 4 | Tue 11-03 10:00 | agent | marker | triaged — "Category: reactive_fault. Contractor: no." |
| 5 | Tue 11-03 10:00 | agent | status | open → awaiting_resident |

Acknowledged: creation → #4 = **1 wd, met**. The ticket is now paused.

**Resident replies from an unknown work email.** On Fri 11-06 18:30 the resident
answers from `alice@bigcorp.example`, an address that isn't on any account or
sender rule. The ai Worker writes the comment with `actor_role` null
(D43), then, because the sender isn't staff, hands the ticket back:

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 6 | Fri 11-06 18:30 | null | comment | "Flat 12, all taps, 7 to 8am" (`source=email`, `actor_email` set) |
| 7 | Fri 11-06 18:30 | system | status | awaiting_resident → open (`source=system`) |

The null role matches no `event_by` group, so the comment starts and stops
nothing. The status event #7 starts **Back with agent**. The paused span
Tue 10:00 → Fri 18:30 ends before the instance starts, so it removes nothing.

**Agent silent.** Nothing follows. Scored Wed 11-11: `wd(Nov 6, Nov 11)` = 3
(Nov 9, 10, 11), so **breached while open** (budget 2). On Thu 11-12 it is 4.
The ticket's `sla_due` is null while it is `awaiting_resident`, and shows the
overdue instance once it's back to `open`.

**Contractor flagged later.** On Mon 11-16 the agent finally decides it needs
the plumber and moves the ticket on:

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 8 | Mon 11-16 09:30 | agent | flag | needs_contractor:0 → needs_contractor:1 |
| 9 | Mon 11-16 09:35 | agent | status | open → pending_3rd_party |
| 10 | Mon 11-16 11:00 | agent | comment | email to the plumber, Cc ticket address |
| 11 | Mon 11-16 11:00 | agent | marker | enquiry_sent |

Evaluator, scored Fri 11-20:

| SLA | Start → stop | wd | Outcome |
| -- | -- | -- | -- |
| Acknowledged | creation → #4 | 1 | met |
| Back with agent | #7 Fri 11-06 18:30 → #9 Mon 11-16 09:35 | 6 | **breached** (stopped late) |
| Enquiry to contractor | #8 Mon 09:30 → #11 Mon 11:00 | 0 | met |
| 3rd-party follow-up | #9 Mon 11-16 09:35 → none | 4 | running (budget 5) |
| Chase silent contractor | #11 Mon 11:00 → none | 4 | running (budget 6) |

"Enquiry to contractor" starts at the flag (D40), not at creation, and not
retroactively: the 10 working days since creation aren't charged to it. The
late decision is charged to "Back with agent". The contractor SLAs apply only
because `needs_contractor` is now 1, and the flag start doesn't exist before #8.

**Variant: the resident never replies.** The ticket stays `awaiting_resident`
from Tue 11-03 10:00, and the daily cron (every day, not only working days, D39)
acts on calendar days:

- **Tue 11-10 (day 7).** The cron emails the creator "We're still waiting for
  your reply…". No event is written.
- **Tue 11-17 (day 14).** The cron appends `{actor_role: system, type: status,
  awaiting_resident → closed, body: "Closed after 14 days awaiting the
  resident."}`, sets `closed_at`, and emails the creator that the ticket is
  closed.

Acknowledged is met (1 wd), "Back with agent" never started, and nothing
breached while the ticket was waiting for the resident.

### 4. Lift noise (concierge comment, off-ticket reply, chase, board pause)

**Ticket #230** (communal_repair), created Mon 11-02 07:50. The concierge
passes it on, which does not acknowledge it (D40).

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 1 | Mon 11-02 07:50 | resident | comment | "Grinding noise from the lift in block B" |
| 2 | Mon 11-02 07:50 | resident | classify | communal_repair |
| 3 | Mon 11-02 08:30 | site_staff | comment | "Heard it myself, passing to the agent" |
| 4 | Tue 11-03 09:15 | agent | flag | needs_contractor:0 → needs_contractor:1 |
| 5 | Tue 11-03 09:15 | agent | marker | triaged — "Category: communal_repair. Contractor: yes." |
| 6 | Tue 11-03 09:15 | agent | status | open → pending_3rd_party |
| 7 | Tue 11-03 09:45 | agent | comment | email to the lift company, Cc ticket address |
| 8 | Tue 11-03 09:45 | agent | marker | enquiry_sent |

Acknowledged: creation → #5 = 1 wd, **met** (the concierge comment #3 didn't
stop it). Enquiry to contractor: #4 → #8 = 0 wd, **met**.

**Reply arrives off-ticket.** On Wed 11-04 the lift company replies to the
agent only, without the ticket address. No event is written, so no "Reply to
contractor" instance starts, and the thread looks silent. The "due today" cron
email for "Chase silent contractor" would go out on Wed 11-11, the day the
instance reaches 6 wd (Nov 4, 5, 6, 9, 10, 11).

On Mon 11-09 the agent reads that email, records the engineer's date, and sends
a confirmation with the ticket in Cc:

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 9 | Mon 11-09 10:15 | agent | schedule | 2026-11-12 — "Engineer visit per lift co. email of 4 Nov" |
| 10 | Mon 11-09 10:30 | agent | comment | email to the lift company, Cc ticket address |
| 11 | Mon 11-09 10:30 | agent | marker | enquiry_sent |

- 3rd-party follow-up: #6 Nov 3 → #9 Nov 9 = 4 wd, **met**.
- Chase silent contractor, instance A: #8 Nov 3 09:45 → #9 Nov 9 10:15 = 4 wd,
  **met**. Instance B starts at #11.

**Engineer attends Thu 11-12.** The concierge records the attendance and the
agent adds a comment, but the comment doesn't end "Update after attendance":

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 12 | Thu 11-12 11:30 | site_staff | marker | attended — "Guide rollers worn, quote to follow" |
| 13 | Thu 11-12 14:00 | agent | comment | "Thanks, chasing the quote" |
| 14 | Fri 11-13 09:00 | agent | schedule | 2026-11-19 — "Quote due" |

- Chase instance B: #11 → #12 (site staff count as staff) = 3 wd, **met**.
- Update after attendance: #12 Thu 11:30 → #14 Fri 09:00 = 1 wd, **met**. The
  comment #13 isn't a next step; #14 is.
- Follow-up on the date (Nov 12): starts 11-12 00:00, stops at #14 =
  1 wd, **met**.

**Quote arrives, board approval needed.** The lift company sends the quote on
Thu 11-19, on-ticket. The agent puts it to the board next day. The board meets
on Wed 12-02, and the lift company chases the agent again while the ticket
waits.

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 15 | Thu 11-19 09:00 | contractor | comment | quote, £4,800 (`source=email`) |
| 16 | Fri 11-20 10:00 | agent | status | pending_3rd_party → awaiting_board |
| 17 | Mon 11-23 09:00 | contractor | comment | "Any decision on the quote?" |
| 18 | Thu 12-03 09:00 | board | comment | "Approved at the 2 Dec meeting, please proceed" |
| 19 | Thu 12-03 09:00 | board | status | awaiting_board → open (by hand) |
| 20 | Thu 12-03 14:00 | agent | comment | email to the lift company, order confirmed |
| 21 | Fri 12-04 11:00 | agent | schedule | 2026-12-14 — "Guide roller replacement" |

The ticket is paused from #16 (Nov 20 10:00) to #19 (Dec 3 09:00).

- Reply to contractor, from #15: stopped by #16 (a staff event) = 1 wd, **met**.
  Follow-up on the date (Nov 19): stopped by #16 = 1 wd, **met**.
- Reply to contractor, from #17 Mon 11-23: stopped by #20 Thu 12-03. Raw
  `wd(Nov 23, Dec 3)` = 8. Every one of those working days started paused, so
  all 8 are removed. Days = **0, met**. Without the pause it would be 8,
  breached.
- Back with agent, from #19 Dec 3 09:00: the span ends at the instance's start,
  so nothing is removed. Stopped by #21 = 1 wd, **met**.

The works date #21 (Dec 14) starts "Follow-up on the date" on that day; scored
Fri 12-11 it hasn't started. #230 passes every instance, so it passes
`con.contractor_attendance`.

### 5. Corridor cleanliness complaint (cleaning resolved, no reopen)

Residents complain about a dirty corridor, but the cleaners are on site every
day.

**Ticket #240** (cleaning), created Mon 11-16 10:00. The agent triages and
resolves it in one action.

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 1 | Mon 11-16 10:00 | resident | comment | "3rd floor corridor is filthy" |
| 2 | Mon 11-16 10:00 | resident | classify | cleaning |
| 3 | Tue 11-17 10:00 | agent | marker | triaged — "Category: cleaning. Contractor: no." |
| 4 | Tue 11-17 10:00 | agent | status | open → resolved |

- Cleaning resolved: creation → #4 = **1 wd, met** (budget 1).
- Acknowledged: creation → #3 = 1 wd, **met**.

The resident disagrees on Wed 11-18. They can't set the status back to
`open`: the API returns 400 ("a resolved or closed ticket can't be reopened",
D39). They raise a new ticket instead.

**Ticket #241**, created Thu 11-19 09:00 as `cleaning`. The agent decides it is
about the service level, not a missed clean:

| id | at | actor_role | type | value / body |
| -- | -- | -- | -- | -- |
| 5 | Thu 11-19 09:00 | resident | comment | "The corridor is still dirty, cleaners aren't doing the corners" |
| 6 | Thu 11-19 09:00 | resident | classify | cleaning |
| 7 | Thu 11-19 15:00 | agent | classify | complaint |
| 8 | Thu 11-19 15:00 | agent | marker | triaged — "Category: complaint. Contractor: no." |
| 9 | Thu 11-19 15:00 | agent | schedule | 2026-11-23 — "Walk-round with the cleaning contractor" |
| 10 | Tue 11-24 10:00 | agent | status | open → resolved |

The filter uses the ticket's current category, so "Cleaning resolved" doesn't
apply to #241 and it doesn't enter the cleaning metric. Acknowledged: 0 wd,
**met**. Follow-up on the date: 11-23 00:00 → #10 = 1 wd, **met**.

### Roll-up: from SLA instances to the fee

`GET /score?year=2026` (on Nov 26, 2026):

1. Check the year is the current or previous service year. 2026 is current, so
   proceed. 2024 would get a 400.
2. Load the active `slas` grouped by `metric_key`, the tickets created between
   2026-08-01 and 2027-07-31, and their ticket events. That's one query each.
3. Work out each ticket's instances for each metric, and drop the running ones.
   Tickets with `duplicate_of` set (#202, #211, #212) are skipped entirely.
4. Take `res.ticket_acknowledgement` (2 SLAs) as an example, over the scenario
   tickets #201, #210, #220, #230, #240 and #241:
   - #220 fails: "Back with agent" was breached.
   - The other five pass: Acknowledged and any "Back with agent" instances met.
   - Value = 5/6 = 0.833. The metric is proportional with threshold 0.90, so
     the result is 0.833/0.90 = 0.926.
   - It contributes 0.060 × 0.926 = **0.056** to `projected_fee_ratio`.
   - For `con.contractor_attendance` (4 SLAs), #210 and #230 pass. #220 is breached
     by Nov 26 on Chase silent contractor (and on 3rd-party follow-up in
     `res.third_party_follow_up`), so the value is 2/3 = 0.667, the result
     is 0.667/0.85 = 0.784, and it contributes 0.0525 × 0.784 = **0.041**.
5. Manual and survey metrics are read from `metric_values` as before, and the
   fee is Σ(weight × result).
   - **Projection.** For the ongoing service year, a manual or survey metric
     with no stored value (or a survey below its 50-response gate) is
     **assumed met** (result 1) and returned with `pending: true`, so the fee
     is a best-case projection. For the just-past year it scores 0.

### Year end: snapshot, then edit

1. Mon Aug 2, 2027. The board clicks **Take year-end snapshot** for 2026
   (`POST /score/snapshots {year:2026}`).
   - The full evaluation is written to R2 at
     `snapshots/2026/2027-08-02T09:00:00Z.json`.
   - A `snapshot` event is appended.
   - The banner in the SLA editor ("2026 has no snapshot") disappears.
2. The board changes "Acknowledged" from 2 to 3 wd.
   - This appends a `config` event with `subject_type='sla'`, where
     `from_value` is the old JSON and `to_value` the new.
   - Viewing `/score?year=2026` again now re-scores 2026 under the new rule, as
     agreed.
   - The R2 snapshot still holds the official 2026 figures.
