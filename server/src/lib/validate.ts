import type { Context } from "hono";
import type { ZodTypeAny, z } from "zod";
import { badRequest } from "./errors";

// Numeric ":id" path param, used by every segment's routes.
export const idParam = (c: { req: { param(k: string): string } }) => Number(c.req.param("id"));

// Parse+validate a JSON body against a Zod schema mirroring openapi.yaml.
export async function body<T extends ZodTypeAny>(
  c: Context,
  schema: T
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    badRequest("invalid JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    badRequest(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}
