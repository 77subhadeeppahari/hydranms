import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const snmp = require("net-snmp") as any;

export type SnmpCredentialPayload = {
  version: "v1" | "v2c" | "v3";
  community?: string | null;
  username?: string | null;
  authProtocol?: "md5" | "sha" | "sha224" | "sha256" | "sha384" | "sha512" | null;
  authPassword?: string | null;
  privProtocol?: "des" | "aes" | "aes256b" | "aes256r" | null;
  privPassword?: string | null;
  securityLevel?: "noAuthNoPriv" | "authNoPriv" | "authPriv";
};

export type InterfaceTelemetry = {
  ifIndex: number;
  name: string;
  alias: string | null;
  adminStatus: string | null;
  operStatus: string | null;
  speedMbps: number | null;
  rxBytes: string | null;
  txBytes: string | null;
  sfpVendor: string | null;
  sfpSerialNumber: string | null;
  opticalRxPower: number | null;
  opticalTxPower: number | null;
};

export type PonTelemetry = {
  ponIndex: number;
  onuIndex: number;
  rxPower: number | null;
  txPower: number | null;
};

export type PollResult = {
  sysName: string | null;
  sysUpTimeSeconds: number | null;
  systemVersion: string | null;
  ramPercent: number | null;
  diskPercent: number | null;
  interfaces: InterfaceTelemetry[];
  ponCount: number | null;
  onuCount: number | null;
  rxPower: number | null;
  txPower: number | null;
  ponTelemetry: PonTelemetry[];
};

export type SnmpMibSettings = {
  profile?: string | null;
  ponCountOid?: string | null;
  onuCountOid?: string | null;
  rxPowerRoot?: string | null;
  txPowerRoot?: string | null;
};

type VendorProfile = Omit<SnmpMibSettings, "profile">;

export type SupportedSnmpProfile = {
  id: string;
  label: string;
  vendor: string;
  type: string;
  expectsPon: boolean;
  expectsOptical: boolean;
};

export const supportedSnmpProfiles: readonly SupportedSnmpProfile[] = [
  { id: "cisco", label: "Cisco", vendor: "Cisco", type: "Router", expectsPon: false, expectsOptical: false },
  { id: "zte", label: "ZTE", vendor: "ZTE", type: "OLT", expectsPon: true, expectsOptical: true },
  { id: "vsol", label: "VSOL", vendor: "VSOL", type: "OLT", expectsPon: true, expectsOptical: true },
  {
    id: "mikrotik",
    label: "MikroTik",
    vendor: "MikroTik",
    type: "Router",
    expectsPon: false,
    expectsOptical: false,
  },
  {
    id: "cambium",
    label: "Cambium",
    vendor: "Cambium",
    type: "Wireless",
    expectsPon: false,
    expectsOptical: false,
  },
  { id: "juniper", label: "Juniper", vendor: "Juniper", type: "Router", expectsPon: false, expectsOptical: false },
  { id: "vbng", label: "vBNG", vendor: "vBNG", type: "BNG", expectsPon: false, expectsOptical: false },
  { id: "servers", label: "Servers", vendor: "Server", type: "Server", expectsPon: false, expectsOptical: false },
  { id: "olt", label: "Generic OLT", vendor: "OLT", type: "OLT", expectsPon: true, expectsOptical: true },
] as const;

const standardOids = {
  sysName: "1.3.6.1.2.1.1.5.0",
  sysDescr: "1.3.6.1.2.1.1.1.0",
  sysUpTime: "1.3.6.1.2.1.1.3.0",
  interfaces: "1.3.6.1.2.1.2.2",
};

const mikrotikOpticalTableOid = "1.3.6.1.4.1.14988.1.1.19.1";
const hrStorageTableOid = "1.3.6.1.2.1.25.2.3";

// Vendor roots are intentionally isolated here. Vendors can be extended without changing
// the polling loop, and installations can override an OID through environment variables.
const vendorProfiles: Record<string, VendorProfile> = {
  cisco: {},
  zte: {
    ponCountOid: "1.3.6.1.4.1.3902.1015.3.1.1.1.1.1.0",
    onuCountOid: "1.3.6.1.4.1.3902.1015.3.1.1.1.1.2.0",
    rxPowerRoot: "1.3.6.1.4.1.3902.1015.3.1.1.2.1.10",
    txPowerRoot: "1.3.6.1.4.1.3902.1015.3.1.1.2.1.11",
  },
  vsol: {
    ponCountOid: "1.3.6.1.4.1.37950.1.1.1.1.0",
    onuCountOid: "1.3.6.1.4.1.37950.1.1.1.2.0",
    rxPowerRoot: "1.3.6.1.4.1.37950.1.1.2.1.7",
    txPowerRoot: "1.3.6.1.4.1.37950.1.1.2.1.8",
  },
  mikrotik: {},
  cambium: {},
  juniper: {},
  vbng: {},
  server: {},
  servers: {},
  olt: {},
  genericolt: {},
};

const asString = (value: unknown): string | null =>
  value === undefined || value === null ? null : Buffer.isBuffer(value) ? value.toString() : String(value);

const asNumber = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : Number(asString(value));
  return Number.isFinite(parsed) ? parsed : null;
};

const isVarbindError = (varbind: any): boolean => !varbind || snmp.isVarbindError(varbind);

export type SnmpPollTarget = {
  ipAddress: string;
  vendor: string;
  type: string;
  mibProfile?: string | null;
  ponCountOid?: string | null;
  onuCountOid?: string | null;
  rxPowerRoot?: string | null;
  txPowerRoot?: string | null;
  mibSettings?: SnmpMibSettings | null;
};

export function resolveSnmpMibSettings(target: SnmpPollTarget): VendorProfile {
  const { vendor, type } = target;
  const key = vendor.toLowerCase().replace(/[^a-z0-9]/g, "");
  const typeKey = type.toLowerCase().replace(/[^a-z0-9]/g, "");
  const settings = target.mibSettings ?? {};
  const requestedProfile = (target.mibProfile ?? settings.profile ?? "").trim();
  const selectedProfile = (requestedProfile ? requestedProfile : vendor)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const profile =
    (selectedProfile === "autovendor" ? undefined : vendorProfiles[selectedProfile]) ??
    vendorProfiles[key] ??
    (typeKey.includes("olt") ? vendorProfiles.olt : {});
  return {
    ...profile,
    ponCountOid: process.env.HYDRANMS_PON_COUNT_OID ?? profile.ponCountOid,
    onuCountOid: process.env.HYDRANMS_ONU_COUNT_OID ?? profile.onuCountOid,
    rxPowerRoot: process.env.HYDRANMS_RX_POWER_ROOT ?? profile.rxPowerRoot,
    txPowerRoot: process.env.HYDRANMS_TX_POWER_ROOT ?? profile.txPowerRoot,
    ...(target.ponCountOid ?? settings.ponCountOid
      ? { ponCountOid: target.ponCountOid ?? settings.ponCountOid }
      : {}),
    ...(target.onuCountOid ?? settings.onuCountOid
      ? { onuCountOid: target.onuCountOid ?? settings.onuCountOid }
      : {}),
    ...(target.rxPowerRoot ?? settings.rxPowerRoot
      ? { rxPowerRoot: target.rxPowerRoot ?? settings.rxPowerRoot }
      : {}),
    ...(target.txPowerRoot ?? settings.txPowerRoot
      ? { txPowerRoot: target.txPowerRoot ?? settings.txPowerRoot }
      : {}),
  };
}

function sessionOptions() {
  return {
    port: Number(process.env.SNMP_PORT ?? 161),
    retries: Number(process.env.SNMP_RETRIES ?? 1),
    timeout: Number(process.env.SNMP_TIMEOUT_MS ?? 3000),
  };
}

function createSession(target: string, credential: SnmpCredentialPayload) {
  const options = sessionOptions();
  if (credential.version === "v3") {
    if (!credential.username) throw new Error("SNMPv3 username is required");
    const user = {
      name: credential.username,
      level:
        credential.securityLevel === "noAuthNoPriv"
          ? snmp.SecurityLevel.noAuthNoPriv
          : credential.securityLevel === "authNoPriv"
            ? snmp.SecurityLevel.authNoPriv
            : snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols[credential.authProtocol ?? "sha"],
      authKey: credential.authPassword ?? "",
      privProtocol: snmp.PrivProtocols[credential.privProtocol ?? "aes"],
      privKey: credential.privPassword ?? "",
    };
    return snmp.createV3Session(target, user, { ...options, version: snmp.Version3 });
  }
  if (!credential.community) throw new Error("SNMP community is required for SNMPv1/v2c");
  return snmp.createSession(target, credential.community, {
    ...options,
    version: credential.version === "v1" ? snmp.Version1 : snmp.Version2c,
  });
}

function get(session: any, oids: string[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    session.get(oids, (error: Error | null, varbinds: any[]) => {
      if (error) reject(error);
      else resolve(varbinds);
    });
  });
}

function tableColumns(session: any, oid: string, columns: number[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    session.tableColumns(oid, columns, (error: Error | null, table: Record<string, any>) => {
      if (error) reject(error);
      else resolve(table ?? {});
    });
  });
}

function walk(session: any, oid: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const values: any[] = [];
    session.walk(
      oid,
      20,
      (varbinds: any[]) => {
        values.push(...varbinds);
      },
      (error: Error | null) => (error ? reject(error) : resolve(values)),
    );
  });
}

async function optionalGet(session: any, oid: string | null | undefined): Promise<number | null> {
  if (!oid) return null;
  try {
    const [varbind] = await get(session, [oid]);
    return isVarbindError(varbind) ? null : asNumber(varbind.value);
  } catch {
    return null;
  }
}

function storageColumn(row: unknown, column: number, position: number): unknown {
  if (Array.isArray(row)) return row[position];
  return (row as Record<string, unknown> | null)?.[column] ?? (row as Record<string, unknown> | null)?.[String(column)];
}

function storageTypeMatches(value: unknown, type: number): boolean {
  const normalized = asString(value)?.split(".").at(-1);
  return normalized === String(type);
}

async function storageUsage(session: any): Promise<{ ramPercent: number | null; diskPercent: number | null }> {
  try {
    const table = await tableColumns(session, hrStorageTableOid, [2, 4, 5, 6]);
    const totals = {
      ram: { size: 0, used: 0 },
      disk: { size: 0, used: 0 },
    };
    for (const row of Object.values(table)) {
      const storageType = storageColumn(row, 2, 0);
      const units = asNumber(storageColumn(row, 4, 1));
      const size = asNumber(storageColumn(row, 5, 2));
      const used = asNumber(storageColumn(row, 6, 3));
      if (units === null || size === null || used === null || size <= 0) continue;
      const bucket = storageTypeMatches(storageType, 2) ? totals.ram : storageTypeMatches(storageType, 4) ? totals.disk : null;
      if (!bucket) continue;
      bucket.size += units * size;
      bucket.used += units * used;
    }
    const percent = (bucket: { size: number; used: number }) =>
      bucket.size > 0 ? Math.min(100, Math.max(0, (bucket.used / bucket.size) * 100)) : null;
    return { ramPercent: percent(totals.ram), diskPercent: percent(totals.disk) };
  } catch {
    return { ramPercent: null, diskPercent: null };
  }
}

function normalizeInterface(
  index: string,
  row: any,
  optical?: {
    sfpVendor: string | null;
    sfpSerialNumber: string | null;
    opticalRxPower: number | null;
    opticalTxPower: number | null;
  },
): InterfaceTelemetry {
  const values = Array.isArray(row) ? row : [];
  const valueFor = (column: number, position: number): unknown =>
    Array.isArray(row) ? values[position] : row?.[column] ?? row?.[String(column)];
  return {
    ifIndex: Number(index),
    name: asString(valueFor(2, 0)) ?? `if${index}`,
    alias: asString(valueFor(18, 1)),
    adminStatus: asString(valueFor(7, 2)),
    operStatus: asString(valueFor(8, 3)),
    speedMbps:
      asNumber(valueFor(5, 4)) === null ? null : (asNumber(valueFor(5, 4)) ?? 0) / 1_000_000,
    rxBytes: asString(valueFor(10, 5)),
    txBytes: asString(valueFor(16, 6)),
    sfpVendor: optical?.sfpVendor ?? null,
    sfpSerialNumber: optical?.sfpSerialNumber ?? null,
    opticalRxPower: optical?.opticalRxPower ?? null,
    opticalTxPower: optical?.opticalTxPower ?? null,
  };
}

async function mikrotikOpticalTelemetry(
  session: any,
): Promise<
  Map<
    number,
    {
      sfpVendor: string | null;
      sfpSerialNumber: string | null;
      opticalRxPower: number | null;
      opticalTxPower: number | null;
    }
  >
> {
  try {
    const table = await tableColumns(session, mikrotikOpticalTableOid, [9, 10, 11, 12]);
    const result = new Map<
      number,
      {
        sfpVendor: string | null;
        sfpSerialNumber: string | null;
        opticalRxPower: number | null;
        opticalTxPower: number | null;
      }
    >();
    for (const [index, row] of Object.entries(table)) {
      const values = Array.isArray(row) ? row : [];
      const valueFor = (column: number, position: number): unknown =>
        Array.isArray(row) ? values[position] : (row as Record<string, unknown>)?.[column] ?? (row as Record<string, unknown>)?.[String(column)];
      const sfpVendor = asString(valueFor(11, 2));
      const sfpSerialNumber = asString(valueFor(12, 3));
      const txPower = asNumber(valueFor(9, 0));
      const rxPower = asNumber(valueFor(10, 1));
      const ifIndex = Number(index);
      if (!Number.isFinite(ifIndex)) continue;
      result.set(ifIndex, {
        sfpVendor,
        sfpSerialNumber,
        opticalRxPower: rxPower === null ? null : rxPower / 1000,
        opticalTxPower: txPower === null ? null : txPower / 1000,
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

async function opticalTelemetry(
  session: any,
  rxRoot: string | null | undefined,
  txRoot: string | null | undefined,
): Promise<PonTelemetry[]> {
  if (!rxRoot && !txRoot) return [];
  const [rxValues, txValues] = await Promise.all([
    rxRoot ? walk(session, rxRoot).catch(() => []) : Promise.resolve([]),
    txRoot ? walk(session, txRoot).catch(() => []) : Promise.resolve([]),
  ]);
  const byKey = new Map<string, PonTelemetry>();
  for (const entry of rxValues) {
    const suffix = String(entry.oid).split(".").slice(-2);
    const key = suffix.join(".");
    byKey.set(key, {
      ponIndex: Number(suffix[0]) || 0,
      onuIndex: Number(suffix[1]) || 0,
      rxPower: asNumber(entry.value),
      txPower: null,
    });
  }
  for (const entry of txValues) {
    const suffix = String(entry.oid).split(".").slice(-2);
    const key = suffix.join(".");
    const current = byKey.get(key) ?? {
      ponIndex: Number(suffix[0]) || 0,
      onuIndex: Number(suffix[1]) || 0,
      rxPower: null,
      txPower: null,
    };
    current.txPower = asNumber(entry.value);
    byKey.set(key, current);
  }
  return [...byKey.values()].filter((item) => item.ponIndex > 0 && item.onuIndex > 0);
}

export async function pollDevice(
  target: SnmpPollTarget,
  credential: SnmpCredentialPayload,
): Promise<PollResult> {
  const session = createSession(target.ipAddress, credential);
  try {
    const profile = resolveSnmpMibSettings(target);
    const [system, interfaceTable, ponCount, onuCount, ponTelemetry, opticalInterfaces, storage] = await Promise.all([
      get(session, [standardOids.sysName, standardOids.sysDescr, standardOids.sysUpTime]),
      tableColumns(session, standardOids.interfaces, [2, 18, 7, 8, 5, 10, 16]).catch(() => ({})),
      optionalGet(session, profile.ponCountOid),
      optionalGet(session, profile.onuCountOid),
      opticalTelemetry(session, profile.rxPowerRoot, profile.txPowerRoot),
      target.vendor.toLowerCase().replace(/[^a-z0-9]/g, "") === "mikrotik"
        ? mikrotikOpticalTelemetry(session)
        : Promise.resolve(new Map()),
      storageUsage(session),
    ]);
    const interfaces = Object.entries(interfaceTable).map(([index, row]) =>
      normalizeInterface(index, row, opticalInterfaces.get(Number(index))),
    );
    const rxPowers = ponTelemetry.map((item) => item.rxPower).filter((value): value is number => value !== null);
    const txPowers = ponTelemetry.map((item) => item.txPower).filter((value): value is number => value !== null);
    return {
      sysName: isVarbindError(system[0]) ? null : asString(system[0]?.value),
      systemVersion: isVarbindError(system[1]) ? null : asString(system[1]?.value),
      sysUpTimeSeconds:
        isVarbindError(system[2]) || asNumber(system[2]?.value) === null
          ? null
          : (asNumber(system[2]?.value) ?? 0) / 100,
      ramPercent: storage.ramPercent,
      diskPercent: storage.diskPercent,
      interfaces,
      ponCount,
      onuCount: onuCount ?? (ponTelemetry.length ? ponTelemetry.length : null),
      rxPower: rxPowers.length ? rxPowers.reduce((sum, value) => sum + value, 0) / rxPowers.length : null,
      txPower: txPowers.length ? txPowers.reduce((sum, value) => sum + value, 0) / txPowers.length : null,
      ponTelemetry,
    };
  } finally {
    session.close();
  }
}

export async function probeDevice(
  ipAddress: string,
  credential: SnmpCredentialPayload,
): Promise<{ sysName: string | null; sysUpTimeSeconds: number | null }> {
  const session = createSession(ipAddress, credential);
  try {
    const values = await get(session, [standardOids.sysName, standardOids.sysUpTime]);
    return {
      sysName: isVarbindError(values[0]) ? null : asString(values[0]?.value),
      sysUpTimeSeconds: isVarbindError(values[1]) ? null : (asNumber(values[1]?.value) ?? 0) / 100,
    };
  } finally {
    session.close();
  }
}