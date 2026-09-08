import holidayConfig from "../config/holidays.json";

const HOLIDAYS = new Set<string>(holidayConfig.holidays);

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

// Mon–Fri and not a configured holiday/closure (UTC).
export function isWorkingDay(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(dayKey(d));
}

// Working days elapsed from `start` to `end`: count working calendar days after
// start's day, up to and including end's day. Same day (or end<start) → 0.
// So "resolved within 1 working day" ⇔ workingDaysBetween(created, resolved) <= 1.
export function workingDaysBetween(start: string | Date, end: string | Date): number {
  const a = new Date(start);
  const b = new Date(end);
  if (b <= a) return 0;
  let count = 0;
  const cur = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
  const last = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()));
  while (cur < last) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (isWorkingDay(cur)) count++;
  }
  return count;
}
