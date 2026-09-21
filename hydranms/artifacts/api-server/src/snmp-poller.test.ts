import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pollDevice, resolveSnmpMibSettings, type SnmpCredentialPayload } from "./lib/snmp-poller";

const require = createRequire(import.meta.url);
const snmp = require("net-snmp") as any;

type FixtureValue = {
  value?: unknown;
  error?: string;
};

type SnmpFixture = {
  profile: string;
  protocol: SnmpCredentialPayload["version"];
  get: Record<string, FixtureValue>;
  table?: Record<string, unknown>;
  tables?: Record<string, Record<string, unknown>>;
  tableError?: string;
  walk: Record<string, Array<FixtureValue & { oid: string }> | { error: string }>;
};

type SessionCapture =
  | { kind: "v1" | "v2c"; target: string; community: string; options: Record<string, unknown> }
  | { kind: "v3"; target: string; user: Record<string, unknown>; options: Record<string, unknown> };

type SessionCall =
  | { method: "get"; oids: string[] }
  | { method: "tableColumns"; oid: string; columns: number[] }
  | { method: "walk"; oid: string };

function fixturePath(name: string) {
  return new URL(`../test/fixtures/${name}.json`, import.meta.url);
}

async function loadFixture(name: string): Promise<SnmpFixture> {
  return JSON.parse(await readFile(fixturePath(name), "utf8")) as SnmpFixture;
}

function varbind(oid: string, fixtureValue: FixtureValue) {
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

function fixtureSession(
  fixture: SnmpFixture,
  calls?: SessionCall[],
  onClose?: () => void,
) {
  const respond = (callback: () => void) => {
    if (calls) queueMicrotask(callback);
    else callback();
  };

  return {
    get(oids: string[], callback: (error: Error | null, values: unknown[]) => void) {
      calls?.push({ method: "get", oids: [...oids] });
      respond(() =>
        callback(
          null,
          oids.map((oid) => varbind(oid, fixture.get[oid] ?? { error: "NoSuchInstance" })),
        ),
      );
    },
    tableColumns(
      oid: string,
      columns: number[],
      callback: (error: Error | null, table: Record<string, unknown>) => void,
    ) {
      calls?.push({ method: "tableColumns", oid, columns: [...columns] });
      respond(() => {
        if (fixture.tableError) callback(new Error(fixture.tableError), {});
        else callback(null, fixture.tables?.[oid] ?? fixture.table ?? {});
      });
    },
    walk(
      oid: string,
      _maxRepetitions: number,
      onVarbind: (values: unknown[]) => void,
      done: (error: Error | null) => void,
    ) {
      calls?.push({ method: "walk", oid });
      respond(() => {
        const response = fixture.walk[oid];
        if (!response) return done(null);
        if (!Array.isArray(response)) return done(new Error(response.error));
        for (const item of response) onVarbind([varbind(item.oid, item)]);
        done(null);
      });
    },
    close() {
      onClose?.();
    },
  };
}

async function pollFixture(
  name: string,
  credential: SnmpCredentialPayload,
): Promise<{ result: Awaited<ReturnType<typeof pollDevice>>; capture: SessionCapture }> {
  const fixture = await loadFixture(name);
  let capture: SessionCapture | undefined;
  const originalCreateSession = snmp.createSession;
  const originalCreateV3Session = snmp.createV3Session;
  snmp.createSession = (target: string, community: string, options: Record<string, unknown>) => {
    if (credential.version === "v3") {
      throw new Error(`${fixture.profile}: v3 used the community session factory`);
    }
    capture = {
      kind: credential.version,
      target,
      community,
      options,
    };
    return fixtureSession(fixture);
  };
  snmp.createV3Session = (
    target: string,
    user: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    capture = { kind: "v3", target, user, options };
    return fixtureSession(fixture);
  };
  try {
    const result = await pollDevice(
      {
        ipAddress: `fixture-${fixture.profile}`,
        vendor: fixture.profile === "vsol" ? "VSOL" : fixture.profile.toUpperCase(),
        type: fixture.profile === "cisco" ? "Router" : "OLT",
      },
      credential,
    );
    if (!capture) throw new Error(`${fixture.profile}: no SNMP session was created`);
    return { result, capture };
  } finally {
    snmp.createSession = originalCreateSession;
    snmp.createV3Session = originalCreateV3Session;
  }
}

test("resolves OID settings independently for mixed OLT vendors", () => {
  const zte = resolveSnmpMibSettings({
    ipAddress: "10.0.0.1",
    vendor: "ZTE",
    type: "OLT",
    mibProfile: "zte",
    ponCountOid: "1.3.6.1.4.1.3902.99.1",
  });
  const vsol = resolveSnmpMibSettings({
    ipAddress: "10.0.0.2",
    vendor: "VSOL",
    type: "OLT",
  });

  assert.equal(zte.ponCountOid, "1.3.6.1.4.1.3902.99.1");
  assert.equal(vsol.ponCountOid, "1.3.6.1.4.1.37950.1.1.1.1.0");
  assert.notEqual(zte.rxPowerRoot, vsol.rxPowerRoot);
});

test("keeps environment overrides compatible while allowing device overrides", () => {
  const previous = process.env.HYDRANMS_PON_COUNT_OID;
  process.env.HYDRANMS_PON_COUNT_OID = "1.3.6.1.4.1.999.1";
  try {
    const environmentConfigured = resolveSnmpMibSettings({
      ipAddress: "10.0.0.3",
      vendor: "ZTE",
      type: "OLT",
    });
    const deviceConfigured = resolveSnmpMibSettings({
      ipAddress: "10.0.0.4",
      vendor: "ZTE",
      type: "OLT",
      ponCountOid: "1.3.6.1.4.1.999.2",
    });

    assert.equal(environmentConfigured.ponCountOid, "1.3.6.1.4.1.999.1");
    assert.equal(deviceConfigured.ponCountOid, "1.3.6.1.4.1.999.2");
  } finally {
    if (previous === undefined) delete process.env.HYDRANMS_PON_COUNT_OID;
    else process.env.HYDRANMS_PON_COUNT_OID = previous;
  }
});

test("isolates OID settings across concurrent ZTE and VSOL poll sessions", async () => {
  const [zteFixture, vsolFixture] = await Promise.all([
    loadFixture("zte-v2c"),
    loadFixture("vsol-v3"),
  ]);
  const captures = new Map<
    string,
    { calls: SessionCall[]; closed: boolean; kind: "v2c" | "v3" }
  >();
  const originalCreateSession = snmp.createSession;
  const originalCreateV3Session = snmp.createV3Session;
  let activeSessions = 0;
  let maxActiveSessions = 0;
  const oidEnvironmentKeys = [
    "HYDRANMS_PON_COUNT_OID",
    "HYDRANMS_ONU_COUNT_OID",
    "HYDRANMS_RX_POWER_ROOT",
    "HYDRANMS_TX_POWER_ROOT",
  ] as const;
  const previousEnvironment = Object.fromEntries(
    oidEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of oidEnvironmentKeys) delete process.env[key];

  snmp.createSession = (target: string, community: string, options: Record<string, unknown>) => {
    assert.equal(target, "fixture-concurrent-zte");
    assert.equal(community, "fixture-zte");
    captures.set(target, { calls: [], closed: false, kind: "v2c" });
    const capture = captures.get(target)!;
    activeSessions += 1;
    maxActiveSessions = Math.max(maxActiveSessions, activeSessions);
    return fixtureSession(zteFixture, capture.calls, () => {
      capture.closed = true;
      activeSessions -= 1;
    });
  };
  snmp.createV3Session = (
    target: string,
    user: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    assert.equal(target, "fixture-concurrent-vsol");
    assert.equal(user.name, "fixture-vsol-user");
    captures.set(target, { calls: [], closed: false, kind: "v3" });
    const capture = captures.get(target)!;
    activeSessions += 1;
    maxActiveSessions = Math.max(maxActiveSessions, activeSessions);
    return fixtureSession(vsolFixture, capture.calls, () => {
      capture.closed = true;
      activeSessions -= 1;
    });
  };

  try {
    const [zteResult, vsolResult] = await Promise.all([
      pollDevice(
        {
          ipAddress: "fixture-concurrent-zte",
          vendor: "ZTE",
          type: "OLT",
          mibProfile: "zte",
        },
        { version: "v2c", community: "fixture-zte" },
      ),
      pollDevice(
        {
          ipAddress: "fixture-concurrent-vsol",
          vendor: "VSOL",
          type: "OLT",
          mibProfile: "vsol",
        },
        {
          version: "v3",
          username: "fixture-vsol-user",
          authPassword: "fixture-auth",
          privPassword: "fixture-priv",
          securityLevel: "authPriv",
        },
      ),
    ]);

    const zteCapture = captures.get("fixture-concurrent-zte");
    const vsolCapture = captures.get("fixture-concurrent-vsol");
    assert.ok(zteCapture, "ZTE session was captured");
    assert.ok(vsolCapture, "VSOL session was captured");
    assert.equal(zteCapture.closed, true, "ZTE session was closed");
    assert.equal(vsolCapture.closed, true, "VSOL session was closed");
    assert.equal(maxActiveSessions, 2, "both vendor sessions overlapped before either completed");

    const zteGets = zteCapture.calls.filter(
      (call): call is Extract<SessionCall, { method: "get" }> => call.method === "get",
    );
    const zteWalks = zteCapture.calls.filter(
      (call): call is Extract<SessionCall, { method: "walk" }> => call.method === "walk",
    );
    const vsolGets = vsolCapture.calls.filter(
      (call): call is Extract<SessionCall, { method: "get" }> => call.method === "get",
    );
    const vsolWalks = vsolCapture.calls.filter(
      (call): call is Extract<SessionCall, { method: "walk" }> => call.method === "walk",
    );

    assert.deepEqual(
      zteGets.map((call) => call.oids),
      [
        ["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.3.0"],
        ["1.3.6.1.4.1.3902.1015.3.1.1.1.1.1.0"],
        ["1.3.6.1.4.1.3902.1015.3.1.1.1.1.2.0"],
      ],
      "ZTE receives only system, ZTE count, and ZTE ONU OIDs",
    );
    assert.deepEqual(
      zteWalks.map((call) => call.oid).sort(),
      [
        "1.3.6.1.4.1.3902.1015.3.1.1.2.1.10",
        "1.3.6.1.4.1.3902.1015.3.1.1.2.1.11",
      ].sort(),
      "ZTE receives only ZTE optical roots",
    );
    assert.deepEqual(
      vsolGets.map((call) => call.oids),
      [
        ["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.3.0"],
        ["1.3.6.1.4.1.37950.1.1.1.1.0"],
        ["1.3.6.1.4.1.37950.1.1.1.2.0"],
      ],
      "VSOL receives only system, VSOL count, and VSOL ONU OIDs",
    );
    assert.deepEqual(
      vsolWalks.map((call) => call.oid).sort(),
      [
        "1.3.6.1.4.1.37950.1.1.2.1.7",
        "1.3.6.1.4.1.37950.1.1.2.1.8",
      ].sort(),
      "VSOL receives only VSOL optical roots",
    );
    assert.equal(zteResult.ponCount, 4, "ZTE result came from the ZTE fixture");
    assert.equal(vsolResult.ponCount, 2, "VSOL result came from the VSOL fixture");
  } finally {
    snmp.createSession = originalCreateSession;
    snmp.createV3Session = originalCreateV3Session;
    for (const key of oidEnvironmentKeys) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Cisco v1 fixture parses identity, interfaces, and counters without network access", async () => {
  const { result, capture } = await pollFixture("cisco-v1", {
    version: "v1",
    community: "fixture-read",
  });

  assert.equal(capture.kind, "v1", "Cisco fixture: credential protocol");
  assert.equal(capture.options.version, snmp.Version1, "Cisco fixture: SNMP version");
  assert.equal(capture.community, "fixture-read", "Cisco fixture: community");
  assert.equal(result.sysName, "edge-cisco-01", "Cisco fixture: system identity");
  assert.equal(result.sysUpTimeSeconds, 9876.54, "Cisco fixture: system uptime");
  assert.equal(result.interfaces.length, 2, "Cisco fixture: interface rows");
  assert.equal(result.interfaces[0]?.speedMbps, 1000, "Cisco fixture: interface speed");
  assert.equal(result.interfaces[0]?.rxBytes, "123456789", "Cisco fixture: interface RX counter");
  assert.deepEqual(result.ponTelemetry, [], "Cisco fixture: no PON telemetry");
});

test("ZTE v2c fixture parses PON and optical readings without network access", async () => {
  const { result, capture } = await pollFixture("zte-v2c", {
    version: "v2c",
    community: "fixture-public",
  });

  assert.equal(capture.kind, "v2c", "ZTE fixture: credential protocol");
  assert.equal(capture.options.version, snmp.Version2c, "ZTE fixture: SNMP version");
  assert.equal(capture.community, "fixture-public", "ZTE fixture: community");
  assert.equal(result.sysName, "zte-olt-01", "ZTE fixture: system identity");
  assert.equal(result.sysUpTimeSeconds, 4321, "ZTE fixture: integer system uptime");
  assert.equal(result.ponCount, 4, "ZTE fixture: PON count");
  assert.equal(result.onuCount, 8, "ZTE fixture: ONU count");
  assert.equal(result.ponTelemetry.length, 2, "ZTE fixture: optical row count");
  assert.equal(result.ponTelemetry[0]?.rxPower, -18.5, "ZTE fixture: RX optical power");
  assert.equal(result.ponTelemetry[0]?.txPower, 2.3, "ZTE fixture: TX optical power");
  assert.equal(result.rxPower, -18.75, "ZTE fixture: average RX optical power");
  assert.equal(result.txPower, 2.2, "ZTE fixture: average TX optical power");
});

test("MikroTik fixture maps SFP name and optical power to interface telemetry", async () => {
  const { result } = await pollFixture("mikrotik-optical", {
    version: "v2c",
    community: "fixture-mikrotik",
  });
  const sfpInterface = result.interfaces.find((item) => item.ifIndex === 3);

  assert.ok(sfpInterface, "MikroTik fixture: SFP interface");
  assert.equal(sfpInterface.sfpVendor, "MikroTik");
  assert.equal(sfpInterface.sfpSerialNumber, "S31DLC10D123456");
  assert.equal(sfpInterface.opticalRxPower, -12.75);
  assert.equal(sfpInterface.opticalTxPower, 1.25);
});

test("VSOL v3 fixture preserves authPriv credential settings without network access", async () => {
  const { result, capture } = await pollFixture("vsol-v3", {
    version: "v3",
    username: "fixture-user",
    authProtocol: "sha256",
    authPassword: "fixture-auth",
    privProtocol: "aes256b",
    privPassword: "fixture-priv",
    securityLevel: "authPriv",
  });

  assert.equal(capture.kind, "v3", "VSOL fixture: credential protocol");
  assert.equal(capture.options.version, snmp.Version3, "VSOL fixture: SNMP version");
  assert.equal(capture.user.name, "fixture-user", "VSOL fixture: username");
  assert.equal(capture.user.level, snmp.SecurityLevel.authPriv, "VSOL fixture: security level");
  assert.equal(capture.user.authProtocol, snmp.AuthProtocols.sha256, "VSOL fixture: auth protocol");
  assert.equal(capture.user.privProtocol, snmp.PrivProtocols.aes256b, "VSOL fixture: privacy protocol");
  assert.equal(result.sysName, "vsol-olt-02", "VSOL fixture: system identity");
  assert.equal(result.ponCount, 2, "VSOL fixture: PON count");
  assert.equal(result.ponTelemetry[0]?.rxPower, -16.25, "VSOL fixture: RX optical power");
  assert.equal(result.ponTelemetry[0]?.txPower, 1.75, "VSOL fixture: TX optical power");
});

test("ZTE partial/error fixture keeps affected readings null and does not shift system fields", async () => {
  const { result } = await pollFixture("zte-partial-errors", {
    version: "v2c",
    community: "fixture-public",
  });

  assert.equal(result.sysName, null, "ZTE partial fixture: system identity error");
  assert.equal(result.sysUpTimeSeconds, null, "ZTE partial fixture: malformed uptime");
  assert.deepEqual(result.interfaces, [], "ZTE partial fixture: interface timeout");
  assert.equal(result.ponCount, null, "ZTE partial fixture: PON count error");
  assert.equal(result.onuCount, null, "ZTE partial fixture: malformed ONU count");
  assert.equal(result.rxPower, null, "ZTE partial fixture: RX optical error");
  assert.equal(result.txPower, null, "ZTE partial fixture: TX optical error");
  assert.deepEqual(result.ponTelemetry, [], "ZTE partial fixture: no fabricated optical rows");
});