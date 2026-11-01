# Parked

Deliberately deferred while the scoring engine + SLA definitions land
([plan-scoring-sla.md](plan-scoring-sla.md)). Pick these up in the next
iteration.

## Features

- **Monthly report (UJ-11, D15).** Reuses the score function, limited to a
  month, plus the strong/weak/trend narrative. The cron entry point is stubbed
  at `server/src/scheduler/cron.ts` (report-day TODO), and `/reports/monthly` is
  in `openapi.yaml` but not implemented. Cheap once `/score` exists.
- **Cleaning on-site schedule (JSON config).** A per-contractor schedule so the
  cleaning "1 working day" counts only days the cleaner is on site. Until then
  the cleaning clock uses plain working days.
- **Manual scoring exclusion.** The "extraordinary circumstance" escape hatch
  (sla-tracking.md). Open questions: per ticket or per metric, and does it need
  board attestation? It also covers the `site.site_inspection` exclusions
  (author-linked damage, out-of-hours criminal damage). The UI toggle in
  `SlaPanel.tsx` is disabled until this lands.
- **Deadline-aware chase pass (UJ-12).** The chase pass only finds tickets with
  no update in 3 working days. It should chase near and overdue SLA deadlines
  using the same `lib/sla.ts` evaluator, and notify the responsible party instead
  of sending the board a digest (see the `ponytail:` note in `cron.ts`).
  This is part of contractor interactions.

## Housekeeping

- `server/src/config/holidays.json` ends 2026-12-28. Add 2027 UK bank holidays
  before January, or working-day maths will count them as working days.
- `docs/architecture.md`: intro still says "nightly scoring/chase engine"
  (superseded by D13), and it mentions a `classify.ts` that doesn't exist (AI
  classification was dropped, D5 revision).
