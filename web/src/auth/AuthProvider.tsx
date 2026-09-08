import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ApiError, request, setUnauthorizedHandler } from "../api/client";
import type { Identity } from "../api/types";
import { permMatch } from "../../../common/permissions";

type AuthState = {
  identity: Identity | null;
  loading: boolean;
  permissions: Set<string>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setIdentity(await request<Identity>("/auth/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setIdentity(null);
      else throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await request<void>("/auth/logout", { method: "POST" });
    setIdentity(null);
  }, []);

  useEffect(() => {
    // Any 401 from anywhere clears the session and drops back to login.
    setUnauthorizedHandler(() => setIdentity(null));
    void refresh();
  }, [refresh]);

  const permissions = new Set(identity?.permissions ?? []);

  return (
    <AuthCtx.Provider value={{ identity, loading, permissions, refresh, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

// permMatch is shared with the server (common/permissions.ts) so gating can't drift.
function covers(held: Set<string>, required: string): boolean {
  for (const h of held) if (permMatch(h, required)) return true;
  return false;
}

export function usePermissions() {
  const { permissions } = useAuth();
  return {
    has: (perm: string) => covers(permissions, perm),
    hasAny: (...perms: string[]) => perms.some((p) => covers(permissions, p)),
  };
}
