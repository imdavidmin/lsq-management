import type { Env } from "../env";
import { run } from "../db/client";

// GDPR read-access audit (docs/gdpr.md). Append-only; written on PII-bearing
// reads only. There is deliberately NO read surface — reviewing the log is an
// out-of-band board tech-op against D1 directly.
export type AuditAction = "view" | "list" | "export";

export const logAccess = (
  env: Env,
  accountId: number,
  action: AuditAction,
  resourceType: string,
  resourceId?: number | string | null,
  detail?: unknown
) =>
  run(
    env.DB,
    "INSERT INTO access_log (at, account_id, action, resource_type, resource_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
    new Date().toISOString(),
    accountId,
    action,
    resourceType,
    resourceId == null ? null : String(resourceId),
    detail === undefined ? null : JSON.stringify(detail)
  );
