import { one } from "../db/client";
import type { Grant } from "../db/client";

export type ScopeType = Grant["scope_type"];
export interface ScopeRef {
  type: ScopeType;
  id: number | null;
}

// The chain of scopes that could cover a target resource, most specific first,
// always ending at estate. A grant covers the target if it matches any link.
export async function resolveChain(
  db: D1Database,
  ref: ScopeRef
): Promise<ScopeRef[]> {
  const estate: ScopeRef = { type: "estate", id: null };
  switch (ref.type) {
    case "estate":
      return [estate];
    case "organization":
      return [{ type: "organization", id: ref.id }, estate];
    case "building":
      return [{ type: "building", id: ref.id }, estate];
    case "unit": {
      const chain: ScopeRef[] = [{ type: "unit", id: ref.id }];
      const u = await one<{ building_id: number }>(
        db,
        "SELECT building_id FROM units WHERE id = ?",
        ref.id
      );
      if (u) chain.push({ type: "building", id: u.building_id });
      chain.push(estate);
      return chain;
    }
    case "ticket": {
      const chain: ScopeRef[] = [{ type: "ticket", id: ref.id }];
      const t = await one<{ building_id: number | null; unit_id: number | null }>(
        db,
        "SELECT building_id, unit_id FROM tickets WHERE id = ?",
        ref.id
      );
      if (t?.unit_id != null) chain.push({ type: "unit", id: t.unit_id });
      if (t?.building_id != null) chain.push({ type: "building", id: t.building_id });
      chain.push(estate);
      return chain;
    }
  }
}

// A scope ref covers a chain if any link matches its type (estate matches any id).
export function refInChain(chain: ScopeRef[], ref: ScopeRef): boolean {
  return chain.some((s) => s.type === ref.type && (ref.type === "estate" || s.id === ref.id));
}

export function grantCoversChain(grant: Grant, chain: ScopeRef[]): boolean {
  return refInChain(chain, { type: grant.scope_type, id: grant.scope_id });
}
