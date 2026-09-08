// Role precedence, shared by the server (event attribution, RBAC) and the ai
// Worker (email sender → actor_role). Dependency-free: takes anything with a
// role_key, so it doesn't couple to the server's Grant type.
const PRECEDENCE = ["admin", "board", "agent", "contractor", "resident"] as const;

// Most privileged role the holder carries — stamped on events, later driving
// SLA-clock derivation (agent reply vs resident update).
export function primaryRole(grants: { role_key: string }[]): string {
  const roles = new Set(grants.map((g) => g.role_key));
  for (const r of PRECEDENCE) if (roles.has(r)) return r;
  return "resident";
}
