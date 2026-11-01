// Thin typed helpers over D1. Raw SQL by design (no ORM).

export async function one<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  return (await db
    .prepare(sql)
    .bind(...params)
    .first<T>()) as T | null;
}

export async function all<T>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const res = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return res.results ?? [];
}

export async function run(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<D1Result> {
  return db
    .prepare(sql)
    .bind(...params)
    .run();
}

// Row shapes shared across segments (mirror migrations/0001_init.sql).
export interface Account {
  id: number;
  email: string;
  name: string;
  active: number;
}

export interface Grant {
  id: number;
  account_id: number;
  role_key: string;
  scope_type: "estate" | "building" | "unit" | "organization" | "ticket";
  scope_id: number | null;
}

// Every caller that loads a session's grants selects the same columns; keep the
// query in one place so the column list can't drift.
export const grantsForAccount = (db: D1Database, accountId: number) =>
  all<Grant>(
    db,
    "SELECT id, account_id, role_key, scope_type, scope_id FROM grants WHERE account_id = ?",
    accountId
  );
