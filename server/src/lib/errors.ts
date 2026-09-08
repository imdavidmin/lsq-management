import { HTTPException } from "hono/http-exception";

// Shape matches components/schemas/Error in openapi.yaml.
export function fail(status: number, error: string, message?: string): never {
  throw new HTTPException(status as 400, {
    res: Response.json({ error, message }, { status }),
  });
}

export const badRequest = (m?: string) => fail(400, "bad_request", m);
export const unauthorized = (m?: string) => fail(401, "unauthorized", m);
export const forbidden = (m?: string) => fail(403, "forbidden", m);
export const notFound = (m?: string) => fail(404, "not_found", m);
export const conflict = (m?: string) => fail(409, "conflict", m);
export const rateLimited = (m?: string) => fail(429, "rate_limited", m);
