import { Request, Response } from "express";
import { env } from "../config/env";

export const ADMIN_SESSION_COOKIE = "mailcore_admin_session";
export const ADMIN_CSRF_COOKIE = "mailcore_admin_csrf";

export function parseCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { return undefined; }
  }
  return undefined;
}

const cookieBase = {
  secure: env.sessionCookieSecure,
  sameSite: "strict" as const,
  path: "/"
};

export function setAdminSessionCookies(res: Response, token: string, csrfToken: string, maxAgeSeconds: number): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  const maxAge = Math.max(1, maxAgeSeconds) * 1000;
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    ...cookieBase,
    httpOnly: true,
    maxAge
  });
  res.cookie(ADMIN_CSRF_COOKIE, csrfToken, {
    ...cookieBase,
    httpOnly: false,
    maxAge
  });
}

export function clearAdminSessionCookies(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.clearCookie(ADMIN_SESSION_COOKIE, { ...cookieBase, httpOnly: true });
  res.clearCookie(ADMIN_CSRF_COOKIE, { ...cookieBase, httpOnly: false });
}
