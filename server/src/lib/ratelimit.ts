// Cloudflare Workers native rate limiting binding (configured in wrangler.jsonc).
// The binding runs in-Worker, so it caps the *work* (DB reads, email sends) per
// invocation — not the invocation itself. The free WAF rate-limiting rule on
// /auth/otp/* is the edge-level stop for raw invocation floods (deploy task).
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

// Returns true when the request is allowed. Absent binding (Vitest pool / local
// dev without config) → allow, so tests and `wrangler dev` don't need it wired.
export async function rateLimit(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}
