import type { NextFunction, Request, Response } from "express";
import { authContextFromToken, type AuthContext } from "../lib/portal-store";

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
        rawBody?: Buffer;
    }
  }
}

function bearerToken(req: Request): string | null {
  const authorization = req.header("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim() || null;
  return req.cookies?.hydranms_session ?? null;
}

export async function requirePortalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = bearerToken(req);
    const auth = token ? await authContextFromToken(token) : null;
    if (!auth) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.auth = auth;
    const requestedCompany = req.header("x-company-id");
    if (
      auth.user.role !== "super_admin" &&
      requestedCompany &&
      requestedCompany !== auth.companyId
    ) {
      res.status(403).json({ error: "You do not have access to this company" });
      return;
    }
    if (
      (req.path === "/companies" || req.path.startsWith("/companies/")) &&
      (req.method === "GET" || req.method === "POST" || req.method === "PATCH" || req.method === "DELETE") &&
      auth.user.role !== "super_admin"
    ) {
      res.status(403).json({ error: "Super-admin access required" });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: "Authentication required" });
  }
}

export async function optionalPortalAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = bearerToken(req);
    if (token) {
      req.auth = (await authContextFromToken(token)) ?? undefined;
    }
  } catch {
    // Checkout remains available to pending companies using the public registration flow.
  }
  next();
}

export function isPublicPortalRoute(req: Request): boolean {
  return (
    (req.path === "/plans" && req.method === "GET") ||
    (req.path === "/contact" && req.method === "POST") ||
    req.path === "/auth/login" ||
    req.path === "/auth/register" ||
    req.path.startsWith("/billing/ablepay/redirect/") ||
    req.path === "/billing/ablepay/return" ||
    req.path === "/billing/ablepay/failure" ||
    req.path === "/billing/ablepay/cancel" ||
    req.path === "/billing/webhooks/ablepay"
  );
}