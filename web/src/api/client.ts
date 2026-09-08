// Thin fetch wrapper. Same-origin: the API is mounted under /api on this origin
// (in dev, Vite proxies /api → wrangler). The session cookie rides along via
// credentials:"include"; there are no tokens to manage client-side (D17).

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

// Set by AuthProvider so a 401 anywhere kicks the user back to login.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

type Options = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
};

export async function request<T>(path: string, opts: Options = {}): Promise<T> {
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    credentials: "include",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, "unauthorized");
  }

  if (!res.ok) {
    // Error responses follow the OpenAPI Error schema { error, message }.
    const err = await res.json().catch(() => ({ error: "http_error" }));
    throw new ApiError(res.status, err.error ?? "http_error", err.message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
