import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Server } from "node:http";
import app from "./app";
import { db, pool } from "@workspace/db";
import {
  alertSettings,
  auditLogs,
  authSessions,
  companies,
  contactSubmissions,
  incidentTickets,
  licenses,
  monitoredDevices,
  notificationDeliveries,
  portalUsers,
  snmpCredentials,
  supportTickets,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { GetDeviceDetailsResponse } from "@workspace/api-zod";
import { credentialById, recordPoll, upsertDevice } from "./lib/nms-store";
import type { PollResult } from "./lib/snmp-poller";
import { encryptSecret } from "./lib/snmp-crypto";
import {
  CONTACT_SUBMISSION_RETENTION_DAYS,
  ensurePortalData,
  ticketTelegramBotTokenForCompany,
  telegramBotTokenForCompany,
  updateAlertSettings,
} from "./lib/portal-store";

const require = createRequire(import.meta.url);
const snmp = require("net-snmp") as any;

type RegisteredTenant = {
  companyId: string;
  username: string;
  email: string;
  password: string;
};

type HttpResponse = {
  status: number;
  body: any;
  headers: Headers;
};

type FixtureValue = {
  value?: unknown;
  error?: string;
};

type SnmpFixture = {
  profile: string;
  get: Record<string, FixtureValue>;
  table?: Record<string, unknown>;
  walk: Record<string, Array<FixtureValue & { oid: string }> | { error: string }>;
};

let baseUrl = "";

async function loadSnmpFixture(name: string): Promise<SnmpFixture> {
  return JSON.parse(
    await readFile(new URL(`../test/fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as SnmpFixture;
}

function fixtureVarbind(oid: string, fixtureValue: FixtureValue) {
  if (fixtureValue.error) {
    const errorTypes: Record<string, number> = {
      NoSuchObject: snmp.ObjectType.NoSuchObject,
      NoSuchInstance: snmp.ObjectType.NoSuchInstance,
      EndOfMibView: snmp.ObjectType.EndOfMibView,
    };
    return { oid, type: errorTypes[fixtureValue.error] ?? snmp.ObjectType.NoSuchInstance };
  }
  return { oid, type: snmp.ObjectType.OctetString, value: fixtureValue.value };
}

function fixtureSession(fixture: SnmpFixture) {
  return {
    get(oids: string[], callback: (error: Error | null, values: unknown[]) => void) {
      callback(
        null,
        oids.map((oid) => fixtureVarbind(oid, fixture.get[oid] ?? { error: "NoSuchInstance" })),
      );
    },
    tableColumns(
      _oid: string,
      _columns: number[],
      callback: (error: Error | null, table: Record<string, unknown>) => void,
    ) {
      callback(null, fixture.table ?? {});
    },
    walk(
      oid: string,
      _maxRepetitions: number,
      onVarbind: (values: unknown[]) => void,
      done: (error: Error | null) => void,
    ) {
      const response = fixture.walk[oid];
      if (!response) {
        done(null);
        return;
      }
      if (!Array.isArray(response)) {
        done(new Error(response.error));
        return;
      }
      for (const item of response) onVarbind([fixtureVarbind(item.oid, item)]);
      done(null);
    },
    close() {},
  };
}

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

async function request(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {},
): Promise<HttpResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
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
  assert.ok(setCookie, "login should set a session cookie");
  return setCookie.split(";")[0];
}

function registration(prefix: string): RegisteredTenant & Record<string, unknown> {
  const suffix = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    companyId: "",
    username: `${suffix}-admin`,
    email: `${suffix}@example.test`,
    password: `${suffix}-Password!`,
    subdomain: suffix,
    companyName: `${prefix} Security Test Company`,
    contactNumber: "9876543210",
    address: "Security test address",
  };
}

async function login(
  identifier: string,
  password: string,
  expectedUsername = identifier,
): Promise<{ token: string; cookie: string; userId: string }> {
  const response = await request("/api/auth/login", {
    method: "POST",
    body: { identifier, password },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.username, expectedUsername);
  assert.equal(typeof response.body.token, "string");
  return { token: response.body.token, cookie: sessionCookie(response), userId: response.body.user.id };
}

async function waitForDevicePoll(cookie: string, deviceId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  let lastDevice: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const response = await request("/api/devices", { headers: { cookie } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    lastDevice = response.body.find((device: Record<string, unknown>) => device.id === deviceId);
    if (lastDevice?.lastPollAt) return lastDevice;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`device ${deviceId} did not record a poll: ${JSON.stringify(lastDevice)}`);
}

async function waitForNotificationRows(companyId: string, minimum: number) {
  const deadline = Date.now() + 2_000;
  let rows = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.companyId, companyId));
  while (rows.length < minimum && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    rows = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.companyId, companyId));
  }
  assert.ok(
    rows.length >= minimum,
    `expected at least ${minimum} notification deliveries, found ${rows.length}`,
  );
  return rows;
}

function pollResult(operStatus: string, withSfp = false): PollResult {
  return {
    sysName: "tenant-a-router",
    sysUpTimeSeconds: 42,
    systemVersion: "test",
    ramPercent: 20,
    diskPercent: 30,
    interfaces: [
      {
        ifIndex: 7,
        name: "ether7",
        alias: "Uplink",
        adminStatus: "1",
        operStatus,
        speedMbps: 1000,
        rxBytes: "100",
        txBytes: "200",
        sfpVendor: withSfp ? "MikroTik" : null,
        sfpSerialNumber: withSfp ? "SFP-TEST-001" : null,
        opticalRxPower: withSfp ? -12.75 : null,
        opticalTxPower: withSfp ? 1.25 : null,
      },
    ],
    ponCount: null,
    onuCount: null,
    rxPower: null,
    txPower: null,
    ponTelemetry: [],
  };
}

const failedPollResult: PollResult = {
  sysName: null,
  sysUpTimeSeconds: null,
  systemVersion: null,
  ramPercent: null,
  diskPercent: null,
  interfaces: [],
  ponCount: null,
  onuCount: null,
  rxPower: null,
  txPower: null,
  ponTelemetry: [],
};

async function cleanup(companyIds: string[]): Promise<void> {
  if (companyIds.length === 0) return;
  await db.delete(snmpCredentials).where(inArray(snmpCredentials.companyId, companyIds));
  await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.companyId, companyIds));
  await db.delete(incidentTickets).where(inArray(incidentTickets.companyId, companyIds));
  await db.delete(monitoredDevices).where(inArray(monitoredDevices.companyId, companyIds));
  await db.delete(supportTickets).where(inArray(supportTickets.companyId, companyIds));
  await db.delete(alertSettings).where(inArray(alertSettings.companyId, companyIds));
  await db.delete(auditLogs).where(inArray(auditLogs.companyId, companyIds));
  await db.delete(authSessions).where(inArray(authSessions.companyId, companyIds));
  await db.delete(licenses).where(inArray(licenses.companyId, companyIds));
  await db.delete(portalUsers).where(inArray(portalUsers.companyId, companyIds));
  await db.delete(companies).where(inArray(companies.id, companyIds));
}

test("enforces authentication and tenant ownership across portal resources", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for API security tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for API security tests");
  const superAdminPassword = process.env.SUPERADMIN_PASSWORD;
  assert.ok(superAdminPassword, "SUPERADMIN_PASSWORD is required for API security tests");

  await ensurePortalData();
  const companyIds: string[] = [];
  let server = await startServer();

  try {
    const tenantA = registration("tenant-a");
    const tenantB = registration("tenant-b");
    const registeredA = await request("/api/auth/register", {
      method: "POST",
      body: tenantA,
    });
    const registeredB = await request("/api/auth/register", {
      method: "POST",
      body: tenantB,
    });

    assert.equal(registeredA.status, 201, JSON.stringify(registeredA.body));
    assert.equal(registeredB.status, 201, JSON.stringify(registeredB.body));
    assert.equal(registeredA.body.user.role, "company_admin");
    assert.equal(registeredA.body.nextStep, "payment");
    tenantA.companyId = registeredA.body.company.id;
    tenantB.companyId = registeredB.body.company.id;
    companyIds.push(tenantA.companyId, tenantB.companyId);
    assert.notEqual(tenantA.companyId, tenantB.companyId);

    const invalidLogin = await request("/api/auth/login", {
      method: "POST",
      body: { identifier: tenantA.email, password: "not-the-password" },
    });
    assert.equal(invalidLogin.status, 401);

    const authA = await login(tenantA.email, tenantA.password, tenantA.username);
    const authB = await login(tenantB.username, tenantB.password);
    const adminIdentifier = process.env.SUPERADMIN_USERNAME ?? "superadmin-admin";
    const adminAuth = await login(adminIdentifier, superAdminPassword);

    for (const path of ["/api/devices", "/api/billing/license", "/api/support/tickets", "/api/companies", "/api/company/profile", "/api/company/users"]) {
      assert.equal((await request(path)).status, 401, `${path} must reject unauthenticated requests`);
    }

    assert.equal(
      (await request("/api/devices", { headers: { cookie: authA.cookie } })).status,
      200,
      "cookie sessions should authorize tenant requests",
    );
    assert.equal(
      (await request("/api/devices", { headers: { authorization: `Bearer ${authB.token}` } })).status,
      200,
      "bearer sessions should authorize tenant requests",
    );

    const profileA = await request("/api/company/profile", { headers: { cookie: authA.cookie } });
    assert.equal(profileA.status, 200, JSON.stringify(profileA.body));
    assert.equal(profileA.body.id, tenantA.companyId);
    const updatedProfileA = await request("/api/company/profile", {
      method: "PATCH",
      headers: { cookie: authA.cookie },
      body: {
        name: "Tenant A Updated Profile",
        subdomain: "tenant-a-should-not-change",
        email: tenantA.email,
        contactNumber: tenantA.contactNumber,
        address: tenantA.address,
      },
    });
    assert.equal(updatedProfileA.status, 200, JSON.stringify(updatedProfileA.body));
    assert.equal(updatedProfileA.body.name, "Tenant A Updated Profile");
    assert.equal(updatedProfileA.body.subdomain, profileA.body.subdomain);
    const profileB = await request("/api/company/profile", { headers: { authorization: `Bearer ${authB.token}` } });
    assert.equal(profileB.status, 200, JSON.stringify(profileB.body));
    assert.equal(profileB.body.id, tenantB.companyId);
    assert.notEqual(profileB.body.name, "Tenant A Updated Profile");

    const profilePicturePath = `/objects/uploads/security-profile-${Date.now()}`;
    const profilePictureUpdate = await request("/api/auth/profile", {
      method: "PATCH",
      headers: { cookie: authA.cookie },
      body: { name: "Tenant A Profile Picture", avatarPath: profilePicturePath },
    });
    assert.equal(profilePictureUpdate.status, 200, JSON.stringify(profilePictureUpdate.body));
    const ownerRead = await request(`/api/storage/objects/${profilePicturePath.replace(/^\/objects\//, "")}`, {
      headers: { cookie: authA.cookie },
    });
    assert.notEqual(ownerRead.status, 403, "the profile picture owner must pass object authorization");
    const otherCompanyRead = await request(
      `/api/storage/objects/${profilePicturePath.replace(/^\/objects\//, "")}`,
      { headers: { cookie: authB.cookie } },
    );
    assert.equal(otherCompanyRead.status, 403, "a user from another company must not read the profile picture");

    const companyUsers = await request("/api/company/users", { headers: { cookie: authA.cookie } });
    assert.equal(companyUsers.status, 200, JSON.stringify(companyUsers.body));
    assert.equal(companyUsers.body.length, 1);
    assert.equal(companyUsers.body[0].id, registeredA.body.user.id);
    assert.equal(companyUsers.body[0].role, "company_admin");
    const createdOperator = await request("/api/company/users", {
      method: "POST",
      headers: { cookie: authA.cookie },
      body: {
        username: `${tenantA.subdomain}-operator`,
        email: `${tenantA.subdomain}-operator@example.test`,
        password: `${tenantA.subdomain}-operator-Password!`,
        role: "operator",
      },
    });
    assert.equal(createdOperator.status, 201, JSON.stringify(createdOperator.body));
    assert.equal(createdOperator.body.role, "operator");
    const operatorAuth = await login(
      `${tenantA.subdomain}-operator`,
      `${tenantA.subdomain}-operator-Password!`,
    );
    await updateAlertSettings(tenantA.companyId, {
      emailEnabled: false,
      emailAddress: null,
      telegramEnabled: true,
      telegramChatId: "normal-alert-chat",
      telegramBotTokenEncrypted: encryptSecret("normal-alert-token"),
      ticketTelegramEnabled: true,
      ticketTelegramChatId: "ticket-alert-chat",
      ticketTelegramBotTokenEncrypted: encryptSecret("ticket-alert-token"),
      rxPowerLowThreshold: null,
      rxPowerHighThreshold: null,
      txPowerLowThreshold: null,
      txPowerHighThreshold: null,
    });
    assert.notEqual(
      await telegramBotTokenForCompany(tenantA.companyId),
      await ticketTelegramBotTokenForCompany(tenantA.companyId),
      "ticket alerts must use a separate Telegram bot token",
    );

    const adminTicket = await request("/api/tickets", {
      method: "POST",
      headers: { cookie: authA.cookie },
      body: {
        title: "Admin-created incident",
        description: "Created by the company administrator",
        priority: "high",
      },
    });
    assert.equal(adminTicket.status, 201, JSON.stringify(adminTicket.body));
    const operatorTicketList = await request("/api/tickets", {
      headers: { authorization: `Bearer ${operatorAuth.token}` },
    });
    assert.equal(operatorTicketList.status, 200, JSON.stringify(operatorTicketList.body));
    assert.equal(operatorTicketList.body.length, 1);
    assert.equal(operatorTicketList.body[0].id, adminTicket.body.id);
    assert.deepEqual(
      (await request("/api/tickets", { headers: { authorization: `Bearer ${authB.token}` } })).body,
      [],
      "a company can only list its own incident tickets",
    );
    assert.equal(
      (
        await request(`/api/tickets/${adminTicket.body.id}/resolve`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${authB.token}` },
        })
      ).status,
      404,
      "a company cannot resolve another company's incident ticket",
    );

    const operatorTicket = await request("/api/tickets", {
      method: "POST",
      headers: { authorization: `Bearer ${operatorAuth.token}` },
      body: {
        title: "Operator-created incident",
        description: "Created by the network operator",
        priority: "medium",
      },
    });
    assert.equal(operatorTicket.status, 201, JSON.stringify(operatorTicket.body));
    const adminTicketList = await request("/api/tickets", { headers: { cookie: authA.cookie } });
    assert.equal(adminTicketList.status, 200, JSON.stringify(adminTicketList.body));
    assert.equal(adminTicketList.body.length, 2);
    assert.equal(
      (
        await request(`/api/tickets/${operatorTicket.body.id}/resolve`, {
          method: "PATCH",
          headers: { cookie: authA.cookie },
        })
      ).status,
      200,
      "company admins can resolve operator-created tickets",
    );
    assert.equal(
      (
        await request(`/api/tickets/${adminTicket.body.id}/resolve`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${operatorAuth.token}` },
        })
      ).status,
      200,
      "operators can resolve admin-created tickets",
    );
    const manualDeliveries = await waitForNotificationRows(tenantA.companyId, 4);
    assert.equal(manualDeliveries.length, 4);

    const ticketDeviceId = await upsertDevice({
      companyId: tenantA.companyId,
      name: "Ticket Workflow Router",
      ipAddress: "192.0.2.30",
      vendor: "Test Vendor",
      type: "Router",
      location: "Test Lab",
      credentialId: null,
    });
    await recordPoll(ticketDeviceId, pollResult("1"), true);
    await recordPoll(ticketDeviceId, failedPollResult, false);
    await recordPoll(ticketDeviceId, failedPollResult, false);
    await recordPoll(ticketDeviceId, failedPollResult, false);
    let deliveries = await waitForNotificationRows(tenantA.companyId, 6);
    let deviceTickets = await db
      .select()
      .from(incidentTickets)
      .where(eq(incidentTickets.companyId, tenantA.companyId));
    let deviceTicket = deviceTickets.find((ticket) => ticket.sourceKey === `device-down:${ticketDeviceId}`);
    assert.ok(deviceTicket);
    assert.equal(deviceTicket.status, "open");
    assert.equal(deviceTicket.sourceType, "device");
    assert.equal(
      deliveries.filter((delivery) => delivery.channel === "ticket_telegram").length,
      5,
      "one device-down ticket notification should be queued",
    );

    await recordPoll(ticketDeviceId, failedPollResult, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.companyId, tenantA.companyId));
    assert.equal(deliveries.length, 6, "repeated device-down polls must not duplicate deliveries");

    await recordPoll(ticketDeviceId, pollResult("1"), true);
    deliveries = await waitForNotificationRows(tenantA.companyId, 8);
    deviceTickets = await db
      .select()
      .from(incidentTickets)
      .where(eq(incidentTickets.companyId, tenantA.companyId));
    deviceTicket = deviceTickets.find((ticket) => ticket.sourceKey === `device-down:${ticketDeviceId}`);
    assert.ok(deviceTicket);
    assert.equal(deviceTicket.status, "resolved");
    assert.equal(deviceTicket.autoResolved, true);
    const originalDeviceTicketId = deviceTicket.id;

    await recordPoll(ticketDeviceId, pollResult("1"), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.companyId, tenantA.companyId));
    assert.equal(deliveries.length, 8, "repeated device-up polls must not duplicate deliveries");

    await recordPoll(ticketDeviceId, failedPollResult, false);
    await recordPoll(ticketDeviceId, failedPollResult, false);
    await recordPoll(ticketDeviceId, failedPollResult, false);
    deliveries = await waitForNotificationRows(tenantA.companyId, 9);
    deviceTickets = await db
      .select()
      .from(incidentTickets)
      .where(eq(incidentTickets.companyId, tenantA.companyId));
    deviceTicket = deviceTickets.find((ticket) => ticket.sourceKey === `device-down:${ticketDeviceId}`);
    assert.ok(deviceTicket);
    assert.equal(deviceTicket.id, originalDeviceTicketId, "device incidents should reopen the original ticket");
    assert.equal(deviceTicket.status, "open");
    assert.equal(
      deviceTickets.filter((ticket) => ticket.sourceKey === `device-down:${ticketDeviceId}`).length,
      1,
      "reopening a device incident must not create a second ticket",
    );

    await recordPoll(ticketDeviceId, pollResult("1"), true);
    await waitForNotificationRows(tenantA.companyId, 10);
    await recordPoll(ticketDeviceId, pollResult("1"), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.companyId, tenantA.companyId));
    assert.equal(deliveries.length, 10, "repeated device recovery polls must not duplicate deliveries");

    await recordPoll(ticketDeviceId, pollResult("2"), true);
    deliveries = await waitForNotificationRows(tenantA.companyId, 12);
    let portTickets = await db
      .select()
      .from(incidentTickets)
      .where(eq(incidentTickets.companyId, tenantA.companyId));
    let portTicket = portTickets.find((ticket) => ticket.sourceKey === `port-down:${ticketDeviceId}:7`);
    assert.ok(portTicket);
    assert.equal(portTicket.status, "open");
    assert.equal(portTicket.sourceType, "port");
    assert.equal(portTicket.ifIndex, 7);

    await recordPoll(ticketDeviceId, pollResult("2"), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.companyId, tenantA.companyId));
    assert.equal(deliveries.length, 12, "repeated port-down polls must not duplicate deliveries");

    await recordPoll(ticketDeviceId, pollResult("1"), true);
    await waitForNotificationRows(tenantA.companyId, 14);
    portTickets = await db
      .select()
      .from(incidentTickets)
      .where(eq(incidentTickets.companyId, tenantA.companyId));
    portTicket = portTickets.find((ticket) => ticket.sourceKey === `port-down:${ticketDeviceId}:7`);
    assert.ok(portTicket);
    assert.equal(portTicket.status, "resolved");
    assert.equal(portTicket.autoResolved, true);

    await recordPoll(ticketDeviceId, pollResult("1"), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.companyId, tenantA.companyId));
    assert.equal(deliveries.length, 14, "repeated port recovery polls must not duplicate deliveries");
    const ticketTelegramDeliveries = deliveries.filter((delivery) => delivery.channel === "ticket_telegram");
    const normalTelegramDeliveries = deliveries.filter((delivery) => delivery.channel === "telegram");
    assert.equal(ticketTelegramDeliveries.length, 8);
    assert.equal(normalTelegramDeliveries.length, 6);
    assert.ok(ticketTelegramDeliveries.every((delivery) => delivery.recipient === "ticket-alert-chat"));
    assert.ok(normalTelegramDeliveries.every((delivery) => delivery.recipient === "normal-alert-chat"));
    assert.equal(
      ticketTelegramDeliveries.some((delivery) => delivery.recipient === "normal-alert-chat"),
      false,
      "ticket delivery rows must never use the normal alert chat",
    );

    await recordPoll(ticketDeviceId, pollResult("1", true), true);
    await recordPoll(ticketDeviceId, pollResult("1"), true);
    deliveries = await waitForNotificationRows(tenantA.companyId, 16);
    portTickets = await db
      .select()
      .from(incidentTickets)
      .where(eq(incidentTickets.companyId, tenantA.companyId));
    let sfpTicket = portTickets.find((ticket) => ticket.sourceKey.startsWith(`sfp-removed:${ticketDeviceId}:7:`));
    assert.ok(sfpTicket);
    assert.equal(sfpTicket.status, "open");
    assert.equal(sfpTicket.sourceType, "port");
    assert.equal(sfpTicket.ifIndex, 7);

    await recordPoll(ticketDeviceId, pollResult("1"), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.companyId, tenantA.companyId));
    assert.equal(deliveries.length, 16, "repeated SFP removal polls must not duplicate deliveries");

    await recordPoll(ticketDeviceId, pollResult("1", true), true);
    deliveries = await waitForNotificationRows(tenantA.companyId, 17);
    portTickets = await db
      .select()
      .from(incidentTickets)
      .where(eq(incidentTickets.companyId, tenantA.companyId));
    sfpTicket = portTickets.find((ticket) => ticket.sourceKey.startsWith(`sfp-removed:${ticketDeviceId}:7:`));
    assert.ok(sfpTicket);
    assert.equal(sfpTicket.status, "resolved");
    assert.equal(sfpTicket.autoResolved, true);

    await recordPoll(ticketDeviceId, pollResult("1", true), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    deliveries = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.companyId, tenantA.companyId));
    assert.equal(deliveries.length, 17, "repeated SFP insertion polls must not duplicate deliveries");

    assert.equal(
      (await request("/api/company/users", { headers: { authorization: `Bearer ${operatorAuth.token}` } })).status,
      403,
      "operators cannot manage company users",
    );
    assert.equal(
      (
        await request("/api/company/users", {
          headers: { authorization: `Bearer ${authB.token}`, "x-company-id": tenantA.companyId },
        })
      ).status,
      403,
      "a tenant cannot inspect another company's users",
    );
    const promotedOperator = await request(`/api/company/users/${createdOperator.body.id}`, {
      method: "PATCH",
      headers: { cookie: authA.cookie },
      body: { role: "company_admin" },
    });
    assert.equal(promotedOperator.status, 200, JSON.stringify(promotedOperator.body));
    assert.equal(promotedOperator.body.role, "company_admin");
    const deactivatedOperator = await request(`/api/company/users/${createdOperator.body.id}`, {
      method: "PATCH",
      headers: { cookie: authA.cookie },
      body: { status: "inactive" },
    });
    assert.equal(deactivatedOperator.status, 200, JSON.stringify(deactivatedOperator.body));
    assert.equal(deactivatedOperator.body.status, "inactive");
    assert.equal(
      (await request("/api/devices", { headers: { authorization: `Bearer ${operatorAuth.token}` } })).status,
      401,
      "deactivated users cannot continue using an existing session",
    );

    // Restarting the HTTP server must not invalidate the database-backed sessions.
    await stopServer(server);
    server = await startServer();
    assert.equal((await request("/api/devices", { headers: { cookie: authA.cookie } })).status, 200);
    assert.equal(
      (await request("/api/devices", { headers: { authorization: `Bearer ${authB.token}` } })).status,
      200,
    );

    const deviceId = await upsertDevice({
      companyId: tenantA.companyId,
      name: "Tenant A Router",
      ipAddress: "192.0.2.10",
      vendor: "Test Vendor",
      type: "Router",
      location: "Test Lab",
      credentialId: null,
    });
    assert.equal((await request("/api/devices", { headers: { cookie: authA.cookie } })).body.some((item: any) => item.id === deviceId), true);
    assert.equal(
      (await request(`/api/devices/${deviceId}/details`, { headers: { authorization: `Bearer ${authB.token}` } })).status,
      404,
      "a tenant cannot read another tenant's device details",
    );
    assert.equal(
      (
        await request("/api/devices", {
          method: "POST",
          headers: { authorization: `Bearer ${authB.token}`, "x-company-id": tenantA.companyId },
          body: {
            name: "Unauthorized Device",
            ipAddress: "192.0.2.11",
            vendor: "Test Vendor",
            type: "Router",
            location: "Test Lab",
            snmpVersion: "v2c",
            snmpCommunity: "public",
          },
        })
      ).status,
      403,
      "a tenant cannot write another tenant's devices",
    );

    const snmpCommunity = `integration-community-${Date.now()}`;
    const previousSnmpPort = process.env.SNMP_PORT;
    const previousSnmpTimeout = process.env.SNMP_TIMEOUT_MS;
    const previousSnmpRetries = process.env.SNMP_RETRIES;
    const snmpCredentialLabel = `integration-${Date.now()}`;
    process.env.SNMP_PORT = "9";
    process.env.SNMP_TIMEOUT_MS = "25";
    process.env.SNMP_RETRIES = "0";
    try {
      const onboarded = await request("/api/devices", {
        method: "POST",
        headers: { cookie: authA.cookie },
        body: {
          name: "Tenant A Polling Router",
          ipAddress: "127.0.0.1",
          vendor: "Cisco",
          type: "Router",
          location: "Test Lab",
          snmpVersion: "v2c",
          snmpCommunity,
          snmpCredentialLabel,
        },
      });
      assert.equal(onboarded.status, 201, JSON.stringify(onboarded.body));
      assert.equal(onboarded.body.name, "Tenant A Polling Router");
      assert.equal("credentialId" in onboarded.body, false);
      assert.equal(JSON.stringify(onboarded.body).includes(snmpCommunity), false);

      const freshList = await request("/api/devices", { headers: { cookie: authA.cookie } });
      assert.equal(freshList.status, 200, JSON.stringify(freshList.body));
      const persistedDevice = freshList.body.find(
        (item: Record<string, unknown>) => item.id === onboarded.body.id,
      );
      assert.ok(persistedDevice, "fresh device list should include the newly onboarded device");
      assert.equal(persistedDevice.name, "Tenant A Polling Router");
      assert.equal("credentialId" in persistedDevice, false);
      assert.equal(JSON.stringify(persistedDevice).includes(snmpCommunity), false);

      const credentialRows = await db
        .select({
          id: snmpCredentials.id,
          encryptedPayload: snmpCredentials.encryptedPayload,
          label: snmpCredentials.label,
        })
        .from(snmpCredentials)
        .where(eq(snmpCredentials.companyId, tenantA.companyId));
      const credentialRow = credentialRows.find((row) => row.label === snmpCredentialLabel);
      assert.ok(credentialRow, "onboarding should persist an SNMP credential");
      assert.equal(credentialRow.encryptedPayload.includes(snmpCommunity), false);
      const decryptedCredential = await credentialById(credentialRow.id);
      assert.equal(decryptedCredential.community, snmpCommunity);

      const polledDevice = await waitForDevicePoll(authA.cookie, onboarded.body.id);
      assert.ok(["warning", "offline"].includes(String(polledDevice.status)));
      assert.ok(polledDevice.lastPollAt);
      assert.equal(JSON.stringify(polledDevice).includes(snmpCommunity), false);
    } finally {
      if (previousSnmpPort === undefined) delete process.env.SNMP_PORT;
      else process.env.SNMP_PORT = previousSnmpPort;
      if (previousSnmpTimeout === undefined) delete process.env.SNMP_TIMEOUT_MS;
      else process.env.SNMP_TIMEOUT_MS = previousSnmpTimeout;
      if (previousSnmpRetries === undefined) delete process.env.SNMP_RETRIES;
      else process.env.SNMP_RETRIES = previousSnmpRetries;
    }

    const reachableFixture = await loadSnmpFixture("zte-v2c");
    const reachableCommunity = `fixture-community-${Date.now()}`;
    const reachableCredentialLabel = `reachable-fixture-${Date.now()}`;
    const originalCreateSession = snmp.createSession;
    const capturedSession: {
      value: { target: string; community: string; options: Record<string, unknown> } | null;
    } = { value: null };
    snmp.createSession = (
      target: string,
      community: string,
      options: Record<string, unknown>,
    ) => {
      capturedSession.value = { target, community, options };
      return fixtureSession(reachableFixture);
    };
    try {
      const onboarded = await request("/api/devices", {
        method: "POST",
        headers: { cookie: authA.cookie },
        body: {
          name: "Tenant A Reachable Router",
          ipAddress: "127.0.0.2",
          vendor: "ZTE",
          type: "OLT",
          location: "Test Lab",
          snmpVersion: "v2c",
          snmpCommunity: reachableCommunity,
          snmpCredentialLabel: reachableCredentialLabel,
        },
      });
      assert.equal(onboarded.status, 201, JSON.stringify(onboarded.body));
      assert.equal("credentialId" in onboarded.body, false);
      assert.equal(JSON.stringify(onboarded.body).includes(reachableCommunity), false);
      for (const field of ["snmpCommunity", "snmpUsername", "snmpAuthPassword", "snmpPrivPassword"]) {
        assert.equal(field in onboarded.body, false, `onboarding response should omit ${field}`);
      }

      const polledDevice = await waitForDevicePoll(authA.cookie, onboarded.body.id);
      assert.ok(capturedSession.value, "reachable onboarding should create an SNMP session");
      assert.equal(capturedSession.value.target, "127.0.0.2");
      assert.equal(capturedSession.value.community, reachableCommunity);
      assert.equal(capturedSession.value.options.version, snmp.Version2c);
      assert.equal(polledDevice.status, "online");
      assert.ok(polledDevice.lastPollAt, "reachable device should record a completed poll");
      assert.equal(polledDevice.interfaceCount, 1, "reachable device should persist interface telemetry");
      assert.equal(polledDevice.ponCount, 4, "reachable device should persist PON telemetry");
      assert.equal(polledDevice.onuCount, 8, "reachable device should persist ONU telemetry");
      assert.equal(polledDevice.sysUpTimeSeconds, 4321, "reachable device should persist system uptime");
      assert.equal("credentialId" in polledDevice, false);
      assert.equal(JSON.stringify(polledDevice).includes(reachableCommunity), false);
      for (const field of ["snmpCommunity", "snmpUsername", "snmpAuthPassword", "snmpPrivPassword"]) {
        assert.equal(field in polledDevice, false, `device list response should omit ${field}`);
      }

      const detailsResponse = await request(`/api/devices/${onboarded.body.id}/details`, {
        headers: { cookie: authA.cookie },
      });
      assert.equal(detailsResponse.status, 200, JSON.stringify(detailsResponse.body));
      const details = GetDeviceDetailsResponse.parse(detailsResponse.body);
      assert.equal(details.device.id, onboarded.body.id);
      assert.equal(details.interfaces.length, 1);
      assert.equal(details.interfaces[0]?.ifIndex, 1);
      assert.equal(details.interfaces[0]?.name, "xgei-0/1/1");
      assert.equal(details.interfaces[0]?.alias, "uplink");
      assert.equal(details.interfaces[0]?.speedMbps, 10000);
      assert.equal(details.interfaces[0]?.rxBytes, "444444");
      assert.equal(details.interfaces[0]?.txBytes, "555555");
      assert.equal(details.ponTelemetry.length, 2);
      assert.deepEqual(
        details.ponTelemetry.map(({ ponIndex, onuIndex, rxPower, txPower }) => ({
          ponIndex,
          onuIndex,
          rxPower,
          txPower,
        })),
        [
          { ponIndex: 1, onuIndex: 1, rxPower: -18.5, txPower: 2.3 },
          { ponIndex: 1, onuIndex: 2, rxPower: -19, txPower: 2.1 },
        ],
      );
      const serializedDetails = JSON.stringify(detailsResponse.body);
      assert.equal(serializedDetails.includes(reachableCommunity), false);
      for (const field of ["snmpCommunity", "snmpUsername", "snmpAuthPassword", "snmpPrivPassword"]) {
        assert.equal(
          serializedDetails.includes(`"${field}"`),
          false,
          `details response should omit ${field}`,
        );
      }
    } finally {
      snmp.createSession = originalCreateSession;
    }

    const fractionalFixture = await loadSnmpFixture("cisco-v1");
    const fractionalCommunity = `fractional-fixture-${Date.now()}`;
    const fractionalCredentialLabel = `fractional-fixture-${Date.now()}`;
    const fractionalCreateSession = snmp.createSession;
    snmp.createSession = (
      target: string,
      community: string,
      options: Record<string, unknown>,
    ) => {
      assert.equal(target, "127.0.0.3");
      assert.equal(community, fractionalCommunity);
      return fixtureSession(fractionalFixture);
    };
    try {
      const onboarded = await request("/api/devices", {
        method: "POST",
        headers: { cookie: authA.cookie },
        body: {
          name: "Tenant A Fractional Uptime Router",
          ipAddress: "127.0.0.3",
          vendor: "Cisco",
          type: "Router",
          location: "Test Lab",
          snmpVersion: "v1",
          snmpCommunity: fractionalCommunity,
          snmpCredentialLabel: fractionalCredentialLabel,
        },
      });
      assert.equal(onboarded.status, 201, JSON.stringify(onboarded.body));

      const polledDevice = await waitForDevicePoll(authA.cookie, onboarded.body.id);
      assert.equal(polledDevice.status, "online");
      assert.equal(
        polledDevice.sysUpTimeSeconds,
        9876.54,
        "reachable device should preserve fractional system uptime",
      );
    } finally {
      snmp.createSession = fractionalCreateSession;
    }

    const ticket = await request("/api/support/tickets", {
      method: "POST",
      headers: { cookie: authA.cookie },
      body: { subject: "Tenant A issue", priority: "high", message: "Private tenant ticket" },
    });
    assert.equal(ticket.status, 201);
    assert.equal((await request("/api/support/tickets", { headers: { cookie: authA.cookie } })).body.length, 1);
    assert.equal(
      (await request("/api/support/tickets", { headers: { authorization: `Bearer ${authB.token}`, "x-company-id": tenantA.companyId } })).status,
      403,
      "a tenant cannot read another tenant's support tickets",
    );
    assert.equal(
      (
        await request("/api/support/tickets", {
          method: "POST",
          headers: { authorization: `Bearer ${authB.token}`, "x-company-id": tenantA.companyId },
          body: { subject: "Unauthorized issue", priority: "low", message: "Should be blocked" },
        })
      ).status,
      403,
      "a tenant cannot write another tenant's support tickets",
    );

    assert.equal((await request("/api/billing/license", { headers: { cookie: authA.cookie } })).status, 200);
    assert.equal(
      (await request("/api/billing/license", { headers: { cookie: authA.cookie, "x-company-id": tenantB.companyId } })).status,
      403,
      "a tenant cannot read another tenant's license",
    );
    const licenseUpdate = {
      status: "active",
      planId: "growth",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    assert.equal(
      (
        await request(`/api/companies/${tenantB.companyId}/license`, {
          method: "PATCH",
          headers: { cookie: authA.cookie },
          body: licenseUpdate,
        })
      ).status,
      403,
      "a tenant cannot update another tenant's license",
    );
    assert.equal((await request("/api/companies", { headers: { cookie: authA.cookie } })).status, 403);
    assert.equal(
      (
        await request(`/api/companies/${tenantB.companyId}/license`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${adminAuth.token}` },
          body: licenseUpdate,
        })
      ).status,
      200,
      "only a super-admin should update a tenant license",
    );
    assert.equal(
      (
        await request("/api/companies", {
          headers: { authorization: `Bearer ${adminAuth.token}` },
        })
      ).status,
      200,
      "only a super-admin should list companies",
    );

    const tenantBSecondSession = await login(tenantB.username, tenantB.password);
    assert.equal(
      (
        await request("/api/auth/logout", {
          method: "POST",
          headers: { cookie: authA.cookie },
        })
      ).status,
      204,
      "logout should revoke the current cookie session",
    );
    assert.equal(
      (await request("/api/devices", { headers: { cookie: authA.cookie } })).status,
      401,
      "a logged-out cookie session should stop working",
    );
    assert.equal(
      (await request("/api/devices", { headers: { authorization: `Bearer ${authA.token}` } })).status,
      401,
      "a logged-out bearer session should stop working",
    );

    assert.equal(
      (
        await request("/api/auth/sessions/revoke", {
          method: "POST",
          headers: { authorization: `Bearer ${tenantBSecondSession.token}` },
        })
      ).status,
      204,
      "session revocation should revoke all sessions for the current user",
    );
    assert.equal(
      (await request("/api/devices", { headers: { authorization: `Bearer ${authB.token}` } })).status,
      401,
      "revoking user sessions should invalidate another bearer session",
    );
    assert.equal(
      (await request("/api/devices", { headers: { cookie: tenantBSecondSession.cookie } })).status,
      401,
      "revoking user sessions should invalidate the current cookie session",
    );
  } finally {
    await stopServer(server);
    await cleanup(companyIds);
  }
});

test("contact submissions validate, persist, stay private, and rate limit", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for contact security tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for contact security tests");
  const superAdminPassword = process.env.SUPERADMIN_PASSWORD;
  assert.ok(superAdminPassword, "SUPERADMIN_PASSWORD is required for contact security tests");

  await ensurePortalData();
  const companyIds: string[] = [];
  const contactEmails: string[] = [];
  const contactRetentionIds: string[] = [];
  let server = await startServer();

  try {
    const tenant = registration("contact-security");
    const registered = await request("/api/auth/register", {
      method: "POST",
      body: tenant,
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    tenant.companyId = registered.body.company.id;
    companyIds.push(tenant.companyId);
    const tenantAuth = await login(tenant.email, tenant.password, tenant.username);
    const operatorUsername = `${tenant.subdomain}-operator`;
    const operatorPassword = `${tenant.subdomain}-operator-Password!`;
    const createdOperator = await request("/api/company/users", {
      method: "POST",
      headers: { cookie: tenantAuth.cookie },
      body: {
        username: operatorUsername,
        email: `${operatorUsername}@example.test`,
        password: operatorPassword,
        role: "operator",
      },
    });
    assert.equal(createdOperator.status, 201, JSON.stringify(createdOperator.body));
    const operatorAuth = await login(operatorUsername, operatorPassword);
    const adminIdentifier = process.env.SUPERADMIN_USERNAME ?? "superadmin-admin";
    const adminAuth = await login(adminIdentifier, superAdminPassword);

    const contactIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const invalidContact = await request("/api/contact", {
      method: "POST",
      headers: { "x-forwarded-for": contactIp },
      body: { name: "", email: "not-an-email", message: "" },
    });
    assert.equal(invalidContact.status, 400, "invalid contact payloads must be rejected");

    const contactEmail = registration("contact").email;
    contactEmails.push(contactEmail);
    const acceptedContact = await request("/api/contact", {
      method: "POST",
      headers: { "x-forwarded-for": contactIp },
      body: {
        name: "  Contact Visitor  ",
        email: contactEmail.toUpperCase(),
        company: "  Example Fiber  ",
        message: "  We need a clearer network operating picture.  ",
      },
    });
    assert.equal(acceptedContact.status, 201, JSON.stringify(acceptedContact.body));
    assert.deepEqual(acceptedContact.body, { received: true });
    const storedContact = await db
      .select()
      .from(contactSubmissions)
      .where(eq(contactSubmissions.email, contactEmail))
      .limit(1);
    assert.equal(storedContact.length, 1, "accepted contact messages must be persisted");
    assert.equal(storedContact[0]?.name, "Contact Visitor");
    assert.equal(storedContact[0]?.company, "Example Fiber");
    assert.equal(storedContact[0]?.message, "We need a clearer network operating picture.");

    const automatedContactEmail = registration("contact-automated").email;
    const automatedContact = await request("/api/contact", {
      method: "POST",
      headers: { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` },
      body: {
        name: "Automated Visitor",
        email: automatedContactEmail,
        message: "This hidden field identifies an automated submission.",
        website: "https://spam.example",
      },
    });
    assert.equal(automatedContact.status, 429, "automated contact patterns must be blocked");
    assert.match(automatedContact.body.error, /try again/i);
    assert.equal(
      (await db.select().from(contactSubmissions).where(eq(contactSubmissions.email, automatedContactEmail))).length,
      0,
      "blocked automated contact messages must not be persisted",
    );

    assert.equal(
      (await request("/api/admin/contact-submissions")).status,
      401,
      "contact inquiries must not be readable without authentication",
    );
    assert.equal(
      (await request("/api/admin/contact-submissions", { headers: { cookie: tenantAuth.cookie } })).status,
      403,
      "company admins must not read contact inquiries",
    );
    assert.equal(
      (await request("/api/admin/contact-submissions", { headers: { cookie: operatorAuth.cookie } })).status,
      403,
      "operators must not read contact inquiries",
    );
    const contactId = storedContact[0]?.id;
    assert.ok(contactId, "accepted contact message should have an id");
    assert.equal(
      (await request(`/api/admin/contact-submissions/${contactId}`, {
        method: "PATCH",
        body: { handled: true, internalNote: "Visitor follow-up" },
      })).status,
      401,
      "contact review state must not be changeable without authentication",
    );
    assert.equal(
      (await request(`/api/admin/contact-submissions/${contactId}`, {
        method: "PATCH",
        headers: { cookie: tenantAuth.cookie },
        body: { handled: true, internalNote: "Tenant must not see this" },
      })).status,
      403,
      "tenant users must not change contact review state",
    );
    const updatedContact = await request(`/api/admin/contact-submissions/${contactId}`, {
      method: "PATCH",
      headers: { cookie: adminAuth.cookie },
      body: { handled: true, internalNote: "  Visitor follow-up  " },
    });
    assert.equal(updatedContact.status, 200, JSON.stringify(updatedContact.body));
    assert.equal(updatedContact.body.handled, true);
    assert.equal(updatedContact.body.internalNote, "Visitor follow-up");
    const listedForAdmin = await request("/api/admin/contact-submissions", {
      headers: { cookie: adminAuth.cookie },
    });
    assert.equal(listedForAdmin.status, 200, JSON.stringify(listedForAdmin.body));
    const listedContact = listedForAdmin.body.find((item: { id: string }) => item.id === contactId);
    assert.deepEqual(
      { handled: listedContact?.handled, internalNote: listedContact?.internalNote },
      { handled: true, internalNote: "Visitor follow-up" },
      "handled state and internal note must persist in the admin inbox",
    );

    const retentionNow = Date.now();
    const oldContactId = `CONTACT-retention-old-${retentionNow}`;
    const boundaryContactId = `CONTACT-retention-boundary-${retentionNow}`;
    const recentContactId = `CONTACT-retention-recent-${retentionNow}`;
    contactRetentionIds.push(oldContactId, boundaryContactId, recentContactId);
    await db.insert(contactSubmissions).values([
      {
        id: oldContactId,
        name: "Old Visitor",
        email: `old-retention-${retentionNow}@example.test`,
        company: "",
        message: "This inquiry is outside the retention period.",
        ipHash: "retention-old",
        createdAt: new Date(retentionNow - (CONTACT_SUBMISSION_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000),
      },
      {
        id: boundaryContactId,
        name: "Boundary Visitor",
        email: `boundary-retention-${retentionNow}@example.test`,
        company: "",
        message: "This inquiry is just inside the retention boundary.",
        ipHash: "retention-boundary",
        createdAt: new Date(
          retentionNow - CONTACT_SUBMISSION_RETENTION_DAYS * 24 * 60 * 60 * 1000 + 60 * 1000,
        ),
      },
      {
        id: recentContactId,
        name: "Recent Visitor",
        email: `recent-retention-${retentionNow}@example.test`,
        company: "",
        message: "This inquiry is recent and must remain.",
        ipHash: "retention-recent",
        createdAt: new Date(retentionNow),
      },
    ]);

    assert.equal(
      (await request("/api/admin/contact-submissions/cleanup", { method: "POST" })).status,
      401,
      "contact cleanup must not run without authentication",
    );
    assert.equal(
      (await request("/api/admin/contact-submissions/cleanup", {
        method: "POST",
        headers: { cookie: tenantAuth.cookie },
      })).status,
      403,
      "company admins must not run contact cleanup",
    );
    assert.equal(
      (await request("/api/admin/contact-submissions/cleanup", {
        method: "POST",
        headers: { cookie: operatorAuth.cookie },
      })).status,
      403,
      "operators must not run contact cleanup",
    );
    const cleanup = await request("/api/admin/contact-submissions/cleanup", {
      method: "POST",
      headers: { cookie: adminAuth.cookie },
    });
    assert.equal(cleanup.status, 200, JSON.stringify(cleanup.body));
    assert.ok(cleanup.body.deletedCount >= 1);
    assert.equal(cleanup.body.retentionDays, CONTACT_SUBMISSION_RETENTION_DAYS);
    assert.equal(typeof cleanup.body.cutoff, "string");

    const retainedContactIds = (
      await db
        .select({ id: contactSubmissions.id })
        .from(contactSubmissions)
        .where(inArray(contactSubmissions.id, [boundaryContactId, recentContactId]))
    ).map((row) => row.id);
    assert.deepEqual(
      retainedContactIds.sort(),
      [boundaryContactId, recentContactId].sort(),
      "cleanup must retain boundary and recent inquiries",
    );
    assert.equal(
      (await db.select({ id: contactSubmissions.id }).from(contactSubmissions).where(eq(contactSubmissions.id, oldContactId))).length,
      0,
      "cleanup must remove only inquiries older than the retention period",
    );
    const cleanupAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "contact_submissions.purged"), eq(auditLogs.actorUserId, adminAuth.userId)));
    assert.ok(
      cleanupAudit.some((entry) => entry.metadata.deletedCount === cleanup.body.deletedCount),
      "cleanup must leave an audit record without storing contact contents",
    );

    const rateLimitIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
    for (let index = 0; index < 5; index += 1) {
      const email = registration(`contact-rate-${index}`).email;
      contactEmails.push(email);
      const response = await request("/api/contact", {
        method: "POST",
        headers: { "x-forwarded-for": rateLimitIp },
        body: {
          name: `Rate limit visitor ${index}`,
          email,
          message: `Rate limit test message ${index}`,
        },
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
    }
    const rateLimitedContact = await request("/api/contact", {
      method: "POST",
      headers: { "x-forwarded-for": rateLimitIp },
      body: {
        name: "Rate limit visitor six",
        email: registration("contact-rate-six").email,
        message: "This message must be rejected.",
      },
    });
    assert.equal(rateLimitedContact.status, 429, "the sixth message from one IP must be rate limited");
  } finally {
    await stopServer(server);
    if (contactEmails.length) {
      await db.delete(contactSubmissions).where(inArray(contactSubmissions.email, contactEmails));
    }
    if (contactRetentionIds.length) {
      await db.delete(contactSubmissions).where(inArray(contactSubmissions.id, contactRetentionIds));
    }
    await cleanup(companyIds);
  }
});

test.after(async () => {
  await pool.end();
});