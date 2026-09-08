import type { ReactNode } from "react";
import { usePermissions } from "./AuthProvider";

// UX-only gate: hides affordances the caller can't use. The server always
// enforces (D18) — this never grants access, it only declutters.
export function Can({
  perm,
  anyOf,
  children,
  fallback = null,
}: {
  perm?: string;
  anyOf?: string[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { has, hasAny } = usePermissions();
  const ok = perm ? has(perm) : anyOf ? hasAny(...anyOf) : true;
  return <>{ok ? children : fallback}</>;
}
