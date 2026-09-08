import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "../env";
import type { Grant } from "../db/client";
import { all } from "../db/client";
import { forbidden } from "../lib/errors";
import { grantCoversChain, resolveChain, type ScopeRef } from "../lib/scope";
import { permMatch } from "../../../common/permissions";

async function grantsWithPermission(
  c: Context<AppContext>,
  permission: string
): Promise<Grant[]> {
  const grants = c.get("grants");
  const roleKeys = [...new Set(grants.map((g) => g.role_key))];
  if (roleKeys.length === 0) return [];
  const rows = await all<{ role_key: string; permission: string }>(
    c.env.DB,
    `SELECT role_key, permission FROM role_permissions
       WHERE role_key IN (${roleKeys.map(() => "?").join(",")})`,
    ...roleKeys
  );
  const rolesWithPerm = new Set(
    rows.filter((r) => permMatch(r.permission, permission)).map((r) => r.role_key)
  );
  return grants.filter((g) => rolesWithPerm.has(g.role_key));
}

// Gate: caller must hold `permission` in some grant. If `scope` is given, at
// least one of those grants must cover that resource (D18).
export function requirePermission(
  permission: string,
  scope?: (c: Context<AppContext>) => ScopeRef | Promise<ScopeRef>
): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const eligible = await grantsWithPermission(c, permission);
    if (eligible.length === 0) forbidden(`missing permission: ${permission}`);

    if (scope) {
      const ref = await scope(c);
      const chain = await resolveChain(c.env.DB, ref);
      if (!eligible.some((g) => grantCoversChain(g, chain)))
        forbidden(`out of scope for ${permission}`);
    }
    await next();
  };
}

// For list endpoints: the set of grants that carry a read permission, so the
// service can filter rows to what the caller may see.
export async function readableGrants(
  c: Context<AppContext>,
  permission: string
): Promise<Grant[]> {
  return grantsWithPermission(c, permission);
}
