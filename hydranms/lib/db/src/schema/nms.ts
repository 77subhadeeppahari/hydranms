import { createInsertSchema } from "drizzle-zod";
import { boolean, index, integer, pgTable, real, text, timestamp, unique } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

/**
 * Interface and ONU samples are retained for 30 days. This is longer than the
 * largest supported history window (7 days), so cleanup never removes data a
 * user can request from the history API.
 */
export const TELEMETRY_HISTORY_RETENTION_DAYS = 30;

export const snmpCredentials = pgTable(
  "snmp_credentials",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    label: text("label").notNull(),
    version: text("version").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("snmp_credentials_company_label_unique").on(table.companyId, table.label)],
);

export const pollerLogs = pgTable(
  "poller_logs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    deviceId: text("device_id").notNull(),
    status: text("status").notNull(),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("poller_logs_company_created_index").on(table.companyId, table.createdAt),
    index("poller_logs_device_created_index").on(table.deviceId, table.createdAt),
  ],
);

export const monitoredDevices = pgTable(
  "monitored_devices",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    name: text("name").notNull(),
    ipAddress: text("ip_address").notNull(),
    vendor: text("vendor").notNull(),
    type: text("type").notNull(),
    location: text("location").notNull(),
    credentialId: text("credential_id"),
    mibProfile: text("mib_profile"),
    ponCountOid: text("pon_count_oid"),
    onuCountOid: text("onu_count_oid"),
    rxPowerRoot: text("rx_power_root"),
    txPowerRoot: text("tx_power_root"),
    status: text("status").notNull().default("discovering"),
    uptimePercent: real("uptime_percent").notNull().default(0),
    interfaceCount: integer("interface_count").notNull().default(0),
    // SNMP sysUpTime is reported in hundredths of a second, so the seconds
    // conversion can be fractional and must not be truncated on persistence.
    sysUpTimeSeconds: real("sys_uptime_seconds"),
    systemVersion: text("system_version"),
    ramPercent: real("ram_percent"),
    diskPercent: real("disk_percent"),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
    lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    ponCount: integer("pon_count"),
    onuCount: integer("onu_count"),
    rxPower: real("rx_power"),
    txPower: real("tx_power"),
    cliProtocol: text("cli_protocol"),
    sshPort: integer("ssh_port"),
    telnetPort: integer("telnet_port"),
    cliUsername: text("cli_username"),
    encryptedCliPassword: text("encrypted_cli_password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("monitored_devices_company_ip_unique").on(table.companyId, table.ipAddress),
    index("monitored_devices_company_index").on(table.companyId),
  ],
);

export const deviceInterfaces = pgTable(
  "device_interfaces",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    ifIndex: integer("if_index").notNull(),
    name: text("name").notNull(),
    alias: text("alias"),
    adminStatus: text("admin_status"),
    operStatus: text("oper_status"),
    speedMbps: real("speed_mbps"),
    rxBytes: text("rx_bytes"),
    txBytes: text("tx_bytes"),
    sfpVendor: text("sfp_vendor"),
    sfpSerialNumber: text("sfp_serial_number"),
    opticalRxPower: real("optical_rx_power"),
    opticalTxPower: real("optical_tx_power"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("device_interfaces_device_index_unique").on(table.deviceId, table.ifIndex)],
);

export const deviceInterfaceSamples = pgTable(
  "device_interface_samples",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    ifIndex: integer("if_index").notNull(),
    name: text("name").notNull(),
    rxBytes: text("rx_bytes"),
    txBytes: text("tx_bytes"),
    // Rows older than TELEMETRY_HISTORY_RETENTION_DAYS are pruned by the NMS worker.
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("device_interface_samples_device_time_index").on(table.deviceId, table.sampledAt),
    index("device_interface_samples_interface_time_index").on(table.deviceId, table.ifIndex, table.sampledAt),
  ],
);

export const ponTelemetry = pgTable(
  "pon_telemetry",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    ponIndex: integer("pon_index").notNull(),
    onuIndex: integer("onu_index").notNull(),
    rxPower: real("rx_power"),
    txPower: real("tx_power"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("pon_telemetry_device_pon_onu_unique").on(table.deviceId, table.ponIndex, table.onuIndex),
  ],
);

export const ponTelemetrySamples = pgTable(
  "pon_telemetry_samples",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    ponIndex: integer("pon_index").notNull(),
    onuIndex: integer("onu_index").notNull(),
    rxPower: real("rx_power"),
    txPower: real("tx_power"),
    // Rows older than TELEMETRY_HISTORY_RETENTION_DAYS are pruned by the NMS worker.
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("pon_telemetry_samples_device_time_index").on(table.deviceId, table.sampledAt),
    index("pon_telemetry_samples_onu_time_index").on(
      table.deviceId,
      table.ponIndex,
      table.onuIndex,
      table.sampledAt,
    ),
  ],
);

export const nmsAlerts = pgTable(
  "nms_alerts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    deviceId: text("device_id").notNull(),
    dedupKey: text("dedup_key").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    deviceName: text("device_name").notNull(),
    message: text("message").notNull(),
    acknowledged: boolean("acknowledged").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("nms_alerts_company_dedup_unique").on(table.companyId, table.dedupKey),
    index("nms_alerts_company_updated_index").on(table.companyId, table.updatedAt),
  ],
);

export const discoveryJobs = pgTable(
  "discovery_jobs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    network: text("network").notNull(),
    version: text("version").notNull(),
    credentialId: text("credential_id"),
    status: text("status").notNull().default("queued"),
    discoveredCount: integer("discovered_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("discovery_jobs_company_index").on(table.companyId, table.createdAt)],
);

export const insertSnmpCredentialSchema = createInsertSchema(snmpCredentials);
export const insertMonitoredDeviceSchema = createInsertSchema(monitoredDevices);
export const insertDeviceInterfaceSchema = createInsertSchema(deviceInterfaces);
export const insertPonTelemetrySchema = createInsertSchema(ponTelemetry);
export const insertNmsAlertSchema = createInsertSchema(nmsAlerts);
export const insertDiscoveryJobSchema = createInsertSchema(discoveryJobs);

export type SnmpCredential = typeof snmpCredentials.$inferSelect;
export type MonitoredDevice = typeof monitoredDevices.$inferSelect;
export type DeviceInterface = typeof deviceInterfaces.$inferSelect;
export type PonTelemetry = typeof ponTelemetry.$inferSelect;
export type NmsAlert = typeof nmsAlerts.$inferSelect;
export type DiscoveryJob = typeof discoveryJobs.$inferSelect;

export const snmpVersionSchema = z.enum(["v1", "v2c", "v3"]);
export type SnmpVersion = z.infer<typeof snmpVersionSchema>;