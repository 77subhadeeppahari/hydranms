import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { unlinkSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import type { Server } from "node:http";
import app from "./app";
import { db, pool } from "@workspace/db";
import {
  auditLogs,
  authSessions,
  checkoutSessions,
  companies,
  contactSubmissions,
  deviceInterfaceSamples,
  deviceInterfaces,
  licenses,
  notificationDeliveries,
  paymentWebhookEvents,
  portalUsers,
  monitoredDevices,
  ponTelemetry,
  ponTelemetrySamples,
  supportTickets,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  createCheckoutSession,
  ensurePortalData,
  listNotifications,
  queueNotification,
  retryNotification,
} from "./lib/portal-store";
import { deliverNotification } from "./lib/notification-service";
import { decryptLicenseKey } from "./lib/license-crypto";
import { upsertDevice } from "./lib/nms-store";

type HttpResponse = {
  status: number;
  body: any;
  headers: Headers;
};

let baseUrl = "";

async function startServer(): Promise<Server> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  return server;
}

async function stopServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startHydraFrontend(port: number): ChildProcess {
  return spawn(
    "pnpm",
    ["--filter", "@workspace/hydranms", "run", "dev"],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        BASE_PATH: "/",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
}

async function stopChildProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
}

async function startBrowserProxy(frontendPort: number): Promise<Server> {
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const apiUrl = baseUrl;
  const server = createServer((req, res) => {
    const upstreamBase = req.url?.startsWith("/api") ? apiUrl : frontendUrl;
    const upstream = new URL(req.url ?? "/", upstreamBase);
    const proxyRequest = httpRequest(
      upstream,
      {
        method: req.method,
        headers: { ...req.headers, host: upstream.host },
      },
      (proxyResponse) => {
        res.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(res);
      },
    );
    proxyRequest.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(proxyRequest);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

type CdpPage = {
  command: (method: string, params?: Record<string, unknown>) => Promise<any>;
  evaluate: <T>(expression: string) => Promise<T>;
  close: () => Promise<void>;
};

async function connectCdpPage(webSocketUrl: string): Promise<CdpPage> {
  const socket = new WebSocket(webSocketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("Unable to connect to Chromium")));
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "Chromium command failed"));
    else waiter.resolve(message.result);
  });
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  await command("Page.enable");
  await command("Runtime.enable");
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result?.result?.value as T;
  };
  return {
    command,
    evaluate,
    close: async () => {
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}

async function launchBrowser(): Promise<{ browser: ChildProcess; page: CdpPage }> {
  const browser = spawn(
    "/repl/tools/bin/chromium",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=/tmp/hydranms-browser-${Date.now()}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  const debugSocket = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out starting Chromium")), 15_000);
    browser.stderr?.on("data", (chunk: Buffer) => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    browser.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Chromium exited before its debugging endpoint started"));
    });
  });
  const debugPort = Number(new URL(debugSocket).port);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target?.webSocketDebuggerUrl) return { browser, page: await connectCdpPage(target.webSocketDebuggerUrl) };
    } catch {
      // Chromium's HTTP debugging endpoint may lag behind its stderr message.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser.kill();
  throw new Error("Timed out finding Chromium page target");
}

async function browserWaitFor(page: CdpPage, expression: string, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await page.evaluate<boolean>(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function browserClick(page: CdpPage, selector: string): Promise<void> {
  const clicked = await page.evaluate<boolean>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Expected ${selector} to be clickable`);
}

async function browserFill(page: CdpPage, selector: string, value: string): Promise<void> {
  const filled = await page.evaluate<boolean>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert.equal(filled, true, `Expected ${selector} to be fillable`);
}

async function browserSetFile(page: CdpPage, selector: string, filePath: string): Promise<void> {
  const document = await page.command("DOM.getDocument", { depth: -1 });
  const match = await page.command("DOM.querySelector", {
    nodeId: document.root.nodeId,
    selector,
  });
  assert.ok(match.nodeId, `Expected ${selector} to be present`);
  await page.command("DOM.setFileInputFiles", {
    nodeId: match.nodeId,
    files: [filePath],
  });
}

async function browserSelect(page: CdpPage, selector: string, value: string): Promise<void> {
  const selected = await page.evaluate<boolean>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  assert.equal(selected, true, `Expected ${selector} to be a selectable control`);
}

async function request(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    rawBody?: string;
  } = {},
): Promise<HttpResponse> {
  const body = options.rawBody ?? (options.body ? JSON.stringify(options.body) : undefined);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

function sessionCookie(response: HttpResponse): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie.split(";")[0];
}

function suffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function registerTenant(prefix: string): Promise<{ companyId: string; username: string; email: string; password: string }> {
  const value = suffix(prefix);
  const registration = {
    subdomain: value,
    companyName: `${prefix} Payment Test Company`,
    contactNumber: "9876543210",
    email: `${value}@example.test`,
    address: "Payment test address",
    username: `${value}-admin`,
    password: `${value}-Password!`,
  };
  const response = await request("/api/auth/register", { method: "POST", body: registration });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return {
    companyId: response.body.company.id,
    username: registration.username,
    email: registration.email,
    password: registration.password,
  };
}

async function login(identifier: string, password: string): Promise<string> {
  const response = await request("/api/auth/login", {
    method: "POST",
    body: { identifier, password },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return sessionCookie(response);
}

function signedWebhook(
  payload: Record<string, unknown>,
  secret: string,
): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    signature: createHmac("sha256", secret).update(rawBody).digest("hex"),
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 3_000;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  assert.ok(predicate(value), message);
  return value;
}

test("payment confirmation is idempotent, visible on failure, and recoverable by super-admin", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for payment flow tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for payment flow tests");
  assert.ok(process.env.SUPERADMIN_PASSWORD, "SUPERADMIN_PASSWORD is required for payment flow tests");

  const previous = {
    ablePaySecret: process.env.ABLEPAY_WEBHOOK_SECRET,
    emailProvider: process.env.EMAIL_PROVIDER,
    emailFrom: process.env.EMAIL_FROM,
    sendgridKey: process.env.SENDGRID_API_KEY,
  };
  const webhookSecret = "payment-flow-test-secret";
  process.env.ABLEPAY_WEBHOOK_SECRET = webhookSecret;
  delete process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_FROM;
  delete process.env.SENDGRID_API_KEY;

  const companyIds: string[] = [];
  const webhookEventIds: string[] = [];
  let server = await startServer();
  const originalFetch = globalThis.fetch;

  try {
    await ensurePortalData();
    const tenant = await registerTenant("payment-flow");
    companyIds.push(tenant.companyId);
    const adminCookie = await login(
      process.env.SUPERADMIN_USERNAME ?? "superadmin-admin",
      process.env.SUPERADMIN_PASSWORD!,
    );
    const checkout = await createCheckoutSession({
      companyId: tenant.companyId,
      planId: "growth",
      amount: 7499,
      currency: "INR",
    });

    const paidPayload = {
      id: `evt-${suffix("paid")}`,
      type: "payment.succeeded",
      data: { status: "paid", checkoutId: checkout.id },
    };
    webhookEventIds.push(paidPayload.id);
    const paidRequest = signedWebhook(paidPayload, webhookSecret);
    const concurrentPayments = await Promise.all(
      [1, 2].map(() =>
        request("/api/billing/webhooks/ablepay", {
          method: "POST",
          rawBody: paidRequest.rawBody,
          headers: { "x-ablepay-signature": paidRequest.signature },
        }),
      ),
    );
    for (const payment of concurrentPayments) {
      assert.equal(payment.status, 200, JSON.stringify(payment.body));
    }
    assert.equal(
      concurrentPayments.filter((payment) => payment.body?.duplicate === true).length,
      1,
      "one concurrent retry must be acknowledged as a duplicate",
    );
    assert.equal(
      concurrentPayments.filter((payment) => payment.body?.duplicate !== true).length,
      1,
      "one concurrent request must perform payment confirmation",
    );

    const secondEventPayload = {
      ...paidPayload,
      id: `evt-${suffix("paid-again")}`,
    };
    webhookEventIds.push(secondEventPayload.id);
    const secondEventRequest = signedWebhook(secondEventPayload, webhookSecret);
    const secondPayment = await request("/api/billing/webhooks/ablepay", {
      method: "POST",
      rawBody: secondEventRequest.rawBody,
      headers: { "x-ablepay-signature": secondEventRequest.signature },
    });
    assert.equal(secondPayment.status, 200, JSON.stringify(secondPayment.body));

    const delivery = await waitFor(
      async () => {
        const rows = await listNotifications(companyIds[0]);
        return rows[0];
      },
      (row) => Boolean(row && row.status === "failed"),
      "license email should record provider failure",
    );
    assert.ok(delivery);
    assert.equal(delivery.eventType, "license.activated");
    assert.equal(delivery.attempts, 1);
    assert.match(delivery.lastError ?? "", /EMAIL_FROM|EMAIL_PROVIDER/);
    assert.ok(delivery.nextAttemptAt.getTime() > Date.now());

    const [licenseCount, auditCount, deliveryCount] = await Promise.all([
      db.select().from(licenses).where(eq(licenses.companyId, tenant.companyId)),
      db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, tenant.companyId), eq(auditLogs.action, "payment.confirmed"))),
      db.select().from(notificationDeliveries).where(eq(notificationDeliveries.companyId, tenant.companyId)),
    ]);
    assert.equal(licenseCount.length, 1, "duplicate payment events must not create multiple licenses");
    assert.equal(auditCount.length, 1, "duplicate payment events must activate only once");
    assert.equal(deliveryCount.length, 1, "duplicate payment events must not duplicate the license email");

    const invalidPayload = {
      id: `evt-${suffix("invalid-signature")}`,
      type: "payment.succeeded",
      data: { status: "paid", checkoutId: checkout.id },
    };
    webhookEventIds.push(invalidPayload.id);
    const invalidSignature = await request("/api/billing/webhooks/ablepay", {
      method: "POST",
      rawBody: JSON.stringify(invalidPayload),
      headers: { "x-ablepay-signature": "not-a-valid-signature" },
    });
    assert.equal(invalidSignature.status, 401);

    const unknownPayload = {
      id: `evt-${suffix("unknown-checkout")}`,
      type: "payment.succeeded",
      data: { status: "paid", checkoutId: "checkout-does-not-exist" },
    };
    webhookEventIds.push(unknownPayload.id);
    const unknownRequest = signedWebhook(unknownPayload, webhookSecret);
    const unknownCheckout = await request("/api/billing/webhooks/ablepay", {
      method: "POST",
      rawBody: unknownRequest.rawBody,
      headers: { "x-ablepay-signature": unknownRequest.signature },
    });
    assert.equal(unknownCheckout.status, 500);

    const webhookRows = await waitFor(
      () => db.select().from(paymentWebhookEvents).orderBy(paymentWebhookEvents.receivedAt),
      (rows) =>
        rows.some((row) => row.eventId === invalidPayload.id && row.status === "rejected") &&
        rows.some((row) => row.eventId === unknownPayload.id && row.status === "failed"),
      "invalid and unknown payment webhooks should remain visible",
    );
    const invalidRow = webhookRows.find((row) => row.eventId === invalidPayload.id);
    const unknownRow = webhookRows.find((row) => row.eventId === unknownPayload.id);
    assert.equal(invalidRow?.error, "Invalid webhook signature");
    assert.equal(unknownRow?.error, "Checkout session not found");

    const visibleWebhooks = await request("/api/admin/billing/webhook-events", {
      headers: { cookie: adminCookie },
    });
    assert.equal(visibleWebhooks.status, 200);
    assert.ok(visibleWebhooks.body.some((row: any) => row.eventId === invalidPayload.id && row.status === "rejected"));
    assert.ok(visibleWebhooks.body.some((row: any) => row.eventId === unknownPayload.id && row.status === "failed"));

    process.env.EMAIL_PROVIDER = "sendgrid";
    process.env.EMAIL_FROM = "billing@example.test";
    process.env.SENDGRID_API_KEY = "test-key";
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(baseUrl)) return originalFetch(input, init);
      return new Response("", { status: 202 });
    };
    const retryResponse = await request(`/api/admin/notifications/${delivery.id}/retry`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    assert.equal(retryResponse.status, 200, JSON.stringify(retryResponse.body));
    assert.equal(retryResponse.body.status, "sent");

    const visibleNotifications = await request("/api/admin/notifications", {
      headers: { cookie: adminCookie },
    });
    assert.equal(visibleNotifications.status, 200);
    assert.equal(visibleNotifications.body.page, 1);
    assert.equal(visibleNotifications.body.pageSize, 20);
    assert.equal(typeof visibleNotifications.body.total, "number");
    assert.equal(visibleNotifications.body.hasMore, false);
    const visibleDelivery = visibleNotifications.body.items.find((row: any) => row.id === delivery.id);
    assert.equal(visibleDelivery?.status, "sent");
    assert.equal(visibleDelivery?.maxAttempts, 5);
    assert.equal(visibleDelivery?.retryable, false);
    assert.equal(typeof visibleDelivery?.nextAttemptAt, "string");
    assert.equal(visibleDelivery?.providerMessageId, null);

    const olderDelivery = await queueNotification({
      companyId: tenant.companyId,
      channel: "email",
      eventType: "history.older",
      recipient: tenant.email,
      subject: "Older attempt",
      body: "Older attempt",
      idempotencyKey: `history-older:${tenant.companyId}`,
    });
    assert.ok(olderDelivery);
    const firstHistoryPage = await request(`/api/admin/notifications?page=1&pageSize=1&recipient=${encodeURIComponent(tenant.email)}`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(firstHistoryPage.status, 200);
    assert.ok(firstHistoryPage.body.hasMore);
    assert.ok(firstHistoryPage.body.total >= 2);
    const secondHistoryPage = await request(`/api/admin/notifications?page=2&pageSize=1&recipient=${encodeURIComponent(tenant.email)}`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(secondHistoryPage.status, 200);
    assert.equal(secondHistoryPage.body.items.length, 1);
    assert.notEqual(secondHistoryPage.body.items[0].id, firstHistoryPage.body.items[0].id);

    const filteredNotifications = await request(`/api/admin/notifications?status=sent&channel=email&eventType=license&recipient=${encodeURIComponent(tenant.email)}`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(filteredNotifications.status, 200);
    assert.ok(filteredNotifications.body.items.some((row: any) => row.id === delivery.id));
    assert.ok(filteredNotifications.body.items.every((row: any) => row.status === "sent" && row.channel === "email"));

    const boundedNotifications = await request("/api/admin/notifications?page=1&pageSize=50", {
      headers: { cookie: adminCookie },
    });
    assert.equal(boundedNotifications.status, 200);
    assert.equal(boundedNotifications.body.pageSize, 50);
    const oversizedNotifications = await request("/api/admin/notifications?page=1&pageSize=51", {
      headers: { cookie: adminCookie },
    });
    assert.equal(oversizedNotifications.status, 400);

    const deliveryDetail = await request(`/api/admin/notifications/${delivery.id}`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(deliveryDetail.status, 200);
    assert.equal(deliveryDetail.body.id, delivery.id);
    assert.equal(deliveryDetail.body.status, "sent");
    assert.equal(deliveryDetail.body.maxAttempts, 5);
    assert.equal(deliveryDetail.body.providerMessageId, null);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name === "ablePaySecret" ? "ABLEPAY_WEBHOOK_SECRET" : name === "emailProvider" ? "EMAIL_PROVIDER" : name === "emailFrom" ? "EMAIL_FROM" : "SENDGRID_API_KEY"];
      else process.env[name === "ablePaySecret" ? "ABLEPAY_WEBHOOK_SECRET" : name === "emailProvider" ? "EMAIL_PROVIDER" : name === "emailFrom" ? "EMAIL_FROM" : "SENDGRID_API_KEY"] = value;
    }
    await stopServer(server);
    if (companyIds.length) {
      await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.companyId, companyIds));
      await db.delete(paymentWebhookEvents).where(inArray(paymentWebhookEvents.eventId, webhookEventIds));
      await db.delete(checkoutSessions).where(inArray(checkoutSessions.companyId, companyIds));
      await db.delete(licenses).where(inArray(licenses.companyId, companyIds));
      await db.delete(auditLogs).where(inArray(auditLogs.companyId, companyIds));
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
  }
});

test("successful registration payment activates the selected plan for the new company", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for registration checkout tests");

  const previous = {
    ablePayApiUrl: process.env.ABLEPAY_API_URL,
    ablePayApiKey: process.env.ABLEPAY_API_KEY,
    ablePaySalt: process.env.ABLEPAY_SALT,
    ablePayWebhookSecret: process.env.ABLEPAY_WEBHOOK_SECRET,
  };
  process.env.ABLEPAY_API_URL = "https://ablepay.test";
  process.env.ABLEPAY_API_KEY = "registration-checkout-test-key";
  process.env.ABLEPAY_SALT = "registration-checkout-test-salt";
  const webhookSecret = "registration-payment-test-secret";
  process.env.ABLEPAY_WEBHOOK_SECRET = webhookSecret;

  const registrationValue = suffix("registration-growth");
  const companyIds: string[] = [];
  const webhookEventIds: string[] = [];
  let apiServer: Server | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: Server | undefined;
  let browser: ChildProcess | undefined;
  let page: CdpPage | undefined;

  try {
    await ensurePortalData();
    apiServer = await startServer();

    const frontendPort = await unusedPort();
    frontend = startHydraFrontend(frontendPort);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`);
    proxy = await startBrowserProxy(frontendPort);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");

    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;
    await page.command("Page.navigate", { url: `http://127.0.0.1:${proxyAddress.port}/register` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="select-subscription-plan"]'))`,
      "registration form did not load",
    );

    await browserFill(page, '[data-testid="input-company-name"]', `${registrationValue} Company`);
    await browserFill(page, '[data-testid="input-portal-subdomain"]', registrationValue);
    await browserFill(page, '[data-testid="input-admin-username"]', `${registrationValue}-admin`);
    await browserFill(page, '[data-testid="input-contact-number"]', "9876543210");
    await browserFill(page, '[data-testid="input-work-email"]', `${registrationValue}@example.test`);
    await browserFill(page, '[data-testid="input-company-address"]', "Registration checkout test address");
    await browserFill(page, '[data-testid="input-password"]', `${registrationValue}-Password!`);
    await browserSelect(page, '[data-testid="select-subscription-plan"]', "growth");
    const selectedPlan = await page.evaluate<string>(
      `document.querySelector('[data-testid="select-subscription-plan"]')?.value ?? ""`,
    );
    assert.equal(selectedPlan, "growth");
    await browserClick(page, '[data-testid="button-submit-register"]');

    const company = await waitFor(
      async () => {
        const rows = await db
          .select()
          .from(companies)
          .where(eq(companies.subdomain, registrationValue))
          .limit(1);
        return rows[0];
      },
      (row) => Boolean(row),
      "registration did not create the company",
    );
    assert.ok(company);
    companyIds.push(company.id);

    const checkout = await waitFor(
      async () => {
        const rows = await db
          .select()
          .from(checkoutSessions)
          .where(eq(checkoutSessions.companyId, company.id))
          .limit(1);
        return rows[0];
      },
      (row) => Boolean(row),
      "registration did not create a checkout session",
    );
    assert.ok(checkout);
    assert.equal(checkout.companyId, company.id);
    assert.equal(checkout.planId, "growth");
    assert.notEqual(checkout.planId, "starter");

    const paidPayload = {
      id: `evt-${suffix("registration-paid")}`,
      type: "payment.succeeded",
      data: { status: "paid", checkoutId: checkout.id },
    };
    webhookEventIds.push(paidPayload.id);
    const paidRequest = signedWebhook(paidPayload, webhookSecret);
    const payment = await request("/api/billing/webhooks/ablepay", {
      method: "POST",
      rawBody: paidRequest.rawBody,
      headers: { "x-ablepay-signature": paidRequest.signature },
    });
    assert.equal(payment.status, 200, JSON.stringify(payment.body));
    assert.deepEqual(payment.body, { received: true });

    const license = await waitFor(
      async () => {
        const rows = await db.select().from(licenses).where(eq(licenses.companyId, company.id)).limit(1);
        return rows[0];
      },
      (row) => Boolean(row),
      "successful payment did not activate a license",
    );
    assert.ok(license);
    assert.equal(license.companyId, company.id);
    assert.equal(license.planId, checkout.planId);
    assert.equal(license.planId, "growth");
    assert.equal(license.status, "active");

    const [activatedCompany, paidCheckout] = await Promise.all([
      db.select().from(companies).where(eq(companies.id, company.id)).limit(1).then((rows) => rows[0]),
      db.select().from(checkoutSessions).where(eq(checkoutSessions.id, checkout.id)).limit(1).then((rows) => rows[0]),
    ]);
    assert.equal(activatedCompany?.status, "active");
    assert.equal(paidCheckout?.status, "paid");

    const companyLogin = await request("/api/auth/login", {
      method: "POST",
      body: {
        identifier: `${registrationValue}-admin`,
        password: `${registrationValue}-Password!`,
      },
    });
    assert.equal(companyLogin.status, 200, JSON.stringify(companyLogin.body));
    assert.equal(companyLogin.body.company.id, company.id);
    assert.equal(companyLogin.body.company.name, company.name);
    assert.equal(companyLogin.body.company.plan, "Growth");
    assert.equal(companyLogin.body.company.licenseStatus, "active");

    const companyLicense = await request("/api/billing/license", {
      headers: { cookie: sessionCookie(companyLogin) },
    });
    assert.equal(companyLicense.status, 200, JSON.stringify(companyLicense.body));
    assert.equal(companyLicense.body.plan, "Growth");
    assert.equal(companyLicense.body.status, "active");
    assert.equal(companyLicense.body.issuedTo, company.name);
  } finally {
    await page?.close();
    await stopChildProcess(browser);
    proxy && await stopServer(proxy);
    await stopChildProcess(frontend);
    apiServer && await stopServer(apiServer);
    for (const [name, value] of Object.entries(previous)) {
      const envName =
        name === "ablePayApiUrl"
          ? "ABLEPAY_API_URL"
          : name === "ablePayApiKey"
            ? "ABLEPAY_API_KEY"
            : name === "ablePaySalt"
              ? "ABLEPAY_SALT"
              : "ABLEPAY_WEBHOOK_SECRET";
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
    if (companyIds.length) {
      await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.companyId, companyIds));
      if (webhookEventIds.length) {
        await db.delete(paymentWebhookEvents).where(inArray(paymentWebhookEvents.eventId, webhookEventIds));
      }
      await db.delete(checkoutSessions).where(inArray(checkoutSessions.companyId, companyIds));
      await db.delete(licenses).where(inArray(licenses.companyId, companyIds));
      await db.delete(auditLogs).where(inArray(auditLogs.companyId, companyIds));
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
  }
});

test("license numbers recover after the encryption secret changes", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for license recovery tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for license recovery tests");
  assert.ok(process.env.SUPERADMIN_PASSWORD, "SUPERADMIN_PASSWORD is required for license recovery tests");

  const originalSessionSecret = process.env.SESSION_SECRET;
  const oldSessionSecret = `${originalSessionSecret}-license-recovery-old`;
  const currentSessionSecret = `${originalSessionSecret}-license-recovery-current`;
  const companyIds: string[] = [];
  let server: Server | undefined;

  try {
    await ensurePortalData();
    process.env.SESSION_SECRET = oldSessionSecret;
    server = await startServer();
    const tenant = await registerTenant("license-recovery");
    companyIds.push(tenant.companyId);
    const licenseBeforeRepair = (
      await db.select().from(licenses).where(eq(licenses.companyId, tenant.companyId)).limit(1)
    )[0];
    assert.ok(licenseBeforeRepair);
    assert.ok(licenseBeforeRepair.encryptedKey);

    process.env.SESSION_SECRET = currentSessionSecret;
    const adminCookie = await login(
      process.env.SUPERADMIN_USERNAME ?? "superadmin-admin",
      process.env.SUPERADMIN_PASSWORD!,
    );
    const tenantCookie = await login(tenant.username, tenant.password);

    const firstDirectoryRead = await request("/api/companies", {
      headers: { cookie: adminCookie },
    });
    assert.equal(firstDirectoryRead.status, 200, JSON.stringify(firstDirectoryRead.body));
    const repairedKey = firstDirectoryRead.body.find((company: any) => company.id === tenant.companyId)?.licenseNumber;
    assert.match(repairedKey, /^HYDRA-[A-Z0-9-]+$/);
    assert.notEqual(repairedKey, "Unavailable");

    const repairedLicense = (
      await db.select().from(licenses).where(eq(licenses.companyId, tenant.companyId)).limit(1)
    )[0];
    assert.ok(repairedLicense);
    assert.ok(repairedLicense.encryptedKey);
    assert.notEqual(repairedLicense.encryptedKey, licenseBeforeRepair.encryptedKey);
    assert.equal(repairedLicense.key, repairedLicense.keyHash);
    assert.equal(decryptLicenseKey(repairedLicense.encryptedKey), repairedKey);

    const billingRead = await request("/api/billing/license", {
      headers: { cookie: tenantCookie },
    });
    assert.equal(billingRead.status, 200, JSON.stringify(billingRead.body));
    assert.equal(billingRead.body.key, repairedKey);
    assert.match(billingRead.body.key, /^HYDRA-[A-Z0-9-]+$/);

    const secondDirectoryRead = await request("/api/companies", {
      headers: { cookie: adminCookie },
    });
    assert.equal(secondDirectoryRead.status, 200, JSON.stringify(secondDirectoryRead.body));
    assert.equal(
      secondDirectoryRead.body.find((company: any) => company.id === tenant.companyId)?.licenseNumber,
      repairedKey,
    );

    const persistedAfterSecondRead = (
      await db.select().from(licenses).where(eq(licenses.companyId, tenant.companyId)).limit(1)
    )[0];
    assert.equal(persistedAfterSecondRead?.encryptedKey, repairedLicense.encryptedKey);
    assert.equal(persistedAfterSecondRead?.keyHash, repairedLicense.keyHash);
  } finally {
    process.env.SESSION_SECRET = originalSessionSecret;
    if (server) await stopServer(server);
    if (companyIds.length) {
      await db.delete(authSessions).where(inArray(authSessions.companyId, companyIds));
      await db.delete(licenses).where(inArray(licenses.companyId, companyIds));
      await db.delete(auditLogs).where(inArray(auditLogs.companyId, companyIds));
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
  }
});

test("signed-in tenant upgrade opens the public AblePay hosted checkout", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for tenant checkout browser tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for tenant checkout browser tests");

  const previous = {
    ablePayApiUrl: process.env.ABLEPAY_API_URL,
    ablePayApiKey: process.env.ABLEPAY_API_KEY,
    ablePaySalt: process.env.ABLEPAY_SALT,
    publicAppUrl: process.env.PUBLIC_APP_URL,
  };
  process.env.ABLEPAY_API_URL = "https://ablepay.test";
  process.env.ABLEPAY_API_KEY = "tenant-upgrade-checkout-test-key";
  process.env.ABLEPAY_SALT = "tenant-upgrade-checkout-test-salt";
  process.env.PUBLIC_APP_URL = "https://hydranms-preview.example.test";

  const companyIds: string[] = [];
  let apiServer: Server | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: Server | undefined;
  let browser: ChildProcess | undefined;
  let page: CdpPage | undefined;

  try {
    await ensurePortalData();
    apiServer = await startServer();
    const tenant = await registerTenant("tenant-upgrade");
    companyIds.push(tenant.companyId);

    const frontendPort = await unusedPort();
    frontend = startHydraFrontend(frontendPort);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`);
    proxy = await startBrowserProxy(frontendPort);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");

    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;
    await page.command("Page.navigate", { url: `http://127.0.0.1:${proxyAddress.port}/login` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
      "tenant login form did not load",
    );
    await browserFill(page, '[data-testid="input-email-or-username"]', tenant.email);
    await browserFill(page, '[data-testid="input-login-password"]', tenant.password);
    await browserClick(page, '[data-testid="button-submit-login"]');
    await browserWaitFor(
      page,
      `Boolean(localStorage.getItem("hydranms-token")) && location.pathname === "/"`,
      "tenant did not sign in through the browser",
    );

    await page.command("Page.navigate", { url: `http://127.0.0.1:${proxyAddress.port}/plans` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="button-upgrade-plan-growth"]'))`,
      "tenant Plans & billing page did not show the Growth upgrade",
    );
    await browserClick(page, '[data-testid="button-upgrade-plan-growth"]');

    const checkout = await waitFor(
      async () => {
        const rows = await db
          .select()
          .from(checkoutSessions)
          .where(eq(checkoutSessions.companyId, tenant.companyId))
          .limit(1);
        return rows[0];
      },
      (row) => Boolean(row),
      "tenant upgrade did not create a checkout session",
    );
    assert.ok(checkout);
    assert.equal(checkout.planId, "growth");
    assert.equal(checkout.status, "pending");
    assert.equal(
      checkout.checkoutUrl,
      `https://hydranms-preview.example.test/api/billing/ablepay/redirect/${checkout.id}`,
    );
    assert.doesNotMatch(checkout.checkoutUrl ?? "", /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i);

    const redirectResponse = await fetch(`${baseUrl}/api/billing/ablepay/redirect/${checkout.id}`, {
      headers: {
        "x-forwarded-host": "hydranms-preview.example.test",
        "x-forwarded-proto": "https",
      },
    });
    const redirectHtml = await redirectResponse.text();
    assert.equal(redirectResponse.status, 200);
    assert.match(redirectResponse.headers.get("content-type") ?? "", /text\/html/);
    assert.match(
      redirectHtml,
      /<form method="post" action="https:\/\/ablepay\.test\/v2\/paymentrequest">/,
    );
    assert.match(
      redirectHtml,
      /name="return_url" value="https:\/\/hydranms-preview\.example\.test\/api\/billing\/ablepay\/return"/,
    );
    assert.match(redirectHtml, /name="order_id" value="[^"]+"/);
    assert.match(redirectHtml, /name="hash" value="[A-F0-9]{128}"/);
    assert.doesNotMatch(redirectHtml, /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)/i);
  } finally {
    await page?.close();
    await stopChildProcess(browser);
    proxy && await stopServer(proxy);
    await stopChildProcess(frontend);
    apiServer && await stopServer(apiServer);
    for (const [name, value] of Object.entries(previous)) {
      const envName =
        name === "ablePayApiUrl"
          ? "ABLEPAY_API_URL"
          : name === "ablePayApiKey"
            ? "ABLEPAY_API_KEY"
            : name === "ablePaySalt"
              ? "ABLEPAY_SALT"
              : "PUBLIC_APP_URL";
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
    await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.companyId, companyIds));
    await db.delete(checkoutSessions).where(inArray(checkoutSessions.companyId, companyIds));
    await db.delete(licenses).where(inArray(licenses.companyId, companyIds));
    await db.delete(auditLogs).where(inArray(auditLogs.companyId, companyIds));
    await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
    await db.delete(companies).where(inArray(companies.id, companyIds));
  }
});

test("signed payment metadata cannot activate a different company or plan", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for payment metadata tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for payment metadata tests");
  assert.ok(process.env.SUPERADMIN_PASSWORD, "SUPERADMIN_PASSWORD is required for payment metadata tests");

  const previousWebhookSecret = process.env.ABLEPAY_WEBHOOK_SECRET;
  const webhookSecret = "payment-metadata-test-secret";
  process.env.ABLEPAY_WEBHOOK_SECRET = webhookSecret;
  const companyIds: string[] = [];
  const webhookEventIds: string[] = [];
  let server: Server | undefined;

  try {
    await ensurePortalData();
    server = await startServer();
    const checkoutCompany = await registerTenant("payment-metadata-checkout");
    const conflictingCompany = await registerTenant("payment-metadata-conflict");
    companyIds.push(checkoutCompany.companyId, conflictingCompany.companyId);
    const adminCookie = await login(
      process.env.SUPERADMIN_USERNAME ?? "superadmin-admin",
      process.env.SUPERADMIN_PASSWORD!,
    );
    const checkout = await createCheckoutSession({
      companyId: checkoutCompany.companyId,
      planId: "growth",
      amount: 7499,
      currency: "INR",
    });

    const conflictingCompanyPayload = {
      id: `evt-${suffix("conflicting-company")}`,
      type: "payment.succeeded",
      data: {
        status: "paid",
        checkoutId: checkout.id,
        companyId: conflictingCompany.companyId,
      },
    };
    const conflictingPlanPayload = {
      id: `evt-${suffix("conflicting-plan")}`,
      type: "payment.succeeded",
      data: {
        status: "paid",
        checkoutId: checkout.id,
        planId: "enterprise",
      },
    };
    for (const payload of [conflictingCompanyPayload, conflictingPlanPayload]) {
      webhookEventIds.push(payload.id);
      const signed = signedWebhook(payload, webhookSecret);
      const response = await request("/api/billing/webhooks/ablepay", {
        method: "POST",
        rawBody: signed.rawBody,
        headers: { "x-ablepay-signature": signed.signature },
      });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.deepEqual(response.body, { error: "Payment metadata does not match checkout" });
    }

    const [checkoutCompanyLicense, conflictingCompanyLicense, storedCheckout, webhookRows] = await Promise.all([
      db.select().from(licenses).where(eq(licenses.companyId, checkoutCompany.companyId)),
      db.select().from(licenses).where(eq(licenses.companyId, conflictingCompany.companyId)),
      db.select().from(checkoutSessions).where(eq(checkoutSessions.id, checkout.id)).limit(1).then((rows) => rows[0]),
      db.select().from(paymentWebhookEvents).where(inArray(paymentWebhookEvents.eventId, webhookEventIds)),
    ]);
    assert.equal(checkoutCompanyLicense.length, 1, "mismatched metadata must not create another checkout-company license");
    assert.equal(conflictingCompanyLicense.length, 1, "mismatched metadata must not create another conflicting-company license");
    assert.equal(checkoutCompanyLicense[0].status, "expired");
    assert.equal(checkoutCompanyLicense[0].planId, "starter");
    assert.equal(conflictingCompanyLicense[0].status, "expired");
    assert.equal(conflictingCompanyLicense[0].planId, "starter");
    assert.equal(storedCheckout?.status, "pending", "rejected metadata must not mark the checkout paid");
    assert.equal(webhookRows.length, 2);
    assert.ok(webhookRows.every((row) => row.status === "rejected"));
    assert.ok(webhookRows.some((row) => row.error === "Payment metadata does not match checkout (company)"));
    assert.ok(webhookRows.some((row) => row.error === "Payment metadata does not match checkout (plan)"));

    const visibleWebhooks = await request("/api/admin/billing/webhook-events", {
      headers: { cookie: adminCookie },
    });
    assert.equal(visibleWebhooks.status, 200);
    assert.ok(
      webhookEventIds.every((eventId) =>
        visibleWebhooks.body.some((row: any) => row.eventId === eventId && row.status === "rejected"),
      ),
      "rejected payment events must remain visible to administrators",
    );
  } finally {
    if (previousWebhookSecret === undefined) delete process.env.ABLEPAY_WEBHOOK_SECRET;
    else process.env.ABLEPAY_WEBHOOK_SECRET = previousWebhookSecret;
    if (server) await stopServer(server);
    if (companyIds.length) {
      await db.delete(paymentWebhookEvents).where(inArray(paymentWebhookEvents.eventId, webhookEventIds));
      await db.delete(checkoutSessions).where(inArray(checkoutSessions.companyId, companyIds));
      await db.delete(licenses).where(inArray(licenses.companyId, companyIds));
      await db.delete(auditLogs).where(inArray(auditLogs.companyId, companyIds));
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
  }
});

test("email and Telegram failures back off and stop at the attempt limit", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for payment flow tests");
  const previous = {
    emailProvider: process.env.EMAIL_PROVIDER,
    emailFrom: process.env.EMAIL_FROM,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  };
  delete process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_FROM;
  delete process.env.TELEGRAM_BOT_TOKEN;
  const companyIds: string[] = [];
  let server: Server | undefined;

  try {
    await ensurePortalData();
    server = await startServer();
    const tenant = await registerTenant("notification-retry");
    companyIds.push(tenant.companyId);
    const [email, telegram] = await Promise.all([
      queueNotification({
        companyId: tenant.companyId,
        channel: "email",
        eventType: "test.email",
        recipient: tenant.email,
        subject: "Test",
        body: "Test",
        idempotencyKey: `test-email:${tenant.companyId}`,
      }),
      queueNotification({
        companyId: tenant.companyId,
        channel: "telegram",
        eventType: "test.telegram",
        recipient: "123456",
        body: "Test",
        idempotencyKey: `test-telegram:${tenant.companyId}`,
      }),
    ]);
    assert.ok(email && telegram);
    const [failedEmail, failedTelegram] = await Promise.all([
      deliverNotification(email.id),
      deliverNotification(telegram.id),
    ]);
    assert.equal(failedEmail?.status, "failed");
    assert.equal(failedTelegram?.status, "failed");
    assert.equal(failedEmail?.attempts, 1);
    assert.equal(failedTelegram?.attempts, 1);
    assert.ok(failedEmail.nextAttemptAt.getTime() > Date.now());
    assert.ok(failedTelegram.nextAttemptAt.getTime() > Date.now());

    await db
      .update(notificationDeliveries)
      .set({ maxAttempts: 1, nextAttemptAt: new Date() })
      .where(eq(notificationDeliveries.id, email.id));
    assert.equal(await retryNotification(email.id), null, "exhausted deliveries must not be manually retried");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name === "emailProvider" ? "EMAIL_PROVIDER" : name === "emailFrom" ? "EMAIL_FROM" : "TELEGRAM_BOT_TOKEN"];
      else process.env[name === "emailProvider" ? "EMAIL_PROVIDER" : name === "emailFrom" ? "EMAIL_FROM" : "TELEGRAM_BOT_TOKEN"] = value;
    }
    if (server) await stopServer(server);
    if (companyIds.length) {
      await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.companyId, companyIds));
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
  }
});

test("super-admin browser flow explains retryable and exhausted delivery failures", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for browser delivery tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for browser delivery tests");
  assert.ok(process.env.SUPERADMIN_PASSWORD, "SUPERADMIN_PASSWORD is required for browser delivery tests");

  const previous = {
    emailProvider: process.env.EMAIL_PROVIDER,
    emailFrom: process.env.EMAIL_FROM,
    sendgridKey: process.env.SENDGRID_API_KEY,
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  };
  const companyIds: string[] = [];
  let apiServer: Server | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: Server | undefined;
  let browser: ChildProcess | undefined;
  let page: CdpPage | undefined;

  try {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_FROM;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;

    await ensurePortalData();
    apiServer = await startServer();
    const tenant = await registerTenant("notification-browser");
    companyIds.push(tenant.companyId);

    const retryable = await queueNotification({
      companyId: tenant.companyId,
      channel: "email",
      eventType: "browser.retryable",
      recipient: tenant.email,
      subject: "Retryable browser test",
      body: "Retryable browser test",
      idempotencyKey: `browser-retryable:${tenant.companyId}`,
    });
    const exhausted = await queueNotification({
      companyId: tenant.companyId,
      channel: "telegram",
      eventType: "browser.exhausted",
      recipient: "browser-test-chat",
      body: "Exhausted browser test",
      idempotencyKey: `browser-exhausted:${tenant.companyId}`,
    });
    assert.ok(retryable && exhausted);
    const [failedRetryable, failedExhausted] = await Promise.all([
      deliverNotification(retryable.id),
      deliverNotification(exhausted.id),
    ]);
    assert.equal(failedRetryable?.status, "failed");
    assert.equal(failedExhausted?.status, "failed");
    assert.equal(failedRetryable?.attempts, 1);
    assert.equal(failedExhausted?.attempts, 1);
    await db
      .update(notificationDeliveries)
      .set({ maxAttempts: 1 })
      .where(eq(notificationDeliveries.id, exhausted.id));

    const frontendPort = await unusedPort();
    frontend = startHydraFrontend(frontendPort);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`);
    proxy = await startBrowserProxy(frontendPort);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");

    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;
    await page.command("Page.navigate", { url: `http://127.0.0.1:${proxyAddress.port}/login` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('input[placeholder="aarav@northstar.in"]'))`,
      "login form did not load",
    );
    await browserFill(
      page,
      'input[placeholder="aarav@northstar.in"]',
      process.env.SUPERADMIN_USERNAME ?? "superadmin-admin",
    );
    await browserFill(page, '[data-testid="input-login-password"]', process.env.SUPERADMIN_PASSWORD);
    await browserClick(page, '[data-testid="button-submit-login"]');
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="link-nav-settings"]'))`,
      "authenticated super-admin shell did not load",
    );
    await browserClick(page, '[data-testid="link-nav-settings"]');
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="button-settings-alert-channels"]'))`,
      "Settings page did not load",
    );
    await browserClick(page, '[data-testid="button-settings-alert-channels"]');

    const retryableRowSelector = `[data-testid="delivery-row-${retryable.id}"]`;
    const exhaustedRowSelector = `[data-testid="delivery-row-${exhausted.id}"]`;
    await browserWaitFor(
      page,
      `Boolean(document.querySelector(${JSON.stringify(retryableRowSelector)}) && document.querySelector(${JSON.stringify(exhaustedRowSelector)}))`,
      "delivery activity did not load",
    );
    const retryableDetails = await page.evaluate<string>(
      `document.querySelector(${JSON.stringify(retryableRowSelector)})?.textContent ?? ""`,
    );
    assert.match(retryableDetails, /Next automatic retry:/);
    const retryButton = await page.evaluate<{ count: number; disabled?: boolean }>(
      `(() => {
        const element = document.querySelector(${JSON.stringify(`[data-testid="button-retry-delivery-${retryable.id}"]`)});
        return { count: element ? 1 : 0, disabled: element?.disabled };
      })()`,
    );
    assert.deepEqual(retryButton, { count: 1, disabled: false });

    const exhaustedDetails = await page.evaluate<string>(
      `document.querySelector(${JSON.stringify(exhaustedRowSelector)})?.textContent ?? ""`,
    );
    assert.match(exhaustedDetails, /Retry unavailable: this delivery has used all 1 attempts/);
    assert.match(exhaustedDetails, /TELEGRAM_BOT_TOKEN/);
    const exhaustedRetryButtonCount = await page.evaluate<number>(
      `document.querySelectorAll(${JSON.stringify(`[data-testid="button-retry-delivery-${exhausted.id}"]`)}).length`,
    );
    assert.equal(exhaustedRetryButtonCount, 0);

    await db
      .update(notificationDeliveries)
      .set({ maxAttempts: 1 })
      .where(eq(notificationDeliveries.id, retryable.id));
    await browserClick(page, `[data-testid="button-retry-delivery-${retryable.id}"]`);
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[role="alert"]')?.textContent?.includes("This delivery has exhausted its maximum of 1 attempts and cannot be retried."))`,
      "the raced retry response was not shown to the operator",
    );
  } finally {
    await page?.close();
    await stopChildProcess(browser);
    proxy && await stopServer(proxy);
    await stopChildProcess(frontend);
    apiServer && await stopServer(apiServer);
    for (const [name, value] of Object.entries(previous)) {
      const envName =
        name === "emailProvider"
          ? "EMAIL_PROVIDER"
          : name === "emailFrom"
            ? "EMAIL_FROM"
            : name === "sendgridKey"
              ? "SENDGRID_API_KEY"
              : "TELEGRAM_BOT_TOKEN";
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
    if (companyIds.length) {
      await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.companyId, companyIds));
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
  }
});

test("company admins can manage team members while operators cannot see team controls", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for team member browser tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for team member browser tests");

  const companyIds: string[] = [];
  let apiServer: Server | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: Server | undefined;
  let browser: ChildProcess | undefined;
  let page: CdpPage | undefined;

  try {
    await ensurePortalData();
    apiServer = await startServer();

    const tenant = await registerTenant("team-members-browser");
    companyIds.push(tenant.companyId);
    const operatorValue = suffix("managed-operator");
    const operator = {
      username: operatorValue,
      email: `${operatorValue}@example.test`,
      password: `${operatorValue}-Password!`,
    };

    const frontendPort = await unusedPort();
    frontend = startHydraFrontend(frontendPort);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`);
    proxy = await startBrowserProxy(frontendPort);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");
    const browserUrl = `http://127.0.0.1:${proxyAddress.port}`;

    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;
    await page.command("Page.navigate", { url: `${browserUrl}/login` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
      "company-admin login form did not load",
    );
    await browserFill(page, '[data-testid="input-email-or-username"]', tenant.username);
    await browserFill(page, '[data-testid="input-login-password"]', tenant.password);
    await browserClick(page, '[data-testid="button-submit-login"]');
    await browserWaitFor(
      page,
      `Boolean(localStorage.getItem("hydranms-token")) && location.pathname === "/"`,
      "company admin did not sign in through the browser",
    );

    await page.command("Page.navigate", { url: `${browserUrl}/settings` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="button-settings-team-members"]'))`,
      "company admin did not see the Team members tab",
    );
    await browserClick(page, '[data-testid="button-settings-team-members"]');
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="button-add-company-user"]'))`,
      "Team members panel did not load",
    );

    await browserClick(page, '[data-testid="button-add-company-user"]');
    await browserFill(page, '[data-testid="input-username"]', operator.username);
    await browserFill(page, '[data-testid="input-work-email"]', operator.email);
    await browserFill(page, '[data-testid="input-temporary-password"]', operator.password);
    await browserSelect(page, '[data-testid="select-role"]', "operator");
    await browserClick(page, '[data-testid="button-submit-company-user"]');

    const operatorRowSelector = `[data-testid^="row-company-user-"]`;
    await browserWaitFor(
      page,
      `Array.from(document.querySelectorAll(${JSON.stringify(operatorRowSelector)})).some((row) => row.textContent?.includes(${JSON.stringify(operator.username)}))`,
      "new operator did not appear in Team members",
    );
    const operatorRow = await page.evaluate<{ id: string; role: string; status: string; action: string }>(
      `(() => {
        const row = Array.from(document.querySelectorAll(${JSON.stringify(operatorRowSelector)}))
          .find((candidate) => candidate.textContent?.includes(${JSON.stringify(operator.username)}));
        if (!(row instanceof HTMLElement)) return { id: "", role: "", status: "", action: "" };
        return {
          id: row.dataset.testid?.replace("row-company-user-", "") ?? "",
          role: row.querySelector("select")?.value ?? "",
          status: row.querySelector(".status")?.textContent?.trim() ?? "",
          action: row.querySelector("button")?.textContent?.trim() ?? "",
        };
      })()`,
    );
    assert.ok(operatorRow.id);
    assert.equal(operatorRow.role, "operator");
    assert.equal(operatorRow.status, "active");
    assert.equal(operatorRow.action, "Deactivate");

    const roleSelector = `[data-testid="select-company-user-role-${operatorRow.id}"]`;
    const statusButtonSelector = `[data-testid="button-toggle-company-user-${operatorRow.id}"]`;
    await browserSelect(page, roleSelector, "company_admin");
    await browserWaitFor(
      page,
      `document.querySelector(${JSON.stringify(roleSelector)})?.value === "company_admin"`,
      "changing the managed user's role did not update the row",
    );
    await browserSelect(page, roleSelector, "operator");
    await browserWaitFor(
      page,
      `document.querySelector(${JSON.stringify(roleSelector)})?.value === "operator"`,
      "restoring the managed user's role did not update the row",
    );
    await browserClick(page, statusButtonSelector);
    await browserWaitFor(
      page,
      `document.querySelector(${JSON.stringify(statusButtonSelector)})?.textContent?.includes("Activate")`,
      "deactivating the managed user did not update the row",
    );
    await browserClick(page, statusButtonSelector);
    await browserWaitFor(
      page,
      `document.querySelector(${JSON.stringify(statusButtonSelector)})?.textContent?.includes("Deactivate")`,
      "reactivating the managed user did not update the row",
    );

    await browserClick(page, '[data-testid="button-logout"]');
    await browserWaitFor(
      page,
      `location.pathname === "/login" && Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
      "company admin did not sign out",
    );
    await browserFill(page, '[data-testid="input-email-or-username"]', operator.username);
    await browserFill(page, '[data-testid="input-login-password"]', operator.password);
    await browserClick(page, '[data-testid="button-submit-login"]');
    await browserWaitFor(
      page,
      `Boolean(localStorage.getItem("hydranms-token")) && location.pathname === "/"`,
      "managed operator did not sign in through the browser",
    );
    await page.command("Page.navigate", { url: `${browserUrl}/settings` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="button-settings-portal"]'))`,
      "operator Settings page did not load",
    );
    const operatorControls = await page.evaluate<{ teamTab: number; addButton: number }>(
      `({
        teamTab: document.querySelectorAll('[data-testid="button-settings-team-members"]').length,
        addButton: document.querySelectorAll('[data-testid="button-add-company-user"]').length,
      })`,
    );
    assert.deepEqual(operatorControls, { teamTab: 0, addButton: 0 });
  } finally {
    await page?.close();
    await stopChildProcess(browser);
    proxy && await stopServer(proxy);
    await stopChildProcess(frontend);
    apiServer && await stopServer(apiServer);
    if (companyIds.length) {
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
  }
});

test("super-admin billing company details stay private and persist through browser reload", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for billing profile browser tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for billing profile browser tests");
  const superAdminPassword = process.env.SUPERADMIN_PASSWORD?.trim();
  assert.ok(superAdminPassword, "SUPERADMIN_PASSWORD is required for billing profile browser tests");

  const companyIds: string[] = [];
  const logoFile = `/tmp/hydranms-billing-profile-${suffix("logo")}.png`;
  let apiServer: Server | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: Server | undefined;
  let browser: ChildProcess | undefined;
  let page: CdpPage | undefined;
  let adminCookie = "";
  let tenantCookie = "";
  let operatorCookie = "";
  let originalProfile: Record<string, unknown> | undefined;

  try {
    await ensurePortalData();
    apiServer = await startServer();

    const adminIdentifier = process.env.SUPERADMIN_USERNAME ?? "superadmin-admin";
    adminCookie = await login(adminIdentifier, superAdminPassword);
    const profileBefore = await request("/api/admin/company-profile", { headers: { cookie: adminCookie } });
    assert.equal(profileBefore.status, 200, JSON.stringify(profileBefore.body));
    originalProfile = profileBefore.body;

    const tenant = await registerTenant("billing-profile-browser");
    companyIds.push(tenant.companyId);
    tenantCookie = await login(tenant.email, tenant.password);
    const operatorValue = suffix("billing-profile-operator");
    const createdOperator = await request("/api/company/users", {
      method: "POST",
      headers: { cookie: tenantCookie },
      body: {
        username: operatorValue,
        email: `${operatorValue}@example.test`,
        password: `${operatorValue}-Password!`,
        role: "operator",
      },
    });
    assert.equal(createdOperator.status, 201, JSON.stringify(createdOperator.body));
    operatorCookie = await login(`${operatorValue}@example.test`, `${operatorValue}-Password!`);

    const expectedProfile = {
      companyName: `${suffix("billing-profile")} Platform`,
      address: "42 Billing Identity Road, Bengaluru",
      gstNumber: "29HYDRANMS1234Z5",
      phoneNumber: "08040001234",
      email: `${suffix("billing-contact")}@example.test`,
    };
    const logoBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(logoFile, logoBytes);

    const frontendPort = await unusedPort();
    frontend = startHydraFrontend(frontendPort);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`);
    proxy = await startBrowserProxy(frontendPort);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");
    const browserUrl = `http://127.0.0.1:${proxyAddress.port}`;

    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;
    await page.command("Page.navigate", { url: `${browserUrl}/login` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
      "super-admin login form did not load",
    );
    await browserFill(page, '[data-testid="input-email-or-username"]', adminIdentifier);
    await browserFill(page, '[data-testid="input-login-password"]', superAdminPassword);
    await browserClick(page, '[data-testid="button-submit-login"]');
    await browserWaitFor(
      page,
      `Boolean(localStorage.getItem("hydranms-token")) && location.pathname === "/"`,
      "super-admin did not sign in through the browser",
    );

    await page.command("Page.navigate", { url: `${browserUrl}/plans` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="section-superadmin-company-details"]')) && Boolean(document.querySelector('[data-testid="input-company-name"]'))`,
      "super-admin company details form did not load",
    );
    await browserFill(page, '[data-testid="input-company-name"]', expectedProfile.companyName);
    await browserFill(page, '[data-testid="input-gst-number"]', expectedProfile.gstNumber);
    await browserFill(page, '[data-testid="input-company-phone-number"]', expectedProfile.phoneNumber);
    await browserFill(page, '[data-testid="input-company-email"]', expectedProfile.email);
    await browserFill(page, '[data-testid="textarea-company-address"]', expectedProfile.address);
    await browserSetFile(page, '[data-testid="input-superadmin-company-logo"]', logoFile);
    await browserWaitFor(
      page,
      `document.querySelector('[data-testid="status-billing-action"]')?.textContent?.includes("Logo uploaded")`,
      "super-admin logo upload did not complete",
    );
    await browserClick(page, '[data-testid="button-save-superadmin-company-details"]');
    await browserWaitFor(
      page,
      `document.querySelector('[data-testid="status-billing-action"]')?.textContent?.includes("Super-admin company details saved")`,
      "super-admin company details were not saved",
    );

    const persistedProfile = await page.evaluate<Record<string, unknown>>(
      `fetch("/api/admin/company-profile").then((response) => response.json())`,
    );
    assert.deepEqual(
      {
        companyName: persistedProfile.companyName,
        address: persistedProfile.address,
        gstNumber: persistedProfile.gstNumber,
        phoneNumber: persistedProfile.phoneNumber,
        email: persistedProfile.email,
      },
      expectedProfile,
    );
    assert.match(String(persistedProfile.logoPath), /^\/objects\/uploads\//);

    await page.command("Page.reload");
    await browserWaitFor(
      page,
      `document.querySelector('[data-testid="input-company-name"]')?.value === ${JSON.stringify(expectedProfile.companyName)} && document.querySelector('[data-testid="textarea-company-address"]')?.value === ${JSON.stringify(expectedProfile.address)} && document.querySelector('[data-testid="input-company-email"]')?.value === ${JSON.stringify(expectedProfile.email)}`,
      "saved super-admin company details did not survive a fresh reload",
    );
    const reloadedProfile = await page.evaluate<Record<string, string>>(
      `({
        companyName: document.querySelector('[data-testid="input-company-name"]')?.value ?? "",
        gstNumber: document.querySelector('[data-testid="input-gst-number"]')?.value ?? "",
        phoneNumber: document.querySelector('[data-testid="input-company-phone-number"]')?.value ?? "",
        email: document.querySelector('[data-testid="input-company-email"]')?.value ?? "",
        address: document.querySelector('[data-testid="textarea-company-address"]')?.value ?? "",
        logoCount: String(document.querySelectorAll('[data-testid="section-superadmin-company-details"] img[alt="Company logo"]').length),
      })`,
    );
    assert.deepEqual(reloadedProfile, { ...expectedProfile, logoCount: "1" });

    await browserWaitFor(
      page,
      `document.querySelector('[data-testid="button-invoice-plan-starter"]')?.disabled === false`,
      "platform invoice action did not become ready after profile reload",
    );
    await browserClick(page, '[data-testid="button-invoice-plan-starter"]');
    await browserWaitFor(
      page,
      `document.querySelector('.invoice-printable')?.textContent?.includes(${JSON.stringify(expectedProfile.companyName)}) && document.querySelector('.invoice-printable')?.textContent?.includes(${JSON.stringify(expectedProfile.gstNumber)}) && document.querySelector('.invoice-printable')?.textContent?.includes(${JSON.stringify(expectedProfile.phoneNumber)}) && document.querySelector('.invoice-printable')?.textContent?.includes(${JSON.stringify(expectedProfile.email)})`,
      "platform invoice did not use the saved company identity",
    );
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('.invoice-printable img[alt="Company logo"]'))`,
      "platform invoice did not load the saved company logo",
    );
    await browserClick(page, '[data-testid="button-close-dialog"]');

    const revisedProfile = {
      ...expectedProfile,
      companyName: `${suffix("revised-billing-profile")} Platform`,
      address: "18 Updated Invoice Avenue, Pune",
    };
    await browserFill(page, '[data-testid="input-company-name"]', revisedProfile.companyName);
    await browserFill(page, '[data-testid="textarea-company-address"]', revisedProfile.address);
    await browserClick(page, '[data-testid="button-save-superadmin-company-details"]');
    await browserWaitFor(
      page,
      `document.querySelector('[data-testid="status-billing-action"]')?.textContent?.includes("Super-admin company details saved")`,
      "revised super-admin company details were not saved",
    );
    await browserWaitFor(
      page,
      `document.querySelector('[data-testid="button-invoice-plan-starter"]')?.disabled === false`,
      "platform invoice action did not become ready after profile edit",
    );
    await browserClick(page, '[data-testid="button-invoice-plan-starter"]');
    await browserWaitFor(
      page,
      `document.querySelector('.invoice-printable')?.textContent?.includes(${JSON.stringify(revisedProfile.companyName)}) && document.querySelector('.invoice-printable')?.textContent?.includes(${JSON.stringify(revisedProfile.address)})`,
      "a fresh platform invoice did not reflect the revised company identity",
    );
    await browserClick(page, '[data-testid="button-close-dialog"]');

    await page.evaluate<void>(
      `fetch("/api/admin/company-profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(${JSON.stringify({ ...revisedProfile, logoPath: null })}) }).then((response) => { if (!response.ok) throw new Error("optional logo profile update failed"); })`,
    );
    await page.command("Page.reload");
    await browserWaitFor(
      page,
      `document.querySelector('[data-testid="input-company-name"]')?.value === ${JSON.stringify(revisedProfile.companyName)}`,
      "super-admin company details did not reload after clearing the optional logo",
    );
    await browserWaitFor(
      page,
      `document.querySelector('[data-testid="button-invoice-plan-starter"]')?.disabled === false`,
      "platform invoice action did not become ready without optional branding",
    );
    await browserClick(page, '[data-testid="button-invoice-plan-starter"]');
    await browserWaitFor(
      page,
      `document.querySelector('.invoice-printable')?.textContent?.includes(${JSON.stringify(revisedProfile.companyName)}) && !document.querySelector('.invoice-printable img[alt="Company logo"]')`,
      "platform invoice did not render without optional branding",
    );
    await browserClick(page, '[data-testid="button-close-dialog"]');

    for (const [role, cookie] of [["company admin", tenantCookie], ["operator", operatorCookie]] as const) {
      const read = await request("/api/admin/company-profile", { headers: { cookie } });
      assert.equal(read.status, 403, `${role} must not read the super-admin company profile`);
      const update = await request("/api/admin/company-profile", {
        method: "PATCH",
        headers: { cookie },
        body: { ...expectedProfile, logoPath: persistedProfile.logoPath },
      });
      assert.equal(update.status, 403, `${role} must not edit the super-admin company profile`);
      const logoObject = String(persistedProfile.logoPath).replace(/^\/objects\//, "");
      const logoRead = await request(`/api/storage/objects/${logoObject}`, { headers: { cookie } });
      assert.equal(logoRead.status, 403, `${role} must not read the super-admin company logo`);
      const upload = await request("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { cookie },
        body: { name: "blocked.png", size: logoBytes.length, contentType: "image/png" },
      });
      assert.equal(upload.status, 403, `${role} must not upload a super-admin company logo`);
    }

    await browserClick(page, '[data-testid="button-logout"]');
    await browserWaitFor(
      page,
      `location.pathname === "/login" && Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
      "super-admin did not sign out",
    );
    await browserFill(page, '[data-testid="input-email-or-username"]', tenant.email);
    await browserFill(page, '[data-testid="input-login-password"]', tenant.password);
    await browserClick(page, '[data-testid="button-submit-login"]');
    await browserWaitFor(
      page,
      `Boolean(localStorage.getItem("hydranms-token")) && location.pathname === "/"`,
      "company admin did not sign in through the browser",
    );
    await page.command("Page.navigate", { url: `${browserUrl}/plans` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="section-payment-history"]'))`,
      "company admin Plans & billing page did not load",
    );
    assert.equal(
      await page.evaluate<number>(
        `document.querySelectorAll('[data-testid="section-superadmin-company-details"], [data-testid="button-save-superadmin-company-details"]').length`,
      ),
      0,
      "company admin must not see super-admin billing controls",
    );

    await browserClick(page, '[data-testid="button-logout"]');
    await browserWaitFor(
      page,
      `location.pathname === "/login" && Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
      "company admin did not sign out",
    );
    await browserFill(page, '[data-testid="input-email-or-username"]', `${operatorValue}@example.test`);
    await browserFill(page, '[data-testid="input-login-password"]', `${operatorValue}-Password!`);
    await browserClick(page, '[data-testid="button-submit-login"]');
    await browserWaitFor(
      page,
      `Boolean(localStorage.getItem("hydranms-token")) && location.pathname === "/"`,
      "operator did not sign in through the browser",
    );
    await page.command("Page.navigate", { url: `${browserUrl}/plans` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="section-payment-history"]'))`,
      "operator Plans & billing page did not load",
    );
    assert.equal(
      await page.evaluate<number>(
        `document.querySelectorAll('[data-testid="section-superadmin-company-details"], [data-testid="button-save-superadmin-company-details"]').length`,
      ),
      0,
      "operator must not see super-admin billing controls",
    );
  } finally {
    if (adminCookie && originalProfile) {
      await request("/api/admin/company-profile", {
        method: "PATCH",
        headers: { cookie: adminCookie },
        body: originalProfile,
      });
    }
    await page?.close();
    await stopChildProcess(browser);
    proxy && await stopServer(proxy);
    await stopChildProcess(frontend);
    apiServer && await stopServer(apiServer);
    if (companyIds.length) {
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
    try {
      unlinkSync(logoFile);
    } catch {
      // The file may not have been created if setup failed.
    }
  }
});

test("authenticated users can manage personal profiles across roles and recover sessions after password change", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for profile browser tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for profile browser tests");
  const superAdminPassword = process.env.SUPERADMIN_PASSWORD?.trim();
  assert.ok(superAdminPassword, "SUPERADMIN_PASSWORD is required for profile browser tests");

  const companyIds: string[] = [];
  const profileFile = `/tmp/hydranms-user-profile-${suffix("picture")}.png`;
  let apiServer: Server | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: Server | undefined;
  let browser: ChildProcess | undefined;
  let page: CdpPage | undefined;
  let superAdminCookie = "";
  let originalProfile: Record<string, unknown> | undefined;
  let tenantAvatarPath = "";
  let otherTenant: { companyId: string; username: string; email: string; password: string } | undefined;

  try {
    await ensurePortalData();
    apiServer = await startServer();

    const adminIdentifier = process.env.SUPERADMIN_USERNAME ?? "superadmin-admin";
    superAdminCookie = await login(adminIdentifier, superAdminPassword);
    const originalProfileResponse = await request("/api/auth/profile", { headers: { cookie: superAdminCookie } });
    assert.equal(originalProfileResponse.status, 200, JSON.stringify(originalProfileResponse.body));
    originalProfile = originalProfileResponse.body;

    const tenant = await registerTenant("user-profile-browser");
    companyIds.push(tenant.companyId);
    otherTenant = await registerTenant("user-profile-browser-other");
    companyIds.push(otherTenant.companyId);
    const operatorValue = suffix("user-profile-operator");
    const operatorResponse = await request("/api/company/users", {
      method: "POST",
      headers: { cookie: await login(tenant.email, tenant.password) },
      body: {
        username: operatorValue,
        email: `${operatorValue}@example.test`,
        password: `${operatorValue}-Password!`,
        role: "operator",
      },
    });
    assert.equal(operatorResponse.status, 201, JSON.stringify(operatorResponse.body));

    const unauthenticatedChecks = [
      request("/api/auth/profile"),
      request("/api/auth/profile", { method: "PATCH", body: { name: "Unauthenticated", avatarPath: null } }),
      request("/api/auth/profile/password", {
        method: "PATCH",
        body: { currentPassword: "wrong", newPassword: "NewPassword!" },
      }),
      request("/api/storage/uploads/request-url", {
        method: "POST",
        body: { name: "profile.png", size: 1, contentType: "image/png", purpose: "profile" },
      }),
    ];
    for (const response of await Promise.all(unauthenticatedChecks)) {
      assert.equal(response.status, 401, "profile and password resources must require authentication");
    }

    const pictureBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(profileFile, pictureBytes);

    const frontendPort = await unusedPort();
    frontend = startHydraFrontend(frontendPort);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`);
    proxy = await startBrowserProxy(frontendPort);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");
    const browserUrl = `http://127.0.0.1:${proxyAddress.port}`;

    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;

    const roles = [
      {
        label: "super-admin",
        identifier: adminIdentifier,
        password: superAdminPassword,
        expectedRole: "super_admin",
        expectedEmail: String(originalProfile?.email),
        expectedUsername: String(originalProfile?.username),
      },
      {
        label: "company admin",
        identifier: tenant.email,
        password: tenant.password,
        expectedRole: "company_admin",
        expectedEmail: tenant.email,
        expectedUsername: tenant.username,
      },
      {
        label: "operator",
        identifier: `${operatorValue}@example.test`,
        password: `${operatorValue}-Password!`,
        expectedRole: "operator",
        expectedEmail: `${operatorValue}@example.test`,
        expectedUsername: operatorValue,
      },
    ] as const;

    for (const role of roles) {
      await page.command("Page.navigate", { url: `${browserUrl}/login` });
      await browserWaitFor(
        page,
        `Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
        `${role.label} login form did not load`,
      );
      await browserFill(page, '[data-testid="input-email-or-username"]', role.identifier);
      await browserFill(page, '[data-testid="input-login-password"]', role.password);
      await browserClick(page, '[data-testid="button-submit-login"]');
      await browserWaitFor(
        page,
        `Boolean(localStorage.getItem("hydranms-token")) && location.pathname === "/"`,
        `${role.label} did not sign in through the browser`,
      );

      await page.command("Page.navigate", { url: `${browserUrl}/settings` });
      await browserWaitFor(
        page,
        `Boolean(document.querySelector('[data-testid="button-settings-user-profile"]')) && Boolean(document.querySelector('[data-testid="input-profile-email"]'))`,
        `${role.label} My profile did not load`,
      );
      const initialProfile: { email: string; username: string; role: string; hasPictureControl: boolean; hasPasswordControls: boolean } = await page.evaluate(
        `({
          email: document.querySelector('[data-testid="input-profile-email"]')?.value ?? "",
          username: document.querySelector('[data-testid="input-profile-username"]')?.value ?? "",
          role: document.querySelector('.settings-profile-head .status')?.textContent?.trim() ?? "",
          hasPictureControl: Boolean(document.querySelector('[data-testid="input-profile-picture"]')),
          hasPasswordControls: Boolean(document.querySelector('[data-testid="input-profile-current-password"]')) && Boolean(document.querySelector('[data-testid="button-change-password"]')),
        })`,
      );
      assert.deepEqual(
        initialProfile,
        {
          email: role.expectedEmail,
          username: role.expectedUsername,
          role: role.expectedRole === "super_admin" ? "Super-admin" : role.expectedRole === "company_admin" ? "Company admin" : "Operator",
          hasPictureControl: true,
          hasPasswordControls: true,
        },
        `${role.label} profile controls did not match the signed-in user`,
      );

      const updatedName = `${role.label} Profile ${suffix("saved")}`;
      await browserFill(page, '[data-testid="input-name"]', updatedName);
      await browserSetFile(page, '[data-testid="input-profile-picture"]', profileFile);
      await browserWaitFor(
        page,
        `document.querySelector('[role="status"]')?.textContent?.includes("Picture uploaded")`,
        `${role.label} profile picture upload did not complete`,
      );
      await browserClick(page, '[data-testid="button-save-user-profile"]');
      await browserWaitFor(
        page,
        `document.querySelector('[role="status"]')?.textContent?.includes("Profile details saved") && document.querySelector('.user-name')?.textContent?.trim() === ${JSON.stringify(updatedName)}`,
        `${role.label} profile save did not update the shell identity`,
      );

      await page.command("Page.reload");
      await browserWaitFor(
        page,
        `document.querySelector('[data-testid="input-name"]')?.value === ${JSON.stringify(updatedName)} && document.querySelectorAll('.settings-user-avatar img').length >= 2`,
        `${role.label} profile changes did not survive a fresh reload`,
      );
      const persistedProfile: { name: string; email: string; username: string; avatarPath: string | null } = await page.evaluate(
        `fetch("/api/auth/profile").then((response) => response.json())`,
      );
      assert.deepEqual(
        {
          name: persistedProfile.name,
          email: persistedProfile.email,
          username: persistedProfile.username,
        },
        { name: updatedName, email: role.expectedEmail, username: role.expectedUsername },
      );
      assert.match(String(persistedProfile.avatarPath), /^\/objects\/uploads\//);
      const ownPictureStatus: number = await page.evaluate<number>(
        `fetch("/api/storage/objects/${String(persistedProfile.avatarPath).replace("/objects/", "")}").then((response) => response.status)`,
      );
      assert.equal(ownPictureStatus, 200, `${role.label} must be able to read their own profile picture`);
      if (role.expectedRole === "company_admin") {
        tenantAvatarPath = String(persistedProfile.avatarPath);
      }

      if (role.expectedRole === "company_admin") {
        const otherSessionCookie = await login(tenant.email, tenant.password);
        const wrongPassword = `${suffix("wrong")}-Password!`;
        const mismatchedNewPassword = `${suffix("unused")}-Password!`;
        await browserFill(page, '[data-testid="input-profile-current-password"]', wrongPassword);
        await browserFill(page, '[data-testid="input-profile-new-password"]', mismatchedNewPassword);
        await browserFill(page, '[data-testid="input-profile-confirm-password"]', mismatchedNewPassword);
        await browserClick(page, '[data-testid="button-change-password"]');
        await browserWaitFor(
          page,
          `document.querySelector('[role="alert"]')?.textContent?.includes("Current password is incorrect")`,
          "an incorrect current password was not rejected",
        );

        const newPassword = `${suffix("recovered")}-Password!`;
        await browserFill(page, '[data-testid="input-profile-current-password"]', tenant.password);
        await browserFill(page, '[data-testid="input-profile-new-password"]', newPassword);
        await browserFill(page, '[data-testid="input-profile-confirm-password"]', newPassword);
        await browserClick(page, '[data-testid="button-change-password"]');
        await browserWaitFor(
          page,
          `document.querySelector('[role="status"]')?.textContent?.includes("Other active sessions were signed out") && Boolean(localStorage.getItem("hydranms-token"))`,
          "a valid password change did not create a fresh browser session",
        );
        assert.equal(
          (await request("/api/auth/profile", { headers: { cookie: otherSessionCookie } })).status,
          401,
          "a password change must sign out other active sessions",
        );
        assert.equal((await login(tenant.email, newPassword)).length > 0, true);
        assert.equal(
          (await request("/api/auth/login", {
            method: "POST",
            body: { identifier: tenant.email, password: tenant.password },
          })).status,
          401,
          "the previous password must stop working after recovery",
        );
      }

      await page.command("Page.navigate", { url: `${browserUrl}/login` });
      await browserWaitFor(
        page,
        `location.pathname === "/login" && Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
        `${role.label} could not return to the login route`,
      );
    }

    assert.ok(otherTenant && tenantAvatarPath, "profile picture isolation fixtures were not created");
    await browserFill(page, '[data-testid="input-email-or-username"]', otherTenant.email);
    await browserFill(page, '[data-testid="input-login-password"]', otherTenant.password);
    await browserClick(page, '[data-testid="button-submit-login"]');
    await browserWaitFor(
      page,
      `Boolean(localStorage.getItem("hydranms-token")) && location.pathname === "/"`,
      "the other company user did not sign in through the browser",
    );
    const otherCompanyPictureStatus = await page.evaluate<number>(
      `fetch("/api/storage/objects/${tenantAvatarPath.replace(/^\/objects\//, "")}").then((response) => response.status)`,
    );
    assert.equal(
      otherCompanyPictureStatus,
      403,
      "a browser session from another company must not read the profile picture",
    );
  } finally {
    if (superAdminCookie && originalProfile) {
      await request("/api/auth/profile", {
        method: "PATCH",
        headers: { cookie: superAdminCookie },
        body: { name: originalProfile.name, avatarPath: originalProfile.avatarPath },
      });
    }
    await page?.close();
    await stopChildProcess(browser);
    proxy && await stopServer(proxy);
    await stopChildProcess(frontend);
    apiServer && await stopServer(apiServer);
    if (companyIds.length) {
      await db.delete(authSessions).where(inArray(authSessions.companyId, companyIds));
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
    try {
      unlinkSync(profileFile);
    } catch {
      // The file may not have been created if setup failed.
    }
  }
});

test("authenticated MikroTik device details hide ONU telemetry and show SFP readings", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for device detail browser tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for device detail browser tests");

  const companyIds: string[] = [];
  const deviceIds: string[] = [];
  let apiServer: Server | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: Server | undefined;
  let browser: ChildProcess | undefined;
  let page: CdpPage | undefined;

  try {
    await ensurePortalData();
    apiServer = await startServer();
    const tenant = await registerTenant("mikrotik-device-browser");
    companyIds.push(tenant.companyId);

    const deviceId = `mikrotik-browser-${suffix("device")}`;
    deviceIds.push(deviceId);
    await upsertDevice({
      id: deviceId,
      companyId: tenant.companyId,
      name: "MikroTik core switch",
      ipAddress: "192.0.2.80",
      vendor: "MikroTik",
      type: "Router",
      location: "Test lab",
      credentialId: null,
    });
    await db.insert(deviceInterfaces).values({
      id: `mikrotik-interface-${suffix("sfp")}`,
      deviceId,
      ifIndex: 1,
      name: "sfp-sfpplus1",
      alias: "Core uplink",
      adminStatus: "up",
      operStatus: "up",
      speedMbps: 10000,
      rxBytes: "123456789",
      txBytes: "987654321",
      sfpVendor: "MikroTik",
      opticalRxPower: -12.75,
      opticalTxPower: 1.25,
    });

    const frontendPort = await unusedPort();
    frontend = startHydraFrontend(frontendPort);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`);
    proxy = await startBrowserProxy(frontendPort);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");
    const browserUrl = `http://127.0.0.1:${proxyAddress.port}`;

    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;
    await page.command("Page.navigate", { url: `${browserUrl}/login` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
      "tenant login form did not load",
    );
    await browserFill(page, '[data-testid="input-email-or-username"]', tenant.email);
    await browserFill(page, '[data-testid="input-login-password"]', tenant.password);
    await browserClick(page, '[data-testid="button-submit-login"]');
    await browserWaitFor(
      page,
      `Boolean(localStorage.getItem("hydranms-token")) && location.pathname === "/"`,
      "tenant did not sign in through the browser",
    );

    const apiDetails = await page.evaluate<{
      device: { vendor: string; type: string };
      interfaces: Array<{
        sfpVendor: string | null;
        opticalRxPower: number | null;
        opticalTxPower: number | null;
      }>;
      ponTelemetry: unknown[];
    }>(
      `fetch(${JSON.stringify(`/api/devices/${deviceId}/details`)}).then(async (response) => {
        if (!response.ok) throw new Error("device details request failed: " + response.status);
        return response.json();
      })`,
    );
    assert.equal(apiDetails.device.vendor, "MikroTik");
    assert.equal(apiDetails.device.type, "Router");
    assert.deepEqual(apiDetails.ponTelemetry, []);
    assert.equal(apiDetails.interfaces[0]?.sfpVendor, "MikroTik");
    assert.equal(apiDetails.interfaces[0]?.opticalRxPower, -12.75);
    assert.equal(apiDetails.interfaces[0]?.opticalTxPower, 1.25);

    await page.command("Page.navigate", { url: `${browserUrl}/devices` });
    const deviceRowSelector = `[data-testid="row-device-${deviceId}"]`;
    await browserWaitFor(
      page,
      `Boolean(document.querySelector(${JSON.stringify(deviceRowSelector)}))`,
      "MikroTik device did not load in Devices",
    );
    await browserClick(page, deviceRowSelector);
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="panel-device-details-${deviceId}"]'))`,
      "MikroTik device details did not open",
    );

    const hiddenPonSections = await page.evaluate<{
      onuSummary: boolean;
      aggregateRxSummary: boolean;
      aggregateTxSummary: boolean;
      opticalHistory: boolean;
      ponReadings: boolean;
    }>(
      `({
        onuSummary: Boolean(document.querySelector('[data-testid="metric-onu-count"]')),
        aggregateRxSummary: Boolean(document.querySelector('[data-testid="metric-rx-power"]')),
        aggregateTxSummary: Boolean(document.querySelector('[data-testid="metric-tx-power"]')),
        opticalHistory: Boolean(document.querySelector('[data-testid="history-card-optical-power"]')),
        ponReadings: document.body.textContent?.includes("PON / ONU readings") ?? false,
      })`,
    );
    assert.deepEqual(hiddenPonSections, {
      onuSummary: false,
      aggregateRxSummary: false,
      aggregateTxSummary: false,
      opticalHistory: false,
      ponReadings: false,
    });

    const portButtonSelector = '[data-testid="button-open-port-details-1"]';
    await browserClick(page, portButtonSelector);
    const portDetailsSelector = '[data-testid="port-details-1"]';
    await browserWaitFor(
      page,
      `Boolean(document.querySelector(${JSON.stringify(portDetailsSelector)}))`,
      "clicking the MikroTik port did not open its detail row",
    );
    const portDetails = await page.evaluate<string>(
      `document.querySelector(${JSON.stringify(portDetailsSelector)})?.textContent ?? ""`,
    );
    assert.match(portDetails, /SFP details.*VendorMikroTik/s);
    assert.match(portDetails, /Optical power details.*Optical RX-12\.75 dBm/s);
    assert.match(portDetails, /Optical power details.*Optical TX1\.25 dBm/s);
  } finally {
    await page?.close();
    await stopChildProcess(browser);
    proxy && await stopServer(proxy);
    await stopChildProcess(frontend);
    apiServer && await stopServer(apiServer);
    if (deviceIds.length) {
      await db.delete(deviceInterfaceSamples).where(inArray(deviceInterfaceSamples.deviceId, deviceIds));
      await db.delete(ponTelemetrySamples).where(inArray(ponTelemetrySamples.deviceId, deviceIds));
      await db.delete(deviceInterfaces).where(inArray(deviceInterfaces.deviceId, deviceIds));
      await db.delete(ponTelemetry).where(inArray(ponTelemetry.deviceId, deviceIds));
      await db.delete(monitoredDevices).where(inArray(monitoredDevices.id, deviceIds));
    }
    if (companyIds.length) {
      await db.delete(checkoutSessions).where(inArray(checkoutSessions.companyId, companyIds));
      await db.delete(licenses).where(inArray(licenses.companyId, companyIds));
      await db.delete(auditLogs).where(inArray(auditLogs.companyId, companyIds));
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
  }
});

test("super-admin overview totals follow live platform changes and stay role-protected", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for admin overview tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for admin overview tests");
  assert.ok(process.env.SUPERADMIN_PASSWORD, "SUPERADMIN_PASSWORD is required for admin overview tests");

  const companyIds: string[] = [];
  const deviceIds: string[] = [];
  let adminOverviewContactEmail = "";
  let apiServer: Server | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: Server | undefined;
  let browser: ChildProcess | undefined;
  let page: CdpPage | undefined;

  try {
    await ensurePortalData();
    apiServer = await startServer();

    const adminCookie = await login(
      process.env.SUPERADMIN_USERNAME ?? "superadmin-admin",
      process.env.SUPERADMIN_PASSWORD,
    );
    const unauthenticated = await request("/api/admin/dashboard");
    assert.equal(unauthenticated.status, 401);

    const before = await request("/api/admin/dashboard", { headers: { cookie: adminCookie } });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual(Object.keys(before.body).sort(), [
      "pendingContactInquiries",
      "pendingSupportTickets",
      "totalBilling",
      "totalCompanies",
      "totalDevices",
    ]);

    const tenant = await registerTenant("admin-overview");
    companyIds.push(tenant.companyId);
    const tenantCookie = await login(tenant.email, tenant.password);
    const operatorValue = suffix("admin-overview-operator");
    const operatorResponse = await request("/api/company/users", {
      method: "POST",
      headers: { cookie: tenantCookie },
      body: {
        username: `${operatorValue}-operator`,
        email: `${operatorValue}@example.test`,
        password: `${operatorValue}-Password!`,
        role: "operator",
      },
    });
    assert.equal(operatorResponse.status, 201, JSON.stringify(operatorResponse.body));
    const operatorCookie = await login(`${operatorValue}@example.test`, `${operatorValue}-Password!`);

    const checkout = await createCheckoutSession({
      companyId: tenant.companyId,
      planId: "growth",
      amount: 7499,
      currency: "INR",
    });
    await db
      .update(checkoutSessions)
      .set({ status: "paid", updatedAt: new Date() })
      .where(eq(checkoutSessions.id, checkout.id));

    const deviceId = await upsertDevice({
      id: `admin-overview-${suffix("device")}`,
      companyId: tenant.companyId,
      name: "Admin overview router",
      ipAddress: `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
      vendor: "Cisco",
      type: "Router",
      location: "Overview test lab",
      credentialId: null,
    });
    deviceIds.push(deviceId);

    const ticketResponse = await request("/api/support/tickets", {
      method: "POST",
      headers: { cookie: tenantCookie },
      body: {
        subject: "Admin overview regression ticket",
        priority: "high",
        message: "This ticket verifies the platform pending count.",
      },
    });
    assert.equal(ticketResponse.status, 201, JSON.stringify(ticketResponse.body));

    adminOverviewContactEmail = `${suffix("admin-overview-contact")}@example.test`;
    const contactResponse = await request("/api/contact", {
      method: "POST",
      headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
      body: {
        name: "Admin overview visitor",
        email: adminOverviewContactEmail,
        company: "Overview test company",
        message: "This inquiry verifies the pending contact count.",
      },
    });
    assert.equal(contactResponse.status, 201, JSON.stringify(contactResponse.body));

    const after = await request("/api/admin/dashboard", { headers: { cookie: adminCookie } });
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.equal(after.body.totalCompanies, before.body.totalCompanies + 1);
    assert.equal(after.body.totalBilling, before.body.totalBilling + 7499);
    assert.equal(after.body.totalDevices, before.body.totalDevices + 1);
    assert.equal(after.body.pendingSupportTickets, before.body.pendingSupportTickets + 1);
    assert.equal(after.body.pendingContactInquiries, before.body.pendingContactInquiries + 1);

    const [pendingContact] = await db
      .select({ id: contactSubmissions.id })
      .from(contactSubmissions)
      .where(eq(contactSubmissions.email, adminOverviewContactEmail));
    assert.ok(pendingContact, "pending contact inquiry should be persisted");
    const handledContact = await request(`/api/admin/contact-submissions/${pendingContact.id}`, {
      method: "PATCH",
      headers: { cookie: adminCookie },
      body: { handled: true },
    });
    assert.equal(handledContact.status, 200, JSON.stringify(handledContact.body));
    const afterHandling = await request("/api/admin/dashboard", { headers: { cookie: adminCookie } });
    assert.equal(afterHandling.status, 200, JSON.stringify(afterHandling.body));
    assert.equal(afterHandling.body.pendingContactInquiries, before.body.pendingContactInquiries);

    for (const [role, cookie] of [
      ["company admin", tenantCookie],
      ["operator", operatorCookie],
    ] as const) {
      const denied = await request("/api/admin/dashboard", { headers: { cookie } });
      assert.equal(denied.status, 403, `${role} must not read the platform overview`);
    }

    const frontendPort = await unusedPort();
    frontend = startHydraFrontend(frontendPort);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`);
    proxy = await startBrowserProxy(frontendPort);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");

    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;
    await page.command("Page.navigate", { url: `http://127.0.0.1:${proxyAddress.port}/login` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="input-login-password"]'))`,
      "super-admin login page did not load",
    );
    const browserSession = await page.evaluate<{ ok: boolean; role?: string }>(
      `fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          identifier: ${JSON.stringify(process.env.SUPERADMIN_USERNAME ?? "superadmin-admin")},
          password: ${JSON.stringify(process.env.SUPERADMIN_PASSWORD)},
        }),
      }).then(async (response) => {
        const session = await response.json();
        if (!response.ok) return { ok: false };
        localStorage.setItem("hydranms-token", session.token);
        localStorage.setItem("hydranms-role", session.user.role);
        localStorage.setItem("hydranms-username", session.user.username);
        localStorage.setItem("hydranms-email", session.user.email);
        return { ok: true, role: session.user.role };
      })`,
    );
    assert.deepEqual(browserSession, { ok: true, role: "super_admin" });
    await page.command("Page.navigate", { url: `http://127.0.0.1:${proxyAddress.port}/` });
    await browserWaitFor(
      page,
      `location.pathname === "/" && Boolean(document.querySelector('[data-testid="metric-total-companies"]'))`,
      "super-admin Overview did not load",
    );

    const metrics = await page.evaluate<Record<string, string>>(`({
      companies: document.querySelector('[data-testid="metric-total-companies"]')?.textContent?.trim() ?? "",
      billing: document.querySelector('[data-testid="metric-total-billing"]')?.textContent?.trim() ?? "",
      devices: document.querySelector('[data-testid="metric-total-devices"]')?.textContent?.trim() ?? "",
      tickets: document.querySelector('[data-testid="metric-pending-support-tickets"]')?.textContent?.trim() ?? "",
      contacts: document.querySelector('[data-testid="metric-pending-contact-inquiries"]')?.textContent?.trim() ?? "",
    })`);
    assert.equal(metrics.companies, String(after.body.totalCompanies));
    assert.equal(metrics.billing, `₹${Number(after.body.totalBilling).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`);
    assert.equal(metrics.devices, String(after.body.totalDevices));
    assert.equal(metrics.tickets, String(after.body.pendingSupportTickets));
    assert.equal(metrics.contacts, String(afterHandling.body.pendingContactInquiries));

    for (const [role, identifier, password] of [
      ["company admin", tenant.email, tenant.password],
      ["operator", `${operatorValue}@example.test`, `${operatorValue}-Password!`],
    ] as const) {
      const tenantBrowserSession: { ok: boolean; role?: string } = await page.evaluate<{
        ok: boolean;
        role?: string;
      }>(
        `fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            identifier: ${JSON.stringify(identifier)},
            password: ${JSON.stringify(password)},
          }),
        }).then(async (response) => {
          const session = await response.json();
          if (!response.ok) return { ok: false };
          localStorage.setItem("hydranms-token", session.token);
          localStorage.setItem("hydranms-role", session.user.role);
          localStorage.setItem("hydranms-username", session.user.username);
          localStorage.setItem("hydranms-email", session.user.email);
          return { ok: true, role: session.user.role };
        })`,
      );
      assert.deepEqual(
        tenantBrowserSession,
        { ok: true, role: role === "operator" ? "operator" : "company_admin" },
        `${role} browser login failed`,
      );
      await page.command("Page.navigate", { url: `http://127.0.0.1:${proxyAddress.port}/` });
      await browserWaitFor(
        page,
        `location.pathname === "/" && Boolean(document.querySelector('[data-testid="metric-total-devices"]')) && !document.querySelector('[data-testid="metric-total-companies"]')`,
        `${role} must not see the super-admin Overview cards`,
      );
    }
  } finally {
    await page?.close();
    await stopChildProcess(browser);
    proxy && await stopServer(proxy);
    await stopChildProcess(frontend);
    apiServer && await stopServer(apiServer);
    if (deviceIds.length) {
      await db.delete(deviceInterfaceSamples).where(inArray(deviceInterfaceSamples.deviceId, deviceIds));
      await db.delete(ponTelemetrySamples).where(inArray(ponTelemetrySamples.deviceId, deviceIds));
      await db.delete(deviceInterfaces).where(inArray(deviceInterfaces.deviceId, deviceIds));
      await db.delete(ponTelemetry).where(inArray(ponTelemetry.deviceId, deviceIds));
      await db.delete(monitoredDevices).where(inArray(monitoredDevices.id, deviceIds));
    }
    if (companyIds.length) {
      await db.delete(supportTickets).where(inArray(supportTickets.companyId, companyIds));
      await db.delete(checkoutSessions).where(inArray(checkoutSessions.companyId, companyIds));
      await db.delete(licenses).where(inArray(licenses.companyId, companyIds));
      await db.delete(auditLogs).where(inArray(auditLogs.companyId, companyIds));
      await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
      await db.delete(companies).where(inArray(companies.id, companyIds));
    }
    if (adminOverviewContactEmail) {
      await db.delete(contactSubmissions).where(eq(contactSubmissions.email, adminOverviewContactEmail));
    }
  }
});

test("public contact page shows loading, success, and failure states", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for contact browser tests");

  const contactEmails: string[] = [];
  let apiServer: Server | undefined;
  let frontend: ChildProcess | undefined;
  let proxy: Server | undefined;
  let browser: ChildProcess | undefined;
  let page: CdpPage | undefined;

  try {
    await ensurePortalData();
    apiServer = await startServer();

    const frontendPort = await unusedPort();
    frontend = startHydraFrontend(frontendPort);
    await waitForHttp(`http://127.0.0.1:${frontendPort}/`);
    proxy = await startBrowserProxy(frontendPort);
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");
    const browserUrl = `http://127.0.0.1:${proxyAddress.port}`;

    const launched = await launchBrowser();
    browser = launched.browser;
    page = launched.page;
    await page.command("Page.navigate", { url: `${browserUrl}/contact` });
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="input-contact-name"]'))`,
      "contact page form did not load",
    );

    const firstEmail = `${suffix("contact-browser")}@example.test`;
    contactEmails.push(firstEmail);
    await page.evaluate<void>(
      `(() => {
        const originalFetch = window.fetch.bind(window);
        window.__contactTestMode = "hold";
        window.__releaseContactTestFetch = undefined;
        window.fetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.includes("/api/contact") && window.__contactTestMode === "hold") {
            return new Promise((resolve) => {
              window.__releaseContactTestFetch = () => {
                window.__contactTestMode = "normal";
                resolve(originalFetch(input, init));
              };
            });
          }
          if (url.includes("/api/contact") && window.__contactTestMode === "fail") {
            window.__contactTestMode = "normal";
            return Promise.resolve(new Response(JSON.stringify({ error: "simulated failure" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            }));
          }
          return originalFetch(input, init);
        };
      })()`,
    );
    await browserFill(page, '[data-testid="input-contact-name"]', "Browser Visitor");
    await browserFill(page, '[data-testid="input-contact-email"]', firstEmail);
    await browserFill(page, '[data-testid="input-contact-company"]', "Browser Fiber");
    await browserFill(page, '[data-testid="textarea-contact-message"]', "We need a better view of our access network.");
    await browserClick(page, '[data-testid="button-contact-submit"]');
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="button-contact-submit"]')?.disabled) && document.querySelector('[data-testid="button-contact-submit"]')?.textContent?.includes("Sending")`,
      "contact submission did not show its loading state",
    );
    await page.evaluate<void>(
      `window.__releaseContactTestFetch?.()`,
    );
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="status-contact-success"]'))`,
      "successful contact submission was not shown",
    );

    const storedBrowserContact = await db
      .select()
      .from(contactSubmissions)
      .where(eq(contactSubmissions.email, firstEmail))
      .limit(1);
    assert.equal(storedBrowserContact.length, 1, "browser contact submission must be persisted");

    await browserClick(page, '[data-testid="button-contact-send-another"]');
    const automatedEmail = `${suffix("contact-browser-automated")}@example.test`;
    contactEmails.push(automatedEmail);
    await browserFill(page, '[data-testid="input-contact-name"]', "Browser Automated Visitor");
    await browserFill(page, '[data-testid="input-contact-email"]', automatedEmail);
    await browserFill(page, '[data-testid="textarea-contact-message"]', "This automated pattern must be blocked.");
    await browserFill(page, '[data-testid="input-contact-website"]', "https://spam.example");
    await browserClick(page, '[data-testid="button-contact-submit"]');
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="status-contact-error"]')) && document.querySelector('[data-testid="status-contact-error"]')?.textContent?.includes("try again")`,
      "automated contact submission did not show a clear retry message",
    );
    assert.equal(
      (await db.select().from(contactSubmissions).where(eq(contactSubmissions.email, automatedEmail))).length,
      0,
      "blocked browser contact submission must not be persisted",
    );

    const secondEmail = `${suffix("contact-browser-failure")}@example.test`;
    contactEmails.push(secondEmail);
    await page.evaluate<void>(
      `window.__contactTestMode = "fail"`,
    );
    await browserFill(page, '[data-testid="input-contact-name"]', "Browser Failure Visitor");
    await browserFill(page, '[data-testid="input-contact-email"]', secondEmail);
    await browserFill(page, '[data-testid="textarea-contact-message"]', "This request should show a recoverable error.");
    await browserClick(page, '[data-testid="button-contact-submit"]');
    await browserWaitFor(
      page,
      `Boolean(document.querySelector('[data-testid="status-contact-error"]')) && Boolean(document.querySelector('[data-testid="input-contact-name"]'))`,
      "failed contact submission did not show the error state",
    );
    assert.equal(
      (await db.select().from(contactSubmissions).where(eq(contactSubmissions.email, secondEmail))).length,
      0,
      "a failed contact request must not appear as persisted",
    );
  } finally {
    await page?.close();
    await stopChildProcess(browser);
    proxy && await stopServer(proxy);
    await stopChildProcess(frontend);
    apiServer && await stopServer(apiServer);
    if (contactEmails.length) {
      await db.delete(contactSubmissions).where(inArray(contactSubmissions.email, contactEmails));
    }
  }
});

test.after(async () => {
  await pool.end();
});