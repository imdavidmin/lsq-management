import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./env";
import { rateLimit } from "./lib/ratelimit";
import { rateLimited } from "./lib/errors";
import { auth } from "./segments/auth/routes";
import { tickets } from "./segments/tickets/routes";
import { directory } from "./segments/directory/routes";
import { engagement } from "./segments/engagement/routes";

export const app = new Hono<AppContext>();

// Global per-IP cap (lax) on every endpoint — a billing/DoS backstop, distinct
// from the tight OTP limits. Absent binding (tests/dev) → allow.
app.use("*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await rateLimit(c.env.API_LIMIT, `api:${ip}`))) rateLimited("slow down");
  await next();
});

// API surface mounted under /api; the root path is served as the frontend's
// static assets by wrangler. OpenAPI documents the logical paths (no /api).
const api = new Hono<AppContext>();
api.get("/health", (c) => c.json({ ok: true }));
api.route("/auth", auth); // segment routers mounted as each phase is delivered
api.route("/tickets", tickets);
api.route("/", directory); // accounts, grants, roles, buildings, units, orgs, senders
api.route("/", engagement); // surveys, site info
app.route("/api", api);

app.notFound((c) => {
  // Non-/api misses are SPA deep-links; serve index.html for client routing.
  if (c.req.path.startsWith("/api/") || !c.env.ASSETS)
    return c.json({ error: "not_found" }, 404);
  return c.env.ASSETS.fetch(new URL("/index.html", c.req.url));
});
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error("unhandled", err);
  return c.json({ error: "internal" }, 500);
});
