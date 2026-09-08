export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher; // built web/dist (SPA); absent in tests. See app.ts notFound.
  OTP_LIMIT?: import("./lib/ratelimit").RateLimiter; // per-IP/email OTP cap
  API_LIMIT?: import("./lib/ratelimit").RateLimiter; // lax global per-IP cap
  // vars
  EMAIL_DOMAIN: string;
  MAIL_FROM: string;
  BOARD_EMAIL: string;
  REPORT_DAY_OF_MONTH: string; // day-of-month the monthly report fires
  // secrets
  MAILERSEND_API_KEY?: string;
  // Dev-only (.dev.vars): auto-authenticate as this email, skipping OTP. See session.ts.
  DEV_LOGIN_EMAIL?: string;
}

// Hono variables set by middleware and read by handlers.
export interface Vars {
  account: import("./db/client").Account;
  grants: import("./db/client").Grant[];
}

export type AppContext = { Bindings: Env; Variables: Vars };
