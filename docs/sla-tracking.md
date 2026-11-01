# SLA & Contractor-Response Tracking

> **Status: core model settled (D21).** The design questions below are answered
> in "Settled by D21"; implementation is tracked in
> [plan/plan-scoring-sla.md](plan/plan-scoring-sla.md). The manual scoring exclusion is
> still open.

## The problem

The scoring rubric ([requirements.md](requirements.md)) asks for things that are
easy to state and hard to compute from ticket data, e.g.:

- "initial enquiry to contractor within **2 working days** of ticket creation"
- "if no contractor response within **5 working days**, follow-up within **1
  further working day**"
- "after each contractor attendance, ticket updated within **2 working days**"
- ">=90% of cleaning tickets resolved within **1 working day**"
- ">=90% of tickets acknowledged within **2 business days**"

Each needs a **clock**: a start stamp, an expected responder, and a stop stamp —
derived from `events`, not stored as bespoke columns.

## What we already have to build on

- `events.actor_role` (resident|agent|admin|contractor|system) — tells us *who*
  moved a ticket, which is the basis for "agent replied", "contractor replied".
- `events.type = 'clock'` — originally reserved for SLA clock stamps; unused
  under D21.
- The daily Cron chase pass (D14) already sweeps open tickets — the natural place
  to *detect* a breached/near-deadline clock and stamp/notify.

## Settled by D21

1. **Definitions are data.** One `slas` row per rule (filter, start, stop,
   working-day budget, repeats), edited in the UI.
2. **Judgement signals become markers.** `enquiry_sent` is inferred from agent
   email CC'ing a contractor, `contractor_no_reply` is injected by the cron,
   `attended` is entered by the on-site team. "Agent response expected" = any
   contractor event starts a staff-reply SLA.
3. **State is recomputed on read**, no `clock` events. The cron only stamps
   `contractor_no_reply` markers and chases.
4. **Working-day arithmetic** is `server/src/lib/workdays.ts` (holidays only;
   the cleaning schedule is parked, see [plan/parked.md](plan/parked.md)).

Plan and worked traces per SLA: [plan/plan-scoring-sla.md](plan/plan-scoring-sla.md).

## Manual exclusion escape hatch

We **cannot** anticipate every "extraordinary circumstance" the rubric excludes
(author-linked damage, out-of-hours criminal damage, sudden reactive faults,
etc.). Rather than model each exclusion reason, the plan is a **manual
scoring-exclusion** the agent/board can set on a ticket, with a reason recorded
on the audit spine, so a scoring query skips it.

Open: is exclusion all-or-nothing per ticket, or per-metric? Does it need board
attestation like a metric dispute? Shape not settled — add the column
(`tickets.excluded_from_scoring` + a `classify`/new event for the reason) only
once we've picked the granularity. Deliberately not in `migrations/0001_init.sql` yet.

## Next step

Validate the seeded SLAs against real trial data (see the provisional-category
note in [requirements.md](requirements.md)); the trial will show which SLAs
actually matter and whether the budgets hold.
