import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { Server } from "node:http";
import app from "./app";
import { db, pool } from "@workspace/db";
import {
  companies,
  deviceInterfaceSamples,
  deviceInterfaces,
  monitoredDevices,
  ponTelemetry,
  ponTelemetrySamples,
  portalUsers,
  authSessions,
  alertSettings,
  licenses,
  supportTickets,
  auditLogs,
  TELEMETRY_HISTORY_RETENTION_DAYS,
} from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import {
  GetDeviceDetailsResponse,
  GetDeviceHistoryResponse,
  UpdateDeviceMibSettingsResponse,
} from "@workspace/api-zod";
import { ensurePortalData } from "./lib/portal-store";
import { pruneTelemetryHistory, upsertDevice } from "./lib/nms-store";

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

async function request(
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<HttpResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
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

function suffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup(companyId: string, deviceIds: string[]): Promise<void> {
  await db.delete(deviceInterfaceSamples).where(inArray(deviceInterfaceSamples.deviceId, deviceIds));
  await db.delete(ponTelemetrySamples).where(inArray(ponTelemetrySamples.deviceId, deviceIds));
  await db.delete(deviceInterfaces).where(inArray(deviceInterfaces.deviceId, deviceIds));
  await db.delete(ponTelemetry).where(inArray(ponTelemetry.deviceId, deviceIds));
  await db.delete(monitoredDevices).where(inArray(monitoredDevices.id, deviceIds));
  await db.delete(supportTickets).where(inArray(supportTickets.companyId, [companyId]));
  await db.delete(alertSettings).where(inArray(alertSettings.companyId, [companyId]));
  await db.delete(auditLogs).where(inArray(auditLogs.companyId, [companyId]));
  await db.delete(authSessions).where(inArray(authSessions.companyId, [companyId]));
  await db.delete(licenses).where(inArray(licenses.companyId, [companyId]));
  await db.delete(portalUsers).where(inArray(portalUsers.companyId, [companyId]));
  await db.delete(companies).where(inArray(companies.id, [companyId]));
}

test("keeps complete, empty, and partial device telemetry usable", async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for device detail tests");
  assert.ok(process.env.SESSION_SECRET, "SESSION_SECRET is required for device detail tests");

  await ensurePortalData();
  const server = await startServer();
  const deviceIds: string[] = [];
  let companyId = "";

  try {
    const value = suffix("device-details");
    const registration = {
      subdomain: value,
      companyName: "Device Details Test Company",
      contactNumber: "9876543210",
      email: `${value}@example.test`,
      address: "Device details test address",
      username: `${value}-admin`,
      password: `${value}-Password!`,
    };
    const registered = await request("/api/auth/register", { method: "POST", body: registration });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    companyId = registered.body.company.id;

    const login = await request("/api/auth/login", {
      method: "POST",
      body: { identifier: registration.email, password: registration.password },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const cookie = sessionCookie(login);

    const completeId = `device-details-complete-${value}`;
    const emptyId = `device-details-empty-${value}`;
    const partialId = `device-details-partial-${value}`;
    deviceIds.push(completeId, emptyId, partialId);
    const deviceInput = {
      companyId,
      vendor: "ZTE",
      type: "OLT",
      location: "Test lab",
      credentialId: null,
    };

    await upsertDevice({ ...deviceInput, id: completeId, name: "Complete OLT", ipAddress: `192.0.2.10` });
    await upsertDevice({ ...deviceInput, id: emptyId, name: "Empty OLT", ipAddress: `192.0.2.11` });
    await upsertDevice({ ...deviceInput, id: partialId, name: "Partial OLT", ipAddress: `192.0.2.12` });

    const sampledAt = new Date(Date.now() - 5 * 60 * 1000);
    const staleSampledAt = new Date(
      Date.now() - (TELEMETRY_HISTORY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    await db.insert(deviceInterfaces).values([
      {
        id: `interface-complete-${value}`,
        deviceId: completeId,
        ifIndex: 1,
        name: "gei_1/1/1",
        alias: "Uplink",
        adminStatus: "up",
        operStatus: "up",
        speedMbps: 1000,
        rxBytes: "123456789",
        txBytes: "987654321",
      },
    ]);
    await db.insert(ponTelemetry).values([
      {
        id: `pon-complete-${value}`,
        deviceId: completeId,
        ponIndex: 1,
        onuIndex: 1,
        rxPower: -18.25,
        txPower: 2.5,
      },
    ]);
    await db.insert(deviceInterfaceSamples).values([
      {
        id: `interface-sample-complete-${value}`,
        deviceId: completeId,
        ifIndex: 1,
        name: "gei_1/1/1",
        rxBytes: "120000000",
        txBytes: "980000000",
        sampledAt,
      },
      {
        id: `interface-sample-stale-${value}`,
        deviceId: completeId,
        ifIndex: 1,
        name: "gei_1/1/1",
        rxBytes: "100000000",
        txBytes: "900000000",
        sampledAt: staleSampledAt,
      },
    ]);
    await db.insert(ponTelemetrySamples).values([
      {
        id: `pon-sample-complete-${value}`,
        deviceId: completeId,
        ponIndex: 1,
        onuIndex: 1,
        rxPower: -18.5,
        txPower: 2.25,
        sampledAt,
      },
      {
        id: `pon-sample-stale-${value}`,
        deviceId: completeId,
        ponIndex: 1,
        onuIndex: 1,
        rxPower: -19,
        txPower: 2,
        sampledAt: staleSampledAt,
      },
    ]);

    await db.insert(deviceInterfaces).values([
      {
        id: `interface-partial-${value}`,
        deviceId: partialId,
        ifIndex: 2,
        name: "gei_1/1/2",
        alias: null,
        adminStatus: null,
        operStatus: null,
        speedMbps: null,
        rxBytes: null,
        txBytes: "4500",
      },
    ]);
    await db.insert(ponTelemetry).values([
      {
        id: `pon-partial-rx-${value}`,
        deviceId: partialId,
        ponIndex: 1,
        onuIndex: 1,
        rxPower: null,
        txPower: 1.75,
      },
      {
        id: `pon-partial-tx-${value}`,
        deviceId: partialId,
        ponIndex: 1,
        onuIndex: 2,
        rxPower: -22.5,
        txPower: null,
      },
    ]);
    await db.insert(deviceInterfaceSamples).values([
      {
        id: `interface-sample-partial-${value}`,
        deviceId: partialId,
        ifIndex: 2,
        name: "gei_1/1/2",
        rxBytes: null,
        txBytes: "4000",
        sampledAt,
      },
    ]);
    await db.insert(ponTelemetrySamples).values([
      {
        id: `pon-sample-partial-${value}`,
        deviceId: partialId,
        ponIndex: 1,
        onuIndex: 1,
        rxPower: null,
        txPower: 1.5,
        sampledAt,
      },
      {
        id: `pon-sample-partial-tx-${value}`,
        deviceId: partialId,
        ponIndex: 1,
        onuIndex: 2,
        rxPower: -23,
        txPower: null,
        sampledAt,
      },
    ]);

    await pruneTelemetryHistory(new Date());
    const remainingInterfaceSamples = await db
      .select()
      .from(deviceInterfaceSamples)
      .where(inArray(deviceInterfaceSamples.deviceId, [completeId]));
    const remainingPonSamples = await db
      .select()
      .from(ponTelemetrySamples)
      .where(inArray(ponTelemetrySamples.deviceId, [completeId]));
    assert.equal(
      remainingInterfaceSamples.length,
      1,
      "stale interface samples should be pruned",
    );
    assert.equal(
      remainingPonSamples.length,
      1,
      "stale ONU samples should be pruned",
    );
    assert.equal(remainingInterfaceSamples[0]?.rxBytes, "120000000");
    assert.equal(remainingPonSamples[0]?.rxPower, -18.5);

    const authorizedRequest = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };

    const completeResponse = await authorizedRequest(`/api/devices/${completeId}/details`);
    assert.equal(completeResponse.status, 200, JSON.stringify(completeResponse.body));
    const complete = GetDeviceDetailsResponse.parse(completeResponse.body);
    assert.equal(complete.interfaces.length, 1);
    assert.equal(complete.interfaces[0].seriesKey, "interface:1");
    assert.equal(complete.interfaces[0].rxBytes, "123456789");
    assert.equal(complete.ponTelemetry[0].seriesKey, "onu:1:1");
    assert.equal(complete.ponTelemetry[0].rxPower, -18.25);
    assert.equal(complete.ponTelemetry[0].txPower, 2.5);

    const emptyResponse = await authorizedRequest(`/api/devices/${emptyId}/details`);
    assert.equal(emptyResponse.status, 200, JSON.stringify(emptyResponse.body));
    const empty = GetDeviceDetailsResponse.parse(emptyResponse.body);
    assert.deepEqual(empty.interfaces, []);
    assert.deepEqual(empty.ponTelemetry, []);

    const partialResponse = await authorizedRequest(`/api/devices/${partialId}/details`);
    assert.equal(partialResponse.status, 200, JSON.stringify(partialResponse.body));
    const partial = GetDeviceDetailsResponse.parse(partialResponse.body);
    assert.equal(partial.interfaces[0].rxBytes, null);
    assert.equal(partial.interfaces[0].txBytes, "4500");
    assert.equal(partial.interfaces[0].speedMbps, null);
    assert.equal(partial.ponTelemetry[0].rxPower, null);
    assert.equal(partial.ponTelemetry[0].txPower, 1.75);
    assert.equal(partial.ponTelemetry[1].rxPower, -22.5);
    assert.equal(partial.ponTelemetry[1].txPower, null);

    const updateMibResponse = await fetch(`${baseUrl}/api/devices/${completeId}/mib-settings`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        mibProfile: "VSOL",
        ponCountOid: "1.3.6.1.4.1.37950.1",
        onuCountOid: null,
        rxPowerRoot: "1.3.6.1.4.1.37950.2",
        txPowerRoot: "1.3.6.1.4.1.37950.3",
      }),
    });
    assert.equal(updateMibResponse.status, 200);
    const updatedMib = UpdateDeviceMibSettingsResponse.parse(await updateMibResponse.json());
    assert.equal(updatedMib.mibProfile, "VSOL");
    assert.equal(updatedMib.ponCountOid, "1.3.6.1.4.1.37950.1");
    assert.equal(updatedMib.onuCountOid, null);
    assert.equal(updatedMib.rxPowerRoot, "1.3.6.1.4.1.37950.2");
    assert.equal(updatedMib.txPowerRoot, "1.3.6.1.4.1.37950.3");
    assert.equal("credentialId" in updatedMib, false);

    const updatedDetailsResponse = await authorizedRequest(`/api/devices/${completeId}/details`);
    assert.equal(updatedDetailsResponse.status, 200);
    assert.equal(updatedDetailsResponse.body.device.mibProfile, "VSOL");
    assert.equal(updatedDetailsResponse.body.device.onuCountOid, null);

    const partialHistoryResponse = await authorizedRequest(
      `/api/devices/history?deviceId=${partialId}&window=24h`,
    );
    assert.equal(partialHistoryResponse.status, 200, JSON.stringify(partialHistoryResponse.body));
    const partialHistory = GetDeviceHistoryResponse.parse(partialHistoryResponse.body);
    assert.equal(partialHistory.interfaceHistory[0].seriesKey, "interface:2");
    assert.equal(partialHistory.opticalHistory[0].seriesKey, "onu:1:1");
    assert.equal(partialHistory.opticalHistory[1].seriesKey, "onu:1:2");
    assert.equal(partialHistory.interfaceHistory[0].rxBytes, null);
    assert.equal(partialHistory.opticalHistory[0].rxPower, null);
    assert.equal(partialHistory.opticalHistory[1].txPower, null);

    const emptyHistoryResponse = await authorizedRequest(`/api/devices/history?deviceId=${emptyId}&window=1h`);
    assert.equal(emptyHistoryResponse.status, 200, JSON.stringify(emptyHistoryResponse.body));
    const emptyHistory = GetDeviceHistoryResponse.parse(emptyHistoryResponse.body);
    assert.deepEqual(emptyHistory.interfaceHistory, []);
    assert.deepEqual(emptyHistory.opticalHistory, []);
    assert.equal(emptyHistory.historyWindow, "1h");
  } finally {
    await stopServer(server);
    if (companyId) await cleanup(companyId, deviceIds);
    await pool.end();
  }
});