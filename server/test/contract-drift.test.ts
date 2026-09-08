import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import openapiRaw from "../openapi.yaml?raw";
import { app } from "../src/app";

const VERBS = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const ALLOW_UNDOCUMENTED = new Set(["GET /health"]);

// Canonicalise path params: {id} and :id both → :p, drop trailing slash.
const norm = (p: string) =>
  p
    .replace(/\{[^}]+\}/g, ":p")
    .replace(/:[A-Za-z_]+/g, ":p")
    .replace(/\/+$/, "") || "/";

function specRoutes(): Set<string> {
  const doc = parse(openapiRaw) as { paths: Record<string, Record<string, unknown>> };
  const out = new Set<string>();
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const m of Object.keys(methods)) {
      if (VERBS.includes(m.toUpperCase())) out.add(`${m.toUpperCase()} ${norm(p)}`);
    }
  }
  return out;
}

function honoRoutes(): Set<string> {
  const out = new Set<string>();
  for (const r of app.routes) {
    if (!VERBS.includes(r.method)) continue; // skip ALL/middleware
    // Strip the /api mount prefix — OpenAPI documents the logical path.
    const path = norm(r.path).replace(/^\/api(?=\/|$)/, "") || "/";
    out.add(`${r.method} ${path}`);
  }
  return out;
}

describe("openapi contract drift", () => {
  it("registers no route that is missing from openapi.yaml", () => {
    const spec = specRoutes();
    const undocumented = [...honoRoutes()].filter(
      (r) => !spec.has(r) && !ALLOW_UNDOCUMENTED.has(r)
    );
    expect(undocumented, `undocumented routes: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("reports spec endpoints not yet implemented (informational)", () => {
    const hono = honoRoutes();
    const pending = [...specRoutes()].filter((r) => !hono.has(r));
    // Not an assertion yet — phases are still being delivered.
    if (pending.length) console.log(`[contract] not yet implemented (${pending.length}):\n  ` + pending.sort().join("\n  "));
    expect(true).toBe(true);
  });
});
