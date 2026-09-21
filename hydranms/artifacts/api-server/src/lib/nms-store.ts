import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  deviceInterfaces,
  deviceInterfaceSamples,
  discoveryJobs,
  monitoredDevices,
  nmsAlerts,
  ponTelemetry,
  ponTelemetrySamples,
  pollerLogs,
  snmpCredentials,
  TELEMETRY_HISTORY_RETENTION_DAYS,
} from "@workspace/db/schema";
import { encryptSnmpCredentials, decryptSnmpCredentials } from "./snmp-crypto";
import type { PollResult, SnmpCredentialPayload } from "./snmp-poller";
import { derivePollState } from "./nms-poll-state";
import { detectInterfaceAlertEvents, type InterfaceAlertSnapshot, type InterfaceAlertEvent } from "./nms-alert-rules";
import { alertSettingsForCompany } from "./portal-store";
import {
  openAutomaticIncidentTicket,
  resolveAutomaticIncidentTicket,
} from "./portal-store";
import { queueCompanyAlert, queueCompanyTicketAlert } from "./notification-service";

export const defaultCompanyId = (value: unknown): string =>
  typeof value === "string" && value.length > 0 ? value : "co-001";

export async function saveCredential(
  companyId: string,
  label: string,
  credentials: SnmpCredentialPayload,
): Promise<string> {
  const id = `cred-${crypto.randomUUID()}`;
  const encryptedPayload = encryptSnmpCredentials(credentials);
  const existing = await db
    .select({ id: snmpCredentials.id })
    .from(snmpCredentials)
    .where(and(eq(snmpCredentials.companyId, companyId), eq(snmpCredentials.label, label)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(snmpCredentials)
      .set({ version: credentials.version, encryptedPayload, updatedAt: new Date() })
      .where(eq(snmpCredentials.id, existing[0].id));
    return existing[0].id;
  }
  await db.insert(snmpCredentials).values({
    id,
    companyId,
    label,
    version: credentials.version,
    encryptedPayload,
  });
  return id;
}

export async function credentialById(id: string): Promise<SnmpCredentialPayload> {
  const result = await db.select().from(snmpCredentials).where(eq(snmpCredentials.id, id)).limit(1);
  if (!result[0]) throw new Error("SNMP credential not found");
  return decryptSnmpCredentials<SnmpCredentialPayload>(result[0].encryptedPayload);
}

export async function credentialByLabel(
  companyId: string,
  label: string,
): Promise<{ id: string; value: SnmpCredentialPayload }> {
  const result = await db
    .select()
    .from(snmpCredentials)
    .where(and(eq(snmpCredentials.companyId, companyId), eq(snmpCredentials.label, label)))
    .limit(1);
  if (!result[0]) throw new Error(`SNMP credential "${label}" not found`);
  return { id: result[0].id, value: decryptSnmpCredentials(result[0].encryptedPayload) };
}

export async function upsertDevice(input: {
  id?: string;
  companyId: string;
  name: string;
  ipAddress: string;
  vendor: string;
  type: string;
  location: string;
  credentialId: string | null;
  mibProfile?: string | null;
  ponCountOid?: string | null;
  onuCountOid?: string | null;
  rxPowerRoot?: string | null;
  txPowerRoot?: string | null;
}) {
  const id = input.id ?? `dev-${crypto.randomUUID()}`;
  const existing = await db
    .select({ id: monitoredDevices.id })
    .from(monitoredDevices)
    .where(and(eq(monitoredDevices.companyId, input.companyId), eq(monitoredDevices.ipAddress, input.ipAddress)))
    .limit(1);
  if (existing[0]) {
    const mibSettings =
      input.mibProfile !== undefined ||
      input.ponCountOid !== undefined ||
      input.onuCountOid !== undefined ||
      input.rxPowerRoot !== undefined ||
      input.txPowerRoot !== undefined
        ? {
            ...(input.mibProfile !== undefined ? { mibProfile: input.mibProfile } : {}),
            ...(input.ponCountOid !== undefined ? { ponCountOid: input.ponCountOid } : {}),
            ...(input.onuCountOid !== undefined ? { onuCountOid: input.onuCountOid } : {}),
            ...(input.rxPowerRoot !== undefined ? { rxPowerRoot: input.rxPowerRoot } : {}),
            ...(input.txPowerRoot !== undefined ? { txPowerRoot: input.txPowerRoot } : {}),
          }
        : {};
    await db
      .update(monitoredDevices)
      .set({
        name: input.name,
        vendor: input.vendor,
        type: input.type,
        location: input.location,
        credentialId: input.credentialId,
        updatedAt: new Date(),
        ...mibSettings,
      })
      .where(eq(monitoredDevices.id, existing[0].id));
    return existing[0].id;
  }
  await db.insert(monitoredDevices).values({
    id,
    companyId: input.companyId,
    name: input.name,
    ipAddress: input.ipAddress,
    vendor: input.vendor,
    type: input.type,
    location: input.location,
    credentialId: input.credentialId,
    mibProfile: input.mibProfile ?? null,
    ponCountOid: input.ponCountOid ?? null,
    onuCountOid: input.onuCountOid ?? null,
    rxPowerRoot: input.rxPowerRoot ?? null,
    txPowerRoot: input.txPowerRoot ?? null,
  });
  return id;
}

export async function updateDeviceMibSettings(
  companyId: string,
  deviceId: string,
  input: {
    mibProfile: string | null;
    ponCountOid: string | null;
    onuCountOid: string | null;
    rxPowerRoot: string | null;
    txPowerRoot: string | null;
  },
) {
  const updated = await db
    .update(monitoredDevices)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(and(eq(monitoredDevices.id, deviceId), eq(monitoredDevices.companyId, companyId)))
    .returning();
  return updated[0] ?? null;
}

export async function listDevices(companyId: string) {
  return db
    .select()
    .from(monitoredDevices)
    .where(eq(monitoredDevices.companyId, companyId))
    .orderBy(desc(monitoredDevices.updatedAt));
}

export async function deviceById(id: string) {
  const result = await db.select().from(monitoredDevices).where(eq(monitoredDevices.id, id)).limit(1);
  return result[0] ?? null;
}

export async function deviceByCompanyId(companyId: string, deviceId: string) {
  const result = await db
    .select()
    .from(monitoredDevices)
    .where(and(eq(monitoredDevices.id, deviceId), eq(monitoredDevices.companyId, companyId)))
    .limit(1);
  return result[0] ?? null;
}

export async function deleteDevice(companyId: string, deviceId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const matching = await tx
      .select({ id: monitoredDevices.id })
      .from(monitoredDevices)
      .where(and(eq(monitoredDevices.id, deviceId), eq(monitoredDevices.companyId, companyId)))
      .limit(1);
    if (!matching[0]) return false;

    await tx.delete(deviceInterfaces).where(eq(deviceInterfaces.deviceId, deviceId));
    await tx.delete(deviceInterfaceSamples).where(eq(deviceInterfaceSamples.deviceId, deviceId));
    await tx.delete(ponTelemetry).where(eq(ponTelemetry.deviceId, deviceId));
    await tx.delete(ponTelemetrySamples).where(eq(ponTelemetrySamples.deviceId, deviceId));
    await tx.delete(nmsAlerts).where(eq(nmsAlerts.deviceId, deviceId));
    const deleted = await tx
      .delete(monitoredDevices)
      .where(and(eq(monitoredDevices.id, deviceId), eq(monitoredDevices.companyId, companyId)))
      .returning({ id: monitoredDevices.id });
    return deleted.length > 0;
  });
}

export async function updateDeviceCliSettings(
  companyId: string,
  deviceId: string,
  input: {
    cliProtocol: "ssh" | "telnet" | "both";
    sshPort: number;
    telnetPort: number;
    cliUsername: string;
    cliPassword: string;
  },
) {
  const updated = await db
    .update(monitoredDevices)
    .set({
      cliProtocol: input.cliProtocol,
      sshPort: input.sshPort,
      telnetPort: input.telnetPort,
      cliUsername: input.cliUsername,
      encryptedCliPassword: encryptSnmpCredentials({ password: input.cliPassword }),
      updatedAt: new Date(),
    })
    .where(and(eq(monitoredDevices.id, deviceId), eq(monitoredDevices.companyId, companyId)))
    .returning();
  return updated[0] ?? null;
}

export type HistoryWindow = "1h" | "6h" | "24h" | "7d";

const telemetrySampleCleanupBatchSize = 500;

const historyWindowMs: Record<HistoryWindow, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/**
 * Delete old samples in small batches. The sampled-at indexes make each batch
 * bounded, and separate statements let PostgreSQL release row locks between
 * batches while history queries continue to use MVCC snapshots.
 */
async function pruneInterfaceSamples(cutoff: Date): Promise<number> {
  let deleted = 0;
  while (true) {
    const staleRows = await db
      .select({ id: deviceInterfaceSamples.id })
      .from(deviceInterfaceSamples)
      .where(lt(deviceInterfaceSamples.sampledAt, cutoff))
      .orderBy(deviceInterfaceSamples.sampledAt)
      .limit(telemetrySampleCleanupBatchSize);
    if (staleRows.length === 0) return deleted;

    await db.delete(deviceInterfaceSamples).where(
      inArray(
        deviceInterfaceSamples.id,
        staleRows.map((row) => row.id),
      ),
    );
    deleted += staleRows.length;
  }
}

async function prunePonTelemetrySamples(cutoff: Date): Promise<number> {
  let deleted = 0;
  while (true) {
    const staleRows = await db
      .select({ id: ponTelemetrySamples.id })
      .from(ponTelemetrySamples)
      .where(lt(ponTelemetrySamples.sampledAt, cutoff))
      .orderBy(ponTelemetrySamples.sampledAt)
      .limit(telemetrySampleCleanupBatchSize);
    if (staleRows.length === 0) return deleted;

    await db.delete(ponTelemetrySamples).where(
      inArray(
        ponTelemetrySamples.id,
        staleRows.map((row) => row.id),
      ),
    );
    deleted += staleRows.length;
  }
}

export async function pruneTelemetryHistory(now = new Date()): Promise<{
  interfaceSamples: number;
  ponTelemetrySamples: number;
}> {
  const cutoff = new Date(
    now.getTime() - TELEMETRY_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const [interfaceSamples, ponTelemetrySamples] = await Promise.all([
    pruneInterfaceSamples(cutoff),
    prunePonTelemetrySamples(cutoff),
  ]);
  return { interfaceSamples, ponTelemetrySamples };
}

export async function deviceDetailsById(
  companyId: string,
  deviceId: string,
  window: HistoryWindow = "24h",
) {
  const deviceResult = await db
    .select()
    .from(monitoredDevices)
    .where(and(eq(monitoredDevices.id, deviceId), eq(monitoredDevices.companyId, companyId)))
    .limit(1);
  const device = deviceResult[0] ?? null;
  if (!device) return null;

  const since = new Date(Date.now() - historyWindowMs[window]);
  const [interfaces, ponRows, interfaceHistory, opticalHistory] = await Promise.all([
    db
      .select()
      .from(deviceInterfaces)
      .where(eq(deviceInterfaces.deviceId, deviceId))
      .orderBy(deviceInterfaces.ifIndex),
    db
      .select()
      .from(ponTelemetry)
      .where(eq(ponTelemetry.deviceId, deviceId))
      .orderBy(ponTelemetry.ponIndex, ponTelemetry.onuIndex),
    db
      .select()
      .from(deviceInterfaceSamples)
      .where(and(eq(deviceInterfaceSamples.deviceId, deviceId), gte(deviceInterfaceSamples.sampledAt, since)))
      .orderBy(deviceInterfaceSamples.sampledAt, deviceInterfaceSamples.ifIndex),
    db
      .select()
      .from(ponTelemetrySamples)
      .where(and(eq(ponTelemetrySamples.deviceId, deviceId), gte(ponTelemetrySamples.sampledAt, since)))
      .orderBy(ponTelemetrySamples.sampledAt, ponTelemetrySamples.ponIndex, ponTelemetrySamples.onuIndex),
  ]);

  return { device, interfaces, ponTelemetry: ponRows, interfaceHistory, opticalHistory, historyWindow: window };
}

export async function recordPoll(
  deviceId: string,
  result: PollResult,
  success: boolean,
) {
  const device = await deviceById(deviceId);
  if (!device) return;
  const now = new Date();
  const state = derivePollState(device, result, success, now);
  const previousInterfaces = success
    ? await db.select().from(deviceInterfaces).where(eq(deviceInterfaces.deviceId, deviceId))
    : [];
  const telemetryUpdate = state.telemetry
    ? {
        sysUpTimeSeconds: state.telemetry.sysUpTimeSeconds,
        systemVersion: state.telemetry.systemVersion,
        ramPercent: state.telemetry.ramPercent,
        diskPercent: state.telemetry.diskPercent,
        interfaceCount: state.telemetry.interfaces.length,
        ponCount: state.telemetry.ponCount,
        onuCount: state.telemetry.onuCount,
        rxPower: state.telemetry.rxPower,
        txPower: state.telemetry.txPower,
      }
    : {};
  await db
    .update(monitoredDevices)
    .set({
      status: state.status,
      lastSeen: state.lastSeen,
      lastPollAt: state.lastPollAt,
      consecutiveFailures: state.consecutiveFailures,
      updatedAt: now,
      ...telemetryUpdate,
      uptimePercent: sql`CASE WHEN ${success} THEN LEAST(100, ${monitoredDevices.uptimePercent} + 0.01) ELSE GREATEST(0, ${monitoredDevices.uptimePercent} - 0.1) END`,
    })
    .where(eq(monitoredDevices.id, deviceId));
  for (const item of result.interfaces) {
    await db
      .insert(deviceInterfaces)
      .values({
        id: `if-${deviceId}-${item.ifIndex}`,
        deviceId,
        ifIndex: item.ifIndex,
        name: item.name,
        alias: item.alias,
        adminStatus: item.adminStatus,
        operStatus: item.operStatus,
        speedMbps: item.speedMbps,
        rxBytes: item.rxBytes,
        txBytes: item.txBytes,
         sfpVendor: item.sfpVendor,
         sfpSerialNumber: item.sfpSerialNumber,
         opticalRxPower: item.opticalRxPower,
         opticalTxPower: item.opticalTxPower,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [deviceInterfaces.deviceId, deviceInterfaces.ifIndex],
        set: {
          name: item.name,
          alias: item.alias,
          adminStatus: item.adminStatus,
          operStatus: item.operStatus,
          speedMbps: item.speedMbps,
          rxBytes: item.rxBytes,
          txBytes: item.txBytes,
           sfpVendor: item.sfpVendor,
           sfpSerialNumber: item.sfpSerialNumber,
           opticalRxPower: item.opticalRxPower,
           opticalTxPower: item.opticalTxPower,
          updatedAt: now,
        },
      });
    await db.insert(deviceInterfaceSamples).values({
      id: `if-sample-${crypto.randomUUID()}`,
      deviceId,
      ifIndex: item.ifIndex,
      name: item.name,
      rxBytes: item.rxBytes,
      txBytes: item.txBytes,
      sampledAt: now,
    });
  }
  for (const item of result.ponTelemetry) {
    await db
      .insert(ponTelemetry)
      .values({
        id: `pon-${deviceId}-${item.ponIndex}-${item.onuIndex}`,
        deviceId,
        ponIndex: item.ponIndex,
        onuIndex: item.onuIndex,
        rxPower: item.rxPower,
        txPower: item.txPower,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [ponTelemetry.deviceId, ponTelemetry.ponIndex, ponTelemetry.onuIndex],
        set: { rxPower: item.rxPower, txPower: item.txPower, updatedAt: now },
      });
    await db.insert(ponTelemetrySamples).values({
      id: `pon-sample-${crypto.randomUUID()}`,
      deviceId,
      ponIndex: item.ponIndex,
      onuIndex: item.onuIndex,
      rxPower: item.rxPower,
      txPower: item.txPower,
      sampledAt: now,
    });
  }

  if (success) {
    const recovered = await resolveAlert(device.companyId, `device-down:${device.id}`, now);
    if (recovered) {
      const title = `${device.name} recovered`;
      const message = "SNMP polling has recovered after a device-down incident.";
      void queueCompanyAlert({
        companyId: device.companyId,
        eventType: "device.recovered",
        title,
        message,
        alertId: `${device.companyId}:device-down:${device.id}:${now.toISOString()}`,
      }).catch((error) => console.error("Unable to queue device-recovered alert", error));
      const ticket = await resolveAutomaticIncidentTicket(device.companyId, `device-down:${device.id}`);
      if (ticket) {
        void queueCompanyTicketAlert({
          companyId: device.companyId,
          eventType: "ticket.resolved",
          title: ticket.title,
          message: "Device is responding again. The incident ticket was auto-resolved.",
          ticketId: ticket.id,
          deviceName: device.name,
          deviceIp: device.ipAddress,
          deviceLocation: device.location,
          timestamp: now,
        }).catch((error) => console.error("Unable to queue device ticket resolution", error));
      }
    }
    if (result.interfaces.length > 0) {
      await syncInterfaceAlerts(device, previousInterfaces, result.interfaces, now);
    }
    await syncOpticalAlerts(device, result, now);
  } else if (state.status === "offline") {
    const opened = await openAlert({
      companyId: device.companyId,
      deviceId: device.id,
      dedupKey: `device-down:${device.id}`,
      severity: "critical",
      title: `${device.name} is down`,
      deviceName: device.name,
      message: `SNMP polling has failed ${state.consecutiveFailures} consecutive times.`,
      now,
    });
    if (opened) {
      void queueCompanyAlert({
        companyId: device.companyId,
        eventType: "device.down",
        title: `${device.name} is down`,
        message: `SNMP polling has failed ${state.consecutiveFailures} consecutive times.`,
        alertId: `${device.companyId}:device-down:${device.id}:${now.toISOString()}`,
      }).catch((error) => console.error("Unable to queue device-down alert", error));
    }
    const ticket = await openAutomaticIncidentTicket({
      companyId: device.companyId,
      sourceKey: `device-down:${device.id}:${now.getTime()}`,
      deviceId: device.id,
      title: `${device.name} is down`,
      description: `SNMP polling has failed ${state.consecutiveFailures} consecutive times.`,
      priority: "critical",
    });
    if (ticket.opened) {
      void queueCompanyTicketAlert({
        companyId: device.companyId,
        eventType: "ticket.opened",
        title: ticket.ticket.title,
        message: ticket.ticket.description,
        ticketId: ticket.ticket.id,
        deviceName: device.name,
        deviceIp: device.ipAddress,
        deviceLocation: device.location,
        timestamp: now,
      }).catch((error) => console.error("Unable to queue device ticket", error));
    }
  }
}

async function syncInterfaceAlerts(
  device: { id: string; companyId: string; name: string; ipAddress: string; location: string },
  previousInterfaces: InterfaceAlertSnapshot[],
  currentInterfaces: InterfaceAlertSnapshot[],
  now: Date,
) {
  const previousByIndex = new Map(previousInterfaces.map((item) => [item.ifIndex, item]));
  for (const current of currentInterfaces) {
    const previous = previousByIndex.get(current.ifIndex) ?? null;
    const events = detectInterfaceAlertEvents(previous, current);
    for (const event of events) {
      await syncInterfaceAlertEvent(device, event, now);
    }
    if (previous) {
      if (
        previous.opticalRxPower !== null &&
        current.opticalRxPower !== null &&
        previous.opticalRxPower === current.opticalRxPower
      ) {
        await resolveAlert(device.companyId, `sfp-change:${device.id}:${current.ifIndex}:rx`, now);
      }
      if (
        previous.opticalTxPower !== null &&
        current.opticalTxPower !== null &&
        previous.opticalTxPower === current.opticalTxPower
      ) {
        await resolveAlert(device.companyId, `sfp-change:${device.id}:${current.ifIndex}:tx`, now);
      }
    }
    if (previous && !hasSfpSnapshot(current) && hasSfpSnapshot(previous)) {
      continue;
    }
    if (previous && hasSfpSnapshot(current)) {
      await resolveAlert(device.companyId, `sfp-removed:${device.id}:${current.ifIndex}`, now);
    }
  }
}

function hasSfpSnapshot(snapshot: InterfaceAlertSnapshot): boolean {
  return Boolean(
    snapshot.sfpVendor ||
      snapshot.sfpSerialNumber ||
      snapshot.opticalRxPower !== null ||
      snapshot.opticalTxPower !== null,
  );
}

async function syncInterfaceAlertEvent(
  device: { id: string; companyId: string; name: string; ipAddress: string; location: string },
  event: InterfaceAlertEvent,
  now: Date,
) {
  const label = event.label || `Port ${event.ifIndex}`;
  if (event.kind === "port.up" || event.kind === "port.down") {
    const currentState = event.kind === "port.up" ? "up" : "down";
    const oppositeState = currentState === "up" ? "down" : "up";
    const dedupKey = `port-state:${device.id}:${event.ifIndex}:${currentState}`;
    await resolveAlert(device.companyId, `port-state:${device.id}:${event.ifIndex}:${oppositeState}`, now);
    const title = `${device.name} ${label} is ${currentState}`;
    const message = `${label} changed from ${oppositeState.toUpperCase()} to ${currentState.toUpperCase()}.`;
    const opened = await openAlert({
      companyId: device.companyId,
      deviceId: device.id,
      dedupKey,
      severity: currentState === "down" ? "critical" : "info",
      title,
      deviceName: device.name,
      message,
      now,
    });
    if (opened) {
      void queueCompanyAlert({
        companyId: device.companyId,
        eventType: event.kind,
        title,
        message,
        alertId: `${device.companyId}:${dedupKey}:${now.toISOString()}`,
      }).catch((error) => console.error("Unable to queue port state alert", error));
    }
    const sourceKey = `port-down:${device.id}:${event.ifIndex}`;
    if (currentState === "down") {
      const ticket = await openAutomaticIncidentTicket({
        companyId: device.companyId,
        sourceKey: `${sourceKey}:${now.getTime()}`,
        deviceId: device.id,
        ifIndex: event.ifIndex,
        title: `${device.name} ${label} is down`,
        description: `${label} changed from UP to DOWN.`,
        priority: "high",
      });
      if (ticket.opened) {
        void queueCompanyTicketAlert({
          companyId: device.companyId,
          eventType: "ticket.opened",
          title: ticket.ticket.title,
          message: ticket.ticket.description,
          ticketId: ticket.ticket.id,
          deviceName: device.name,
          deviceIp: device.ipAddress,
          deviceLocation: device.location,
          portDetails: `${label} (ifIndex ${event.ifIndex})`,
          timestamp: now,
        }).catch((error) => console.error("Unable to queue port ticket", error));
      }
    }
    if (currentState === "up") {
      const ticket = await resolveAutomaticIncidentTicket(
        device.companyId,
        `port-down:${device.id}:${event.ifIndex}`,
      );
      if (ticket) {
        void queueCompanyTicketAlert({
          companyId: device.companyId,
          eventType: "ticket.resolved",
          title: ticket.title,
          message: `${label} is UP again. The incident ticket was auto-resolved.`,
          ticketId: ticket.id,
          deviceName: device.name,
          deviceIp: device.ipAddress,
          deviceLocation: device.location,
          portDetails: `${label} (ifIndex ${event.ifIndex})`,
          timestamp: now,
        }).catch((error) => console.error("Unable to queue port ticket resolution", error));
      }
    }
    return;
  }

  if (event.kind === "sfp.removed") {
    const dedupKey = `sfp-removed:${device.id}:${event.ifIndex}`;
    const title = `${device.name} SFP removed from ${label}`;
    const message = `No SFP identity or optical readings are present on ${label}.`;
    const opened = await openAlert({
      companyId: device.companyId,
      deviceId: device.id,
      dedupKey,
      severity: "critical",
      title,
      deviceName: device.name,
      message,
      now,
    });
    if (opened) {
      void queueCompanyAlert({
        companyId: device.companyId,
        eventType: event.kind,
        title,
        message,
        alertId: `${device.companyId}:${dedupKey}:${now.toISOString()}`,
      }).catch((error) => console.error("Unable to queue SFP removal alert", error));
    }
    const ticket = await openAutomaticIncidentTicket({
      companyId: device.companyId,
      sourceKey: `${dedupKey}:${now.getTime()}`,
      deviceId: device.id,
      ifIndex: event.ifIndex,
      title,
      description: message,
      priority: "high",
    });
    if (ticket.opened) {
      void queueCompanyTicketAlert({
        companyId: device.companyId,
        eventType: "ticket.opened",
        title: ticket.ticket.title,
        message: ticket.ticket.description,
        ticketId: ticket.ticket.id,
        deviceName: device.name,
        deviceIp: device.ipAddress,
        deviceLocation: device.location,
        portDetails: `${label} (ifIndex ${event.ifIndex})`,
        timestamp: now,
      }).catch((error) => console.error("Unable to queue SFP ticket", error));
    }
    return;
  }

  if (event.kind === "sfp.inserted") {
    const sourceKey = `sfp-removed:${device.id}:${event.ifIndex}`;
    const ticket = await resolveAutomaticIncidentTicket(device.companyId, sourceKey);
    if (ticket) {
      void queueCompanyTicketAlert({
        companyId: device.companyId,
        eventType: "ticket.resolved",
        title: ticket.title,
        message: `${label} has an SFP detected again. The incident ticket was auto-resolved.`,
        ticketId: ticket.id,
        deviceName: device.name,
        deviceIp: device.ipAddress,
        deviceLocation: device.location,
        portDetails: `${label} (ifIndex ${event.ifIndex})`,
        timestamp: now,
      }).catch((error) => console.error("Unable to queue SFP ticket resolution", error));
    }
    return;
  }

  if (!("previous" in event)) return;
  const metric = event.kind === "sfp.rx.changed" ? "RX" : "TX";
  const dedupKey = `sfp-change:${device.id}:${event.ifIndex}:${metric.toLowerCase()}`;
  const title = `${device.name} ${metric} changed on ${label}`;
  const message = `${label} ${metric} optical power changed from ${event.previous.toFixed(2)} dBm to ${event.current.toFixed(2)} dBm.`;
  const opened = await openAlert({
    companyId: device.companyId,
    deviceId: device.id,
    dedupKey,
    severity: "warning",
    title,
    deviceName: device.name,
    message,
    now,
  });
  if (opened) {
    void queueCompanyAlert({
      companyId: device.companyId,
      eventType: event.kind,
      title,
      message,
      alertId: `${device.companyId}:${dedupKey}:${now.toISOString()}`,
    }).catch((error) => console.error("Unable to queue SFP change alert", error));
  }
}

export async function listActiveAlerts(companyId: string) {
  return db
    .select()
    .from(nmsAlerts)
    .where(and(eq(nmsAlerts.companyId, companyId), sql`${nmsAlerts.resolvedAt} IS NULL`))
    .orderBy(desc(nmsAlerts.updatedAt))
    .limit(100);
}

type AlertInput = {
  companyId: string;
  deviceId: string;
  dedupKey: string;
  severity: string;
  title: string;
  deviceName: string;
  message: string;
  now: Date;
};

async function openAlert(input: AlertInput): Promise<boolean> {
  const existing = await db
    .select({ id: nmsAlerts.id, resolvedAt: nmsAlerts.resolvedAt })
    .from(nmsAlerts)
    .where(and(eq(nmsAlerts.companyId, input.companyId), eq(nmsAlerts.dedupKey, input.dedupKey)))
    .limit(1);
  if (existing[0] && !existing[0].resolvedAt) {
    await db
      .update(nmsAlerts)
      .set({
        severity: input.severity,
        title: input.title,
        deviceName: input.deviceName,
        message: input.message,
        updatedAt: input.now,
      })
      .where(eq(nmsAlerts.id, existing[0].id));
    return false;
  }

  if (existing[0]) {
    await db
      .update(nmsAlerts)
      .set({
        severity: input.severity,
        title: input.title,
        deviceName: input.deviceName,
        message: input.message,
        acknowledged: false,
        resolvedAt: null,
        updatedAt: input.now,
      })
      .where(eq(nmsAlerts.id, existing[0].id));
    return true;
  }

  await db.insert(nmsAlerts).values({
    id: `alert-${crypto.randomUUID()}`,
    companyId: input.companyId,
    deviceId: input.deviceId,
    dedupKey: input.dedupKey,
    severity: input.severity,
    title: input.title,
    deviceName: input.deviceName,
    message: input.message,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return true;
}

async function resolveAlert(companyId: string, dedupKey: string, now: Date): Promise<boolean> {
  const resolved = await db
    .update(nmsAlerts)
    .set({ resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(nmsAlerts.companyId, companyId),
        eq(nmsAlerts.dedupKey, dedupKey),
        sql`${nmsAlerts.resolvedAt} IS NULL`,
      ),
    )
    .returning({ id: nmsAlerts.id });
  return resolved.length > 0;
}

async function syncOpticalAlerts(
  device: { id: string; companyId: string; name: string },
  result: PollResult,
  now: Date,
) {
  const onuLossKey = `pon-onu-loss:${device.id}`;
  if (result.ponCount !== null && result.onuCount === 0) {
    const title = `${device.name} has no online ONUs`;
    const message = `The poll reported ${result.ponCount} PONs but no online ONUs.`;
    const opened = await openAlert({
      companyId: device.companyId,
      deviceId: device.id,
      dedupKey: onuLossKey,
      severity: "warning",
      title,
      deviceName: device.name,
      message,
      now,
    });
    if (opened) {
      void queueCompanyAlert({
        companyId: device.companyId,
        eventType: "threshold.breached",
        title,
        message,
        alertId: `${device.companyId}:${onuLossKey}:${now.toISOString()}`,
      }).catch((error) => console.error("Unable to queue ONU-loss alert", error));
    }
  } else {
    await resolveAlert(device.companyId, onuLossKey, now);
  }

  const settings = await alertSettingsForCompany(device.companyId);
  if (!settings) return;

  if (result.ponTelemetry.length > 0) {
    for (const item of result.ponTelemetry) {
      await syncOpticalMetric({
        companyId: device.companyId,
        deviceId: device.id,
        deviceName: device.name,
        metric: "RX",
        value: item.rxPower,
        low: settings.rxPowerLowThreshold,
        high: settings.rxPowerHighThreshold,
        dedupKey: `onu-optical:${device.id}:${item.ponIndex}:${item.onuIndex}:rx`,
        target: `PON ${item.ponIndex} ONU ${item.onuIndex}`,
        now,
      });
      await syncOpticalMetric({
        companyId: device.companyId,
        deviceId: device.id,
        deviceName: device.name,
        metric: "TX",
        value: item.txPower,
        low: settings.txPowerLowThreshold,
        high: settings.txPowerHighThreshold,
        dedupKey: `onu-optical:${device.id}:${item.ponIndex}:${item.onuIndex}:tx`,
        target: `PON ${item.ponIndex} ONU ${item.onuIndex}`,
        now,
      });
    }
    return;
  }

  await syncOpticalMetric({
    companyId: device.companyId,
    deviceId: device.id,
    deviceName: device.name,
    metric: "RX",
    value: result.rxPower,
    low: settings.rxPowerLowThreshold,
    high: settings.rxPowerHighThreshold,
    dedupKey: `pon-optical:${device.id}:rx`,
    target: "PON optical average",
    now,
  });
  await syncOpticalMetric({
    companyId: device.companyId,
    deviceId: device.id,
    deviceName: device.name,
    metric: "TX",
    value: result.txPower,
    low: settings.txPowerLowThreshold,
    high: settings.txPowerHighThreshold,
    dedupKey: `pon-optical:${device.id}:tx`,
    target: "PON optical average",
    now,
  });
}

async function syncOpticalMetric(input: {
  companyId: string;
  deviceId: string;
  deviceName: string;
  metric: "RX" | "TX";
  value: number | null;
  low: number | null;
  high: number | null;
  dedupKey: string;
  target: string;
  now: Date;
}) {
  const violation =
    input.value !== null &&
    ((input.low !== null && input.value < input.low) || (input.high !== null && input.value > input.high));
  if (!violation) {
    await resolveAlert(input.companyId, input.dedupKey, input.now);
    return;
  }

  const direction = input.low !== null && input.value! < input.low ? "low" : "high";
  const bound = direction === "low" ? input.low : input.high;
  const title = `${input.deviceName} ${input.metric} optical power ${direction}`;
  const message = `${input.target} is reporting ${input.metric} optical power of ${input.value} dBm (threshold ${bound} dBm).`;
  const opened = await openAlert({
    companyId: input.companyId,
    deviceId: input.deviceId,
    dedupKey: input.dedupKey,
    severity: "warning",
    title,
    deviceName: input.deviceName,
    message,
    now: input.now,
  });
  if (opened) {
    void queueCompanyAlert({
      companyId: input.companyId,
      eventType: "threshold.breached",
      title,
      message,
      alertId: `${input.companyId}:${input.dedupKey}:${input.now.toISOString()}`,
    }).catch((error) => console.error("Unable to queue optical threshold alert", error));
  }
}

export async function createDiscoveryJob(input: {
  id: string;
  companyId: string;
  network: string;
  version: string;
  credentialId: string | null;
}) {
  await db.insert(discoveryJobs).values(input);
  return input.id;
}

export async function updateDiscoveryJob(id: string, status: string, discoveredCount: number) {
  await db
    .update(discoveryJobs)
    .set({ status, discoveredCount, updatedAt: new Date() })
    .where(eq(discoveryJobs.id, id));
}

export async function listPollableDevices() {
  return db.select().from(monitoredDevices).where(sql`${monitoredDevices.credentialId} IS NOT NULL`);
}

export async function recordPollerLog(input: {
  companyId: string;
  deviceId: string;
  status: "success" | "failed";
  durationMs: number | null;
  error?: string | null;
}) {
  await db.insert(pollerLogs).values({
    id: `poll-${crypto.randomUUID()}`,
    companyId: input.companyId,
    deviceId: input.deviceId,
    status: input.status,
    durationMs: input.durationMs,
    error: input.error ?? null,
  });
  await db.execute(sql`
    DELETE FROM ${pollerLogs}
    WHERE ${pollerLogs.companyId} = ${input.companyId}
      AND ${pollerLogs.id} NOT IN (
        SELECT ${pollerLogs.id}
        FROM ${pollerLogs}
        WHERE ${pollerLogs.companyId} = ${input.companyId}
        ORDER BY ${pollerLogs.createdAt} DESC
        LIMIT 500
      )
  `);
}

export async function listPollerLogs(companyId: string, limit = 100) {
  return db
    .select({
      id: pollerLogs.id,
      companyId: pollerLogs.companyId,
      deviceId: pollerLogs.deviceId,
      deviceName: monitoredDevices.name,
      ipAddress: monitoredDevices.ipAddress,
      status: pollerLogs.status,
      durationMs: pollerLogs.durationMs,
      error: pollerLogs.error,
      createdAt: pollerLogs.createdAt,
    })
    .from(pollerLogs)
    .innerJoin(monitoredDevices, eq(monitoredDevices.id, pollerLogs.deviceId))
    .where(eq(pollerLogs.companyId, companyId))
    .orderBy(desc(pollerLogs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}