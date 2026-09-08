import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const NAME = "session";

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, NAME);
}

export function setSessionCookie(c: Context, token: string, maxAgeSec: number) {
  setCookie(c, NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: maxAgeSec,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, NAME, { path: "/" });
}
