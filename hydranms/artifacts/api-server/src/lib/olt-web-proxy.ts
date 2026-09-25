import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Transform, pipeline } from "node:stream";
import type { Request, RequestHandler, Response } from "express";
import { and, eq } from "drizzle-orm";
import { authSessions, db, portalUsers, vpnSites } from "@workspace/db";
import { deviceByCompanyId } from "./nms-store";

const BOOTSTRAP_TICKET_TTL_MS = 90_000;
const PROXY_SESSION_TTL_MS = 10 * 60_000;
const BOOTSTRAP_COOKIE = "hydranms_olt_proxy";
const MAX_PROXY_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_PROXY_BODY_READ_BYTES = 8 * 1024;
const ALLOWED_WEB_PORTS = new Set([80, 443]);
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type OltTicketPurpose = "bootstrap" | "session";
type OltTicket = {
  version: 1;
  purpose: OltTicketPurpose;
  deviceId: string;
  companyId: string;
  userId: string;
  authSessionId: string;
  parentOrigin: string;
  expiresAt: number;
  nonce: string;
};

type OltProxyDevice = {
  id: string;
  companyId: string;
  vpnSiteId: string | null;
  ipAddress: string;
  vendor: string;
  type: string;
  mibProfile: string | null;
  ponCount: number | null;
  onuCount: number | null;
  webLoginProtocol: string | null;
  webLoginPort: number | null;
};

const consumedTickets = new Map<string, number>();

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new Error("SESSION_SECRET is required for OLT web proxy sessions");
  return secret;
}

export function oltProxyBaseDomain(): string | null {
  const configured = process.env.OLT_PROXY_BASE_DOMAIN?.trim().toLowerCase();
  if (!configured) return null;
  const domain = configured.replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "");
  if (
    domain.length > 253 ||
    isIP(domain) !== 0 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  ) {
    return null;
  }
  return domain;
}

export function isSupportedOltWebPort(port: number): boolean {
  return Number.isInteger(port) && ALLOWED_WEB_PORTS.has(port);
}

export function isOltDevice(
  device: Pick<OltProxyDevice, "vendor" | "type" | "mibProfile" | "ponCount" | "onuCount">,
): boolean {
  return (
    /(?:olt|pon|onu)/i.test(`${device.vendor} ${device.type} ${device.mibProfile ?? ""}`) ||
    /^(?:zte|vsol|generic olt)$/i.test(device.mibProfile ?? "") ||
    device.ponCount !== null ||
    device.onuCount !== null
  );
}

export async function oltWebLoginSetupIssue(companyId: string, device: OltProxyDevice): Promise<string | null> {
  if (!isOltDevice(device)) return "Web login is available for OLT/PON devices only";
  if (!device.webLoginProtocol || !device.webLoginPort) return "Configure the OLT web protocol and port first";
  if (
    (device.webLoginProtocol !== "http" && device.webLoginProtocol !== "https") ||
    !isSupportedOltWebPort(device.webLoginPort)
  ) {
    return "The OLT web protocol or port is unsupported";
  }
  if (!device.vpnSiteId) return "Assign this OLT to a WireGuard VPN site first";
  if (!isRfc1918Ipv4(device.ipAddress)) return "The OLT address must be a private IPv4 address";
  const [site] = await db
    .select({
      id: vpnSites.id,
      lanCidr: vpnSites.lanCidr,
      status: vpnSites.status,
      routeState: vpnSites.routeState,
    })
    .from(vpnSites)
    .where(and(eq(vpnSites.id, device.vpnSiteId), eq(vpnSites.companyId, companyId)))
    .limit(1);
  if (!site || site.status !== "active" || site.routeState !== "applied") {
    return "The assigned WireGuard VPN site is not active with an applied route";
  }
  if (!addressInCidr(device.ipAddress, site.lanCidr)) {
    return "The OLT IP address is outside the LAN configured for its VPN site";
  }
  return null;
}

function slugForDeviceId(deviceId: string): string {
  return createHmac("sha256", sessionSecret())
    .update(`hydranms-olt-proxy:${deviceId}`)
    .digest("hex")
    .slice(0, 32);
}

function encodeTicket(ticket: OltTicket): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeTicket(value: string, expectedPurpose: OltTicketPurpose): OltTicket | null {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = createHmac("sha256", sessionSecret()).update(payload).digest();
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OltTicket;
    if (
      parsed.version !== 1 ||
      parsed.purpose !== expectedPurpose ||
      !parsed.deviceId ||
      !parsed.companyId ||
      !parsed.userId ||
      !parsed.authSessionId ||
      !parsed.parentOrigin ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= Date.now() ||
      !parsed.nonce
    ) {
      return null;
    }
    const parent = new URL(parsed.parentOrigin);
    if (parent.origin !== parsed.parentOrigin || (parent.protocol !== "https:" && !isLoopback(parent.hostname))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function verifyOltWebLoginTicket(
  value: string,
  purpose: "bootstrap" | "session" = "bootstrap",
): OltTicket | null {
  return decodeTicket(value, purpose);
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function createOltWebLoginTicket(input: {
  deviceId: string;
  companyId: string;
  userId: string;
  authSessionId: string;
  parentOrigin: string;
}): { proxyOrigin: string; ticket: string; ticketExpiresAt: string } {
  const domain = oltProxyBaseDomain();
  if (!domain) throw new Error("OLT_PROXY_BASE_DOMAIN is not configured with a valid DNS domain");

  const expiresAt = Date.now() + BOOTSTRAP_TICKET_TTL_MS;
  const ticket = encodeTicket({
    version: 1,
    purpose: "bootstrap",
    ...input,
    expiresAt,
    nonce: randomBytes(18).toString("base64url"),
  });
  return {
    proxyOrigin: `https://${slugForDeviceId(input.deviceId)}.${domain}`,
    ticket,
    ticketExpiresAt: new Date(expiresAt).toISOString(),
  };
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function proxyLabelFromHost(hostname: string, baseDomain: string): string | null {
  const suffix = `.${baseDomain}`;
  const normalized = hostname.toLowerCase();
  if (!normalized.endsWith(suffix)) return null;
  const label = normalized.slice(0, -suffix.length);
  return /^[a-f0-9]{32}$/.test(label) ? label : "";
}

function labelMatchesTicket(label: string, ticket: OltTicket): boolean {
  return label === slugForDeviceId(ticket.deviceId);
}

function parseIpv4(value: string): number | null {
  if (isIP(value) !== 4) return null;
  const parts = value.split(".").map(Number);
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function addressInCidr(address: string, cidr: string): boolean {
  const [networkText, prefixText] = cidr.split("/");
  const ip = parseIpv4(address);
  const network = parseIpv4(networkText ?? "");
  const prefix = Number(prefixText);
  if (ip === null || network === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ip & mask) >>> 0) === ((network & mask) >>> 0);
}

function isRfc1918Ipv4(value: string): boolean {
  const address = parseIpv4(value);
  if (address === null) return false;
  const privateRanges: Array<[number, number]> = [
    [0x0a000000, 0xff000000],
    [0xac100000, 0xfff00000],
    [0xc0a80000, 0xffff0000],
  ];
  return privateRanges.some(([network, mask]) => ((address & mask) >>> 0) === network);
}

async function activeDeviceForTicket(ticket: OltTicket): Promise<{
  device: OltProxyDevice;
  lanCidr: string;
} | null> {
  const [authRow] = await db
    .select({
      sessionId: authSessions.id,
      sessionUserId: authSessions.userId,
      sessionCompanyId: authSessions.companyId,
      sessionExpiresAt: authSessions.expiresAt,
      sessionRevokedAt: authSessions.revokedAt,
      userId: portalUsers.id,
      userCompanyId: portalUsers.companyId,
      userRole: portalUsers.role,
      userStatus: portalUsers.status,
    })
    .from(authSessions)
    .innerJoin(portalUsers, eq(authSessions.userId, portalUsers.id))
    .where(eq(authSessions.id, ticket.authSessionId))
    .limit(1);
  if (
    !authRow ||
    authRow.sessionUserId !== ticket.userId ||
    authRow.sessionRevokedAt ||
    authRow.sessionExpiresAt <= new Date() ||
    authRow.userStatus !== "active" ||
    (authRow.userRole !== "super_admin" &&
      (authRow.sessionCompanyId !== ticket.companyId || authRow.userCompanyId !== ticket.companyId))
  ) {
    return null;
  }

  const device = await deviceByCompanyId(ticket.companyId, ticket.deviceId);
  if (!device) return null;
  const setupIssue = await oltWebLoginSetupIssue(ticket.companyId, device);
  if (setupIssue) return null;
  const [site] = await db
    .select({ id: vpnSites.id, lanCidr: vpnSites.lanCidr })
    .from(vpnSites)
    .where(and(eq(vpnSites.id, device.vpnSiteId!), eq(vpnSites.companyId, ticket.companyId)))
    .limit(1);
  if (!site) return null;
  return { device, lanCidr: site.lanCidr };
}

function cookieValue(request: Request): string | null {
  return readCookie(request, BOOTSTRAP_COOKIE);
}

function clearProxyCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${BOOTSTRAP_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`,
  );
}

function consumeTicketOnce(ticket: string, expiresAt: number): boolean {
  const now = Date.now();
  for (const [key, until] of consumedTickets) {
    if (until <= now) consumedTickets.delete(key);
  }
  const digest = createHash("sha256").update(ticket).digest("hex");
  if (consumedTickets.has(digest)) return false;
  if (consumedTickets.size > 4_096) return false;
  consumedTickets.set(digest, expiresAt);
  return true;
}

function bootstrapHtml(needsTicket: boolean): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connecting to OLT</title>
<style>body{font:14px system-ui,sans-serif;color:#dbe7f1;background:#111b27;display:grid;min-height:100vh;place-items:center;margin:0}main{max-width:28rem;padding:2rem;text-align:center}p{color:#a9bac8}</style></head>
<body><main><strong id="message">Connecting securely to the OLT…</strong><p>This page will open after HydraNMS verifies your access.</p></main>
<script>
(() => {
  const message = document.getElementById("message");
  const needsTicket = ${JSON.stringify(needsTicket)};
  const decode = (ticket) => {
    try {
      const raw = ticket.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      const padded = raw + "=".repeat((4 - raw.length % 4) % 4);
      return JSON.parse(atob(padded));
    } catch { return null; }
  };
  parent.postMessage({ type: "hydranms-olt-ready", needsTicket }, "*");
  if (!needsTicket) {
    setTimeout(() => location.replace("/"), 0);
    return;
  }
  window.addEventListener("message", async (event) => {
    if (event.source !== window.parent || !event.data || event.data.type !== "hydranms-olt-ticket") return;
    const ticket = typeof event.data.ticket === "string" ? event.data.ticket : "";
    const claims = decode(ticket);
    if (!claims || claims.purpose !== "bootstrap" || claims.parentOrigin !== event.origin || claims.expiresAt <= Date.now()) return;
    try {
      const response = await fetch("/__hydranms/auth", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket })
      });
      if (!response.ok) throw new Error("Access verification failed");
      location.replace("/");
    } catch {
      message.textContent = "Unable to verify this OLT session. Close this panel and try again.";
    }
  });
})();
</script></body></html>`;
}

function writeBootstrapHeaders(response: Response, parentOrigin?: string): void {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors ${parentOrigin ?? "*"}`,
  );
}

function rewriteLocation(value: string, upstreamOrigin: string): string | null {
  try {
    const location = new URL(value, upstreamOrigin);
    if (location.origin !== upstreamOrigin) return null;
    return `${location.pathname}${location.search}${location.hash}`;
  } catch {
    return null;
  }
}

function rewriteSetCookie(value: string): string {
  let cookie = value.replace(/;\s*domain=[^;]*/gi, "").replace(/;\s*path=[^;]*/gi, "");
  if (!/;\s*path=/i.test(cookie)) cookie += "; Path=/";
  return cookie;
}

function rewriteContentSecurityPolicy(value: string, parentOrigin: string): string {
  const directives = value.split(";").map((part) => part.trim()).filter(Boolean);
  const frameIndex = directives.findIndex((part) => /^frame-ancestors(?:\s|$)/i.test(part));
  if (frameIndex >= 0) directives[frameIndex] = `frame-ancestors ${parentOrigin}`;
  else directives.push(`frame-ancestors ${parentOrigin}`);
  return directives.join("; ");
}

function proxyRequestHeaders(request: Request, upstreamOrigin: string): http.OutgoingHttpHeaders {
  const connectionTokens = new Set(
    (request.headers.connection ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  const headers: http.OutgoingHttpHeaders = {};
  for (const [rawName, rawValue] of Object.entries(request.headers)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name.startsWith("x-forwarded-") ||
      name === "forwarded" ||
      name.startsWith("sec-fetch-") ||
      HOP_BY_HOP_HEADERS.has(name) ||
      connectionTokens.has(name)
    ) {
      continue;
    }
    if (name === "cookie") {
      const filtered = String(rawValue)
        .split(";")
        .map((item) => item.trim())
        .filter((item) => {
          const cookieName = item.slice(0, item.indexOf("=")).trim();
          return cookieName !== BOOTSTRAP_COOKIE && cookieName !== "hydranms_session";
        });
      if (filtered.length) headers.cookie = filtered.join("; ");
      continue;
    }
    if (name === "authorization" && /^Bearer /i.test(String(rawValue))) continue;
    headers[name] = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
  }
  headers.host = new URL(upstreamOrigin).host;
  if (request.headers.origin) headers.origin = upstreamOrigin;
  if (request.headers.referer) {
    try {
      const referer = new URL(request.headers.referer);
      if (referer.origin === `https://${request.hostname}`) {
        headers.referer = `${upstreamOrigin}${referer.pathname}${referer.search}`;
      }
    } catch {
      // An invalid referrer is omitted rather than forwarded.
    }
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

function setUpstreamResponseHeaders(
  response: Response,
  upstreamHeaders: http.IncomingHttpHeaders,
  upstreamOrigin: string,
  parentOrigin: string,
): void {
  for (const [rawName, rawValue] of Object.entries(upstreamHeaders)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(name) ||
      name === "x-frame-options" ||
      name === "access-control-allow-origin" ||
      name === "access-control-allow-credentials" ||
      name === "access-control-allow-headers" ||
      name === "access-control-allow-methods" ||
      name === "access-control-expose-headers"
    ) {
      continue;
    }
    if (name === "location") {
      const rewritten = rewriteLocation(String(rawValue), upstreamOrigin);
      if (rewritten) response.setHeader("Location", rewritten);
      continue;
    }
    if (name === "set-cookie") {
      response.setHeader(
        "Set-Cookie",
        (Array.isArray(rawValue) ? rawValue : [rawValue]).map((cookie) => rewriteSetCookie(String(cookie))),
      );
      continue;
    }
    if (name === "content-security-policy" || name === "content-security-policy-report-only") {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      response.setHeader(
        rawName,
        values.map((value) => rewriteContentSecurityPolicy(String(value), parentOrigin)),
      );
      continue;
    }
    if (name === "refresh") {
      const match = String(rawValue).match(/^(\s*\d+\s*;\s*url\s*=\s*)(.*)$/i);
      if (match) {
        const location = rewriteLocation(match[2].replace(/^["']|["']$/g, ""), upstreamOrigin);
        if (location) response.setHeader(rawName, `${match[1]}${location}`);
      }
      continue;
    }
    response.setHeader(rawName, rawValue);
  }
  if (!upstreamHeaders["content-security-policy"]) {
    response.setHeader("Content-Security-Policy", `frame-ancestors ${parentOrigin}`);
  }
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

async function readSmallJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > MAX_PROXY_BODY_READ_BYTES) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PROXY_BODY_READ_BYTES) return null;
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function verifyCurrentDeviceSession(ticket: OltTicket, label: string) {
  if (!labelMatchesTicket(label, ticket)) return null;
  const context = await activeDeviceForTicket(ticket);
  if (!context) return null;
  return context;
}

async function handleProxyHost(request: Request, response: Response, label: string): Promise<void> {
  const path = request.path;
  if (path === "/__hydranms/start" && request.method === "GET") {
    let needsTicket = true;
    let parentOrigin: string | undefined;
    const sessionToken = cookieValue(request);
    if (sessionToken) {
      const ticket = decodeTicket(sessionToken, "session");
      if (ticket && await verifyCurrentDeviceSession(ticket, label)) {
        needsTicket = false;
        parentOrigin = ticket.parentOrigin;
      } else {
        clearProxyCookie(response);
      }
    }
    writeBootstrapHeaders(response, parentOrigin);
    response.status(200).send(bootstrapHtml(needsTicket));
    return;
  }

  if (path === "/__hydranms/auth" && request.method === "POST") {
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      response.status(415).end();
      return;
    }
    const body = await readSmallJsonBody(request);
    const ticketText = typeof body?.ticket === "string" ? body.ticket : "";
    const bootstrapTicket = decodeTicket(ticketText, "bootstrap");
    if (
      !bootstrapTicket ||
      !labelMatchesTicket(label, bootstrapTicket) ||
      !consumeTicketOnce(ticketText, bootstrapTicket.expiresAt) ||
      !(await verifyCurrentDeviceSession(bootstrapTicket, label))
    ) {
      response.status(403).end();
      return;
    }
    const expiresAt = Date.now() + PROXY_SESSION_TTL_MS;
    const sessionToken = encodeTicket({
      ...bootstrapTicket,
      purpose: "session",
      expiresAt,
      nonce: randomBytes(18).toString("base64url"),
    });
    response.setHeader(
      "Set-Cookie",
      `${BOOTSTRAP_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.floor(PROXY_SESSION_TTL_MS / 1000)}`,
    );
    response.setHeader("Cache-Control", "no-store");
    response.status(204).end();
    return;
  }

  if (!ALLOWED_METHODS.has(request.method.toUpperCase())) {
    response.setHeader("Allow", [...ALLOWED_METHODS].join(", "));
    response.status(405).end();
    return;
  }

  const sessionToken = cookieValue(request);
  const ticket = sessionToken ? decodeTicket(sessionToken, "session") : null;
  const context = ticket ? await verifyCurrentDeviceSession(ticket, label) : null;
  if (!ticket || !context) {
    clearProxyCookie(response);
    response.status(401).send("OLT proxy session expired. Close this panel and open it again from HydraNMS.");
    return;
  }

  if (request.url.startsWith("//") || request.url.includes("\\") || /[\u0000-\u001f]/.test(request.url)) {
    response.status(400).end();
    return;
  }
  const targetOrigin = `${context.device.webLoginProtocol}://${context.device.ipAddress}:${context.device.webLoginPort}`;
  const upstreamUrl = new URL(request.url, `${targetOrigin}/`);
  if (upstreamUrl.origin !== targetOrigin) {
    response.status(400).end();
    return;
  }
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > MAX_PROXY_REQUEST_BYTES) {
    response.status(413).end();
    return;
  }

  const transport = upstreamUrl.protocol === "https:" ? https : http;
  const upstreamRequest = transport.request(upstreamUrl, {
    method: request.method,
    headers: proxyRequestHeaders(request, targetOrigin),
  }, (upstreamResponse) => {
    response.status(upstreamResponse.statusCode ?? 502);
    setUpstreamResponseHeaders(response, upstreamResponse.headers, targetOrigin, ticket.parentOrigin);
    let receivedBytes = 0;
    const responseLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_PROXY_RESPONSE_BYTES) {
          callback(new Error("OLT response exceeded the proxy limit"));
          return;
        }
        callback(null, chunk);
      },
    });
    pipeline(upstreamResponse, responseLimiter, response, (error) => {
      if (error && !response.destroyed) response.destroy();
    });
  });

  upstreamRequest.setTimeout(20_000, () => upstreamRequest.destroy(new Error("OLT request timed out")));
  upstreamRequest.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.status(502).send("Unable to reach this OLT over its assigned WireGuard site.");
  });

  let requestBytes = 0;
  request.on("data", (chunk: Buffer) => {
    requestBytes += chunk.length;
    if (requestBytes > MAX_PROXY_REQUEST_BYTES) {
      request.pause();
      upstreamRequest.destroy();
      if (!response.headersSent) response.status(413).end();
    }
  });
  request.on("aborted", () => upstreamRequest.destroy());
  response.on("close", () => {
    if (!response.writableEnded) upstreamRequest.destroy();
  });
  request.pipe(upstreamRequest);
}

export const oltWebProxyMiddleware: RequestHandler = (request, response, next) => {
  const baseDomain = oltProxyBaseDomain();
  if (!baseDomain) {
    next();
    return;
  }
  const label = proxyLabelFromHost(request.hostname, baseDomain);
  if (label === null) {
    next();
    return;
  }
  if (!label) {
    next();
    return;
  }
  void handleProxyHost(request, response, label).catch(() => {
    if (!response.headersSent) response.status(502).send("The OLT proxy could not complete this request.");
    else response.destroy();
  });
};