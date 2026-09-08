# SLA & Contractor-Response Tracking — OPEN DESIGN QUESTION

> **Status: not settled.** This is the hardest part of scoring and the least
> designed. It captures what we know and what still needs deciding before the
> Contractor Management and Resident & Board Service metrics can be computed. Do
> not treat anything here as final.

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
- `events.type = 'clock'` — reserved for SLA clock stamps (see
  [architecture.md](architecture.md) inbound flow: "update SLA clocks implied by
  actor_role").
- The daily Cron chase pass (D14) already sweeps open tickets — the natural place
  to *detect* a breached/near-deadline clock and stamp/notify.

## What still needs deciding

1. **Clock definitions as data or code?** One row per SLA rule (start trigger,
   responder role, working-day budget, stop condition) would keep it configurable
   like metrics. Or hard-code the ~6 clocks. Lean toward: start hard-coded, lift
   to config only if the rules churn.
2. **"Agent response expected" / "needs off-site contractor"** are judgement
   calls. `needs_contractor` flag covers one; the rest may need an agent-set flag
   or an inferred signal. Undecided.
3. **Where the clock state lives.** Recompute-on-read (consistent with on-demand
   scoring, D13) vs. materialised `clock` events written by the daily pass. The
   chase pass has to stamp *something* to notify on breach, so likely a hybrid:
   `clock` events for breaches, live recompute for the score.
4. **Working-day arithmetic** against the holiday + cleaning-schedule JSON config
   — shared helper, needs to be written and tested once.

## Manual exclusion escape hatch

We **cannot** anticipate every "extraordinary circumstance" the rubric excludes
(author-linked damage, out-of-hours criminal damage, sudden reactive faults,
etc.). Rather than model each exclusion reason, the plan is a **manual
scoring-exclusion** the agent/board can set on a ticket, with a reason recorded
on the audit spine, so a scoring query skips it.

Open: is exclusion all-or-nothing per ticket, or per-metric? Does it need board
attestation like a metric dispute? Shape not settled — add the column
(`tickets.excluded_from_scoring` + a `classify`/new event for the reason) only
once we've picked the granularity. Deliberately not in `schema.sql` yet.

## Next step

Spike one clock end-to-end (cleaning "1 working day") over real trial data before
generalising. The trial (see the provisional-category note in
[requirements.md](requirements.md)) will also tell us which clocks actually matter.
