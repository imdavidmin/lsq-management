// Permission-match logic shared by server RBAC (middleware/rbac.ts) and web UI
// gating (auth/AuthProvider.tsx). A held grant covers a required permission if
// it's '*', the exact permission, or the 'ns:*' wildcard for that namespace.
export function permMatch(held: string, required: string): boolean {
  if (held === "*" || held === required) return true;
  if (held.endsWith(":*")) return required.startsWith(held.slice(0, -1));
  return false;
}
