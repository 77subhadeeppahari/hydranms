import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, vpnSites } from "@workspace/db";
import { deviceByCompanyId } from "./nms-store";
import { authContextFromSessionId, type AuthContext } from "./portal-store";

const GRANT_TTL_SECONDS = 60;
const PROXY_SESSION_TTL_SECONDS = 30 * 60;
const PROXY_SESSION_COOKIE = "__Host-olt_session";
const MAX_BOOTSTRAP_BODY_BYTES = 4096;
const MAX_REWRITTEN_BODY_BYTES = 12 * 1024 * 1024;
const consumedGrantIds = new Map<string, number>();

type UpstreamProtocol = "http" | "https";

type OltGrantClaims = {
  purpose: "olt-grant";
  deviceId: string;
  companyId: string;
  userId: string;
  sessionId: string;
  protocol: UpstreamProtocol;
  portalOrigin: string;
  nonce: string;
  expiresAt: number;
};

type OltSessionClaims = Omit<OltGrantClaims, "purpose" | "nonce" | "expiresAt"> & {
  purpose: "olt-session";
  expiresAt: number;
};

type OltDevice = NonNullable<Awaited<ReturnType<typeof deviceByCompanyId>>>;

export function oltProxyBaseDomain(): string | null {
  const domain = process.env.OLT_PROXY_BASE_DOMAIN?.trim().toLowerCase();
  if (
    !domain ||
    domain.length > 240 ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("*") ||
    !/^(?=.{1,240}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) ||
    domain.includes("..")
  ) {
    return null;
  }
  return domain;
}

function signingKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for OLT proxy access");
  return createHmac("sha256", secret).update("hydranms-olt-proxy-v1").digest();
}

function signClaims(claims: OltGrantClaims | OltSessionClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyClaims<T extends OltGrantClaims | OltSessionClaims>(
  token: string,
  purpose: T["purpose"],
): T | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const expected = createHmac("sha256", signingKey()).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
    if (
      claims.purpose !== purpose ||
      !Number.isInteger(claims.expiresAt) ||
      claims.expiresAt <= Math.floor(Date.now() / 1000) ||
      !claims.deviceId ||
      !claims.companyId ||
      !claims.userId ||
      !claims.sessionId
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

function portalRootDomain(baseDomain: string): string {
  return baseDomain.startsWith("olt.") ? baseDomain.slice(4) : baseDomain;
}

export function isAllowedOltPortalOrigin(origin: string | undefined, baseDomain: string): origin is string {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      (process.env.NODE_ENV === "production" ? parsed.protocol !== "https:" : !["https:", "http:"].includes(parsed.protocol))
    ) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    const rootDomain = portalRootDomain(baseDomain);
    return (
      (host === rootDomain || host.endsWith(`.${rootDomain}`)) &&
      host !== baseDomain &&
      !host.endsWith(`.${baseDomain}`)
    );
  } catch {
    return false;
  }
}

export function createOltGrant(input: {
  deviceId: string;
  companyId: string;
  auth: AuthContext;
  protocol: UpstreamProtocol;
  portalOrigin: string;
}): string {
  return signClaims({
    purpose: "olt-grant",
    deviceId: input.deviceId,
    companyId: input.companyId,
    userId: input.auth.user.id,
    sessionId: input.auth.sessionId,
    protocol: input.protocol,
    portalOrigin: input.portalOrigin,
    nonce: randomBytes(18).toString("base64url"),
    expiresAt: Math.floor(Date.now() / 1000) + GRANT_TTL_SECONDS,
  });
}

function parseProxyHost(hostHeader: string | undefined, baseDomain: string): { deviceId: string; hostname: string } | null {
  const hostname = hostHeader?.split(":")[0]?.trim().toLowerCase();
  if (!hostname || !hostname.endsWith(`.${baseDomain}`)) return null;
  const deviceId = hostname.slice(0, -(baseDomain.length + 1));
  if (!deviceId || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(deviceId)) return null;
  return { deviceId, hostname };
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipInCidr(address: string, cidr: string): boolean {
  const [network, rawPrefix] = cidr.split("/");
  const ip = ipv4Number(address);
  const networkNumber = ipv4Number(network ?? "");
  const prefix = Number(rawPrefix);
  if (ip === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0 === (networkNumber & mask) >>> 0;
}

function safeCustomerAddress(address: string): boolean {
  const ip = ipv4Number(address);
  if (ip === null) return false;
  const first = ip >>> 24;
  const second = (ip >>> 16) & 255;
  return (
    first !== 0 &&
    first !== 127 &&
    first < 224 &&
    !(first === 169 && second === 254) &&
    ip !== 0xffffffff
  );
}

export async function authorizedOltDevice(companyId: string, deviceId: string): Promise<OltDevice | null> {
  const device = await deviceByCompanyId(companyId, deviceId);
  if (!device || !device.vpnSiteId || !safeCustomerAddress(device.ipAddress)) return null;
  const [site] = await db
    .select()
    .from(vpnSites)
    .where(and(eq(vpnSites.id, device.vpnSiteId), eq(vpnSites.companyId, companyId)))
    .limit(1);
  if (
    !site ||
    site.status !== "active" ||
    site.routeState !== "applied" ||
    !ipInCidr(device.ipAddress, site.lanCidr)
  ) {
    return null;
  }
  return device;
}

function secureRequest(req: Request): boolean {
  return process.env.NODE_ENV !== "production" || req.secure;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

function bootstrapHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connecting to OLT · HydraNMS</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101a1f;color:#dce9eb;font:14px system-ui,sans-serif}main{max-width:420px;padding:24px;text-align:center}p{color:#a9bdc1;line-height:1.6}</style></head>
<body><main><strong>Connecting securely to the device…</strong><p>Keep this HydraNMS tab open while the isolated OLT session starts.</p></main>
<script>
(() => {
  let exchanging = false;
  let attempts = 0;
  const announceReady = () => window.parent.postMessage({ type: "hydranms-olt-ready" }, "*");
  announceReady();
  const readyTimer = window.setInterval(() => {
    attempts += 1;
    announceReady();
    if (attempts >= 60) window.clearInterval(readyTimer);
  }, 500);
  window.addEventListener("message", async (event) => {
    if (event.source !== window.parent || event.data?.type !== "hydranms-olt-grant" ||
        typeof event.data.grant !== "string" || exchanging) return;
    exchanging = true;
    window.clearInterval(readyTimer);
    try {
      const response = await fetch("/__hydranms/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant: event.data.grant, portalOrigin: event.origin })
      });
      if (!response.ok) throw new Error("Access grant expired or was rejected.");
      window.location.replace("/");
    } catch (error) {
      document.querySelector("strong").textContent = "OLT session could not be opened";
      document.querySelector("p").textContent = error instanceof Error ? error.message : "Request a new session from HydraNMS.";
    }
  });
})();
</script></body></html>`;
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  for (const item of cookieHeader?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator > 0 && item.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(item.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function readJsonBody(req: Request): Promise<{ grant?: unknown; portalOrigin?: unknown } | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BOOTSTRAP_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { grant?: unknown; portalOrigin?: unknown };
  } catch {
    return null;
  }
}

function consumeGrant(nonce: string, expiresAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, expiration] of consumedGrantIds) {
    if (expiration <= now) consumedGrantIds.delete(id);
  }
  if (consumedGrantIds.has(nonce)) return false;
  consumedGrantIds.set(nonce, expiresAt);
  return true;
}

function proxyOrigin(hostname: string): string {
  return `https://${hostname}`;
}

function targetOrigin(device: OltDevice, protocol: UpstreamProtocol): string {
  return `${protocol}://${device.ipAddress}:${protocol === "https" ? 443 : 80}`;
}

function applyOltContentPolicy(res: Response, portalOrigin: string): void {
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors ${portalOrigin}`,
  );
}

function setProxyResponseHeaders(
  upstreamHeaders: import("node:http").IncomingHttpHeaders,
  res: Response,
  claims: OltSessionClaims,
  hostname: string,
  device: OltDevice,
): void {
  for (const [name, value] of Object.entries(upstreamHeaders)) {
    if (
      value === undefined ||
      ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-security-policy", "content-security-policy-report-only", "x-frame-options", "access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-headers", "access-control-allow-methods", "strict-transport-security", "refresh"].includes(name)
    ) {
      continue;
    }
    if (name === "set-cookie") {
      const cookies = (Array.isArray(value) ? value : [value]).map((cookie) =>
        cookie.replace(/;\s*domain=[^;]*/gi, ""),
      ).filter((cookie) => !cookie.slice(0, cookie.indexOf("=")).trim().toLowerCase().startsWith("__host-olt_session"));
      if (cookies.length) res.setHeader("Set-Cookie", cookies);
      continue;
    }
    if (name === "location") {
      const location = Array.isArray(value) ? value[0] : value;
      if (!location) continue;
      const expectedOrigin = targetOrigin(device, claims.protocol);
      try {
        const parsed = new URL(location, expectedOrigin);
        if (
          parsed.hostname !== device.ipAddress ||
          !["http:", "https:"].includes(parsed.protocol) ||
          !["80", "443"].includes(parsed.port || (parsed.protocol === "https:" ? "443" : "80"))
        ) {
          res.setHeader("X-HydraNMS-Blocked-Redirect", "true");
          continue;
        }
        res.setHeader("Location", `${proxyOrigin(hostname)}${parsed.pathname}${parsed.search}${parsed.hash}`);
      } catch {
        res.setHeader("X-HydraNMS-Blocked-Redirect", "true");
      }
      continue;
    }
    res.setHeader(name, value);
  }
  applyOltContentPolicy(res, claims.portalOrigin);
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
}

export function rewriteOltDeviceUrls(
  body: Buffer,
  contentType: string | undefined,
  deviceIpAddress: string,
  hostname: string,
): Buffer {
  if (
    !contentType ||
    !/^(text\/html|text\/css|application\/javascript|text\/javascript|application\/json)/i.test(contentType) ||
    body.length > MAX_REWRITTEN_BODY_BYTES
  ) {
    return body;
  }
  let text = body.toString("utf8");
  const destination = proxyOrigin(hostname);
  const escapedIp = deviceIpAddress.replaceAll(".", "\\.");
  const deviceUrl = new RegExp(`(?:https?:)?//${escapedIp}(?::(?:80|443))?(?=[/:?#"'\\s]|$)`, "g");
  text = text.replace(deviceUrl, destination);
  return Buffer.from(text, "utf8");
}

function proxyFailure(res: Response, hostname: string, device: OltDevice, protocol: UpstreamProtocol, error: unknown): void {
  const message = protocol === "https"
    ? "The OLT HTTPS interface could not be reached. Confirm that HTTPS is enabled and its certificate is trusted for the configured device address."
    : "The OLT web interface could not be reached over WireGuard. Confirm the device is online and its HTTP management service is enabled.";
  res.status(502).type("html").send(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OLT unavailable</title></head><body style="font:15px system-ui,sans-serif;background:#101a1f;color:#dce9eb;padding:32px"><h2>OLT unavailable</h2><p>${message}</p><small>Configured device address: ${device.ipAddress}</small></body></html>`,
  );
  void hostname;
  void error;
}

async function exchangeGrant(req: Request, res: Response, hostname: string, deviceId: string, baseDomain: string): Promise<void> {
  noStore(res);
  if (!secureRequest(req)) {
    res.status(400).json({ error: "OLT proxy requires HTTPS" });
    return;
  }
  if (req.method !== "POST" || !req.is("application/json")) {
    res.status(405).json({ error: "Use POST with a JSON access grant" });
    return;
  }
  const body = await readJsonBody(req);
  if (!body || typeof body.grant !== "string" || typeof body.portalOrigin !== "string") {
    res.status(400).json({ error: "Invalid OLT access grant request" });
    return;
  }
  const claims = verifyClaims<OltGrantClaims>(body.grant, "olt-grant");
  if (
    !claims ||
    claims.deviceId !== deviceId ||
    claims.portalOrigin !== body.portalOrigin ||
    !isAllowedOltPortalOrigin(claims.portalOrigin, baseDomain) ||
    !claims.nonce ||
    !["http", "https"].includes(claims.protocol) ||
    !consumeGrant(claims.nonce, claims.expiresAt)
  ) {
    res.status(403).json({ error: "OLT access grant is invalid, expired, or already used" });
    return;
  }
  const activeAuth = await authContextFromSessionId(claims.sessionId, claims.userId, claims.companyId);
  const device = activeAuth ? await authorizedOltDevice(claims.companyId, deviceId) : null;
  if (!activeAuth || !device) {
    res.status(403).json({ error: "The user, WireGuard route, or device access is no longer active" });
    return;
  }
  const sessionClaims: OltSessionClaims = {
    purpose: "olt-session",
    deviceId,
    companyId: claims.companyId,
    userId: claims.userId,
    sessionId: claims.sessionId,
    protocol: claims.protocol,
    portalOrigin: claims.portalOrigin,
    expiresAt: Math.floor(Date.now() / 1000) + PROXY_SESSION_TTL_SECONDS,
  };
  const cookie = signClaims(sessionClaims);
  res.setHeader(
    "Set-Cookie",
    `${PROXY_SESSION_COOKIE}=${encodeURIComponent(cookie)}; Path=/; Max-Age=${PROXY_SESSION_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`,
  );
  res.status(204).end();
}

async function proxyDeviceRequest(req: Request, res: Response, hostname: string, device: OltDevice, claims: OltSessionClaims): Promise<void> {
  const protocol = claims.protocol;
  const port = protocol === "https" ? 443 : 80;
  const client = protocol === "https" ? httpsRequest : httpRequest;
  const incomingPath = req.url ?? "/";
  if (!incomingPath.startsWith("/") || incomingPath.startsWith("//")) {
    res.status(400).send("Invalid proxy path");
    return;
  }
  if (req.method === "CONNECT" || req.method === "TRACE") {
    res.status(405).send("This management method is not supported by the OLT proxy.");
    return;
  }
  const target = targetOrigin(device, protocol);
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  delete headers["accept-encoding"];
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  delete headers["x-real-ip"];
  delete headers.forwarded;
  headers.host = `${device.ipAddress}:${port}`;
  headers["accept-encoding"] = "identity";
  const forwardedCookies = (req.headers.cookie ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith(`${PROXY_SESSION_COOKIE}=`));
  if (forwardedCookies.length) headers.cookie = forwardedCookies.join("; ");
  else delete headers.cookie;
  if (req.headers.origin === proxyOrigin(hostname)) headers.origin = target;
  if (req.headers.referer) {
    try {
      const referer = new URL(req.headers.referer);
      if (referer.origin === proxyOrigin(hostname)) {
        headers.referer = `${target}${referer.pathname}${referer.search}${referer.hash}`;
      } else {
        delete headers.referer;
      }
    } catch {
      delete headers.referer;
    }
  }

  const upstream = client(
    {
      hostname: device.ipAddress,
      family: 4,
      port,
      method: req.method,
      path: incomingPath,
      headers,
      timeout: 30_000,
    },
    (upstreamResponse) => {
      setProxyResponseHeaders(upstreamResponse.headers, res, claims, hostname, device);
      res.status(upstreamResponse.statusCode ?? 502);
      const contentType = upstreamResponse.headers["content-type"];
      const contentEncoding = upstreamResponse.headers["content-encoding"]?.toLowerCase();
      const rewriteText = Boolean(
        contentType &&
        /^(text\/html|text\/css|application\/javascript|text\/javascript|application\/json)/i.test(contentType) &&
        (!contentEncoding || contentEncoding === "identity"),
      );
      if (rewriteText && contentType) {
        const chunks: Buffer[] = [];
        let size = 0;
        let rejected = false;
        upstreamResponse.on("data", (chunk: Buffer | string) => {
          if (rejected) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_REWRITTEN_BODY_BYTES) {
            rejected = true;
            chunks.length = 0;
            res.status(502).send("OLT response is too large to proxy safely.");
            upstreamResponse.destroy();
            return;
          }
          chunks.push(buffer);
        });
        upstreamResponse.on("end", () => {
          if (rejected) return;
          const rewritten = rewriteOltDeviceUrls(Buffer.concat(chunks), contentType, device.ipAddress, hostname);
          res.setHeader("Content-Length", rewritten.length);
          res.end(rewritten);
        });
        upstreamResponse.on("error", (error) => {
          if (rejected) return;
          if (!res.headersSent) proxyFailure(res, hostname, device, protocol, error);
          else res.destroy(error);
        });
      } else {
        upstreamResponse.pipe(res);
      }
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("OLT request timed out")));
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      proxyFailure(res, hostname, device, protocol, error);
    } else {
      res.destroy(error);
    }
  });
  req.pipe(upstream);
}

export async function handleOltProxyRequest(req: Request, res: Response): Promise<boolean> {
  const baseDomain = oltProxyBaseDomain();
  if (!baseDomain) return false;
  const parsedHost = parseProxyHost(req.get("host"), baseDomain);
  if (!parsedHost) return false;
  const { hostname, deviceId } = parsedHost;
  if (req.url?.startsWith("/__hydranms/bootstrap")) {
    noStore(res);
    if (req.method !== "GET" || req.url !== "/__hydranms/bootstrap") {
      res.status(404).end();
      return true;
    }
    if (!secureRequest(req)) {
      res.status(400).send("OLT proxy requires HTTPS");
      return true;
    }
    const root = portalRootDomain(baseDomain);
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors https://${root} https://*.${root}; base-uri 'none'; form-action 'none'; object-src 'none'`,
    );
    res.type("html").send(bootstrapHtml());
    return true;
  }
  if (req.url?.startsWith("/__hydranms/session")) {
    await exchangeGrant(req, res, hostname, deviceId, baseDomain);
    return true;
  }
  if (!secureRequest(req)) {
    noStore(res);
    res.status(400).send("OLT proxy requires HTTPS");
    return true;
  }
  const rawCookie = cookieValue(req.headers.cookie, PROXY_SESSION_COOKIE);
  const claims = rawCookie ? verifyClaims<OltSessionClaims>(rawCookie, "olt-session") : null;
  if (!claims || claims.deviceId !== deviceId) {
    noStore(res);
    res.status(401).type("html").send(
      `<!doctype html><html><head><meta charset="utf-8"><title>OLT session expired</title></head><body style="font:15px system-ui,sans-serif;padding:32px"><h2>OLT session unavailable</h2><p>Return to HydraNMS and request a new OLT session.</p></body></html>`,
    );
    return true;
  }
  const activeAuth = await authContextFromSessionId(claims.sessionId, claims.userId, claims.companyId);
  const device = activeAuth ? await authorizedOltDevice(claims.companyId, deviceId) : null;
  if (!activeAuth || !device) {
    noStore(res);
    res.setHeader("Set-Cookie", `${PROXY_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    res.status(403).send("OLT access has been revoked or the WireGuard route is unavailable.");
    return true;
  }
  noStore(res);
  applyOltContentPolicy(res, claims.portalOrigin);
  await proxyDeviceRequest(req, res, hostname, device, claims);
  return true;
}