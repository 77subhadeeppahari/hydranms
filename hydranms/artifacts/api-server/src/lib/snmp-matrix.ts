import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import {
  pollDevice,
  supportedSnmpProfiles,
  type PollResult,
  type SnmpCredentialPayload,
} from "./snmp-poller";
import { derivePollState } from "./nms-poll-state";

type CredentialConfig = {
  version: SnmpCredentialPayload["version"];
  communityEnv?: string;
  username?: string;
  usernameEnv?: string;
  authProtocol?: SnmpCredentialPayload["authProtocol"];
  authPasswordEnv?: string;
  privProtocol?: SnmpCredentialPayload["privProtocol"];
  privPasswordEnv?: string;
  securityLevel?: SnmpCredentialPayload["securityLevel"];
  community?: string;
  authPassword?: string;
  privPassword?: string;
};

type MatrixEntry = {
  profile: string;
  target: string;
  vendor?: string;
  type?: string;
  credential: CredentialConfig;
  expect?: {
    interfaces?: boolean;
    pon?: boolean;
    optical?: boolean;
  };
};

type MatrixConfig = {
  checks: MatrixEntry[];
};

const usage = `SNMP lab matrix

Safe preflight (no packets sent):
  pnpm --filter @workspace/scripts snmp:matrix -- --config ./snmp-lab.json

Run configured live checks only after reviewing the targets:
  pnpm --filter @workspace/scripts snmp:matrix -- --config ./snmp-lab.json --live

Run the release-gated live checks (requires an exact approved target list):
  SNMP_LAB_APPROVED_TARGETS=10.0.0.11,10.0.0.12 pnpm --filter @workspace/scripts snmp:release

Credentials must be referenced by environment-variable name in the JSON file.
Plaintext community and password fields are rejected.
`;

function fail(message: string): never {
  throw new Error(message);
}

function requiredEnv(name: string, entry: string): string {
  const value = process.env[name];
  if (!value) fail(`${entry}: environment variable ${name} is not set`);
  return value;
}

function validateCredentialConfig(config: CredentialConfig, entry: string) {
  if (config.community || config.authPassword || config.privPassword) {
    fail(`${entry}: plaintext SNMP secrets are not allowed; use *Env fields`);
  }
  if (config.version === "v1" || config.version === "v2c") {
    if (!config.communityEnv) fail(`${entry}: communityEnv is required for ${config.version}`);
    return;
  }
  if (!config.username && !config.usernameEnv) fail(`${entry}: username or usernameEnv is required for v3`);
  const securityLevel = config.securityLevel ?? "authPriv";
  if (securityLevel !== "noAuthNoPriv" && !config.authPasswordEnv) {
    fail(`${entry}: authPasswordEnv is required for ${securityLevel}`);
  }
  if (securityLevel === "authPriv" && !config.privPasswordEnv) {
    fail(`${entry}: privPasswordEnv is required for authPriv`);
  }
}

function credentialFor(config: CredentialConfig, entry: string): SnmpCredentialPayload {
  validateCredentialConfig(config, entry);
  if (config.version === "v1" || config.version === "v2c") {
    return { version: config.version, community: requiredEnv(config.communityEnv as string, entry) };
  }
  const securityLevel = config.securityLevel ?? "authPriv";
  return {
    version: "v3",
    username: config.username ?? requiredEnv(config.usernameEnv as string, entry),
    authProtocol: config.authProtocol,
    authPassword: config.authPasswordEnv ? requiredEnv(config.authPasswordEnv, entry) : null,
    privProtocol: config.privProtocol,
    privPassword: config.privPasswordEnv ? requiredEnv(config.privPasswordEnv, entry) : null,
    securityLevel,
  };
}

function profileMap() {
  return new Map(supportedSnmpProfiles.map((profile) => [profile.id, profile]));
}

function parseArgs() {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
  return {
    configPath,
    live: process.argv.includes("--live"),
    release: process.argv.includes("--release"),
  };
}

function redactCredentialValues(message: string, config: CredentialConfig) {
  const secretEnvNames = [
    config.communityEnv,
    config.usernameEnv,
    config.authPasswordEnv,
    config.privPasswordEnv,
  ].filter((name): name is string => Boolean(name));
  const secretValues = [
    config.community,
    config.username,
    config.authPassword,
    config.privPassword,
    ...secretEnvNames.map((envName) => process.env[envName]),
  ].filter((value): value is string => Boolean(value));
  return secretValues.reduce(
    (redacted, value) => redacted.split(value).join("[redacted]"),
    message,
  );
}

type MatrixResult = {
  profile: string;
  protocol: SnmpCredentialPayload["version"];
  status: "passed" | "failed";
  detail: string;
};

async function publishResults(results: MatrixResult[]) {
  console.log("\nSNMP live matrix results");
  for (const result of results) {
    console.log(
      `[result] profile=${result.profile} protocol=${result.protocol} status=${result.status} detail=${result.detail}`,
    );
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const markdown = [
    "## SNMP live matrix",
    "",
    "| Profile | Protocol | Result | Detail |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (result) =>
        `| ${result.profile} | ${result.protocol} | ${result.status.toUpperCase()} | ${result.detail.replaceAll("|", "\\|")} |`,
    ),
    "",
  ].join("\n");
  try {
    await appendFile(summaryFile, markdown, "utf8");
  } catch (error) {
    console.error(
      `Unable to publish SNMP matrix job summary: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadConfig(configPath: string): Promise<MatrixConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    fail(`Unable to read SNMP matrix config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as MatrixConfig).checks)) {
    fail("SNMP matrix config must contain a checks array");
  }
  return parsed as MatrixConfig;
}

function checkRetentionState() {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const knownTelemetry: PollResult = {
    sysName: "lab-router",
    sysUpTimeSeconds: 3600,
    systemVersion: "FixtureOS 1.0",
    ramPercent: 42,
    diskPercent: 38,
    interfaces: [
      {
        ifIndex: 1,
        name: "GigabitEthernet1",
        alias: "uplink",
        adminStatus: "up",
        operStatus: "up",
        speedMbps: 1000,
        rxBytes: "100",
        txBytes: "200",
        sfpVendor: null,
        sfpSerialNumber: null,
        opticalRxPower: null,
        opticalTxPower: null,
      },
    ],
    ponCount: null,
    onuCount: null,
    rxPower: null,
    txPower: null,
    ponTelemetry: [],
  };
  const first = derivePollState({ consecutiveFailures: 0, lastSeen: null }, knownTelemetry, true, now);
  assert.equal(first.status, "online");
  assert.deepEqual(first.telemetry?.interfaces, knownTelemetry.interfaces);

  let state = {
    consecutiveFailures: first.consecutiveFailures,
    lastSeen: first.lastSeen,
  };
  for (let miss = 1; miss <= 3; miss += 1) {
    const failed = derivePollState(state, { ...knownTelemetry, interfaces: [] }, false, new Date(now.getTime() + miss * 60_000));
    assert.equal(failed.telemetry, null, "failed polls must not overwrite telemetry");
    state = { consecutiveFailures: failed.consecutiveFailures, lastSeen: failed.lastSeen };
    if (miss < 3) assert.equal(failed.status, "warning");
    else assert.equal(failed.status, "offline");
  }
  assert.equal(state.lastSeen?.toISOString(), now.toISOString(), "last known poll time must be retained");
}

function validateConfig(config: MatrixConfig) {
  const profiles = profileMap();
  if (config.checks.length !== supportedSnmpProfiles.length) {
    fail(`Expected exactly one check per supported profile (${supportedSnmpProfiles.length})`);
  }
  const seen = new Set<string>();
  const versions = new Set<SnmpCredentialPayload["version"]>();
  for (const entry of config.checks) {
    const profile = profiles.get(entry.profile);
    if (!profile) fail(`Unknown profile ${entry.profile}`);
    if (seen.has(entry.profile)) fail(`Duplicate profile ${entry.profile}`);
    seen.add(entry.profile);
    if (!entry.target || entry.target.startsWith("127.0.0.1") || entry.target === "localhost") {
      fail(`${entry.profile}: configure a representative lab target; localhost is not accepted`);
    }
    if (!entry.credential || !entry.credential.version) fail(`${entry.profile}: credential version is required`);
    versions.add(entry.credential.version);
    validateCredentialConfig(entry.credential, entry.profile);
  }
  for (const profile of supportedSnmpProfiles) {
    if (!seen.has(profile.id)) fail(`Missing check for supported profile ${profile.id}`);
  }
  for (const version of ["v1", "v2c", "v3"] as const) {
    if (!versions.has(version)) fail(`SNMP matrix must include at least one ${version} check`);
  }
}

function validateApprovedTargets(config: MatrixConfig) {
  const approvedTargets = new Set(
    (process.env.SNMP_LAB_APPROVED_TARGETS ?? "")
      .split(/[,\s]+/)
      .map((target) => target.trim())
      .filter(Boolean),
  );
  if (approvedTargets.size === 0) {
    fail("SNMP_LAB_APPROVED_TARGETS is required for release runs");
  }
  for (const entry of config.checks) {
    if (!approvedTargets.has(entry.target)) {
      fail(
        `${entry.profile}: target is not in the approved SNMP lab target list`,
      );
    }
  }
}

function validateReadings(entry: MatrixEntry, result: PollResult) {
  const profile = profileMap().get(entry.profile);
  if (!profile) fail(`Unknown profile ${entry.profile}`);
  const expectInterfaces = entry.expect?.interfaces ?? true;
  const expectPon = entry.expect?.pon ?? profile.expectsPon;
  const expectOptical = entry.expect?.optical ?? profile.expectsOptical;
  if (!result.sysName) fail(`${entry.profile}: sysName is missing`);
  if (result.sysUpTimeSeconds === null || result.sysUpTimeSeconds <= 0) {
    fail(`${entry.profile}: sysUpTime is missing or not positive`);
  }
  if (expectInterfaces && result.interfaces.length === 0) fail(`${entry.profile}: no interface rows returned`);
  if (expectPon && (result.ponCount === null || result.ponCount <= 0) && result.ponTelemetry.length === 0) {
    fail(`${entry.profile}: no PON/ONU readings returned`);
  }
  if (expectPon && result.onuCount === null) fail(`${entry.profile}: ONU count is missing`);
  if (
    expectOptical &&
    !result.ponTelemetry.some((item) => item.rxPower !== null || item.txPower !== null)
  ) {
    fail(`${entry.profile}: no optical power readings returned`);
  }
}

async function runLive(config: MatrixConfig) {
  let failures = 0;
  const results: MatrixResult[] = [];
  for (const entry of config.checks) {
    const profile = profileMap().get(entry.profile);
    if (!profile) continue;
    process.stdout.write(
      `[poll] ${entry.profile} (${entry.credential.version}) ... `,
    );
    try {
      const result = await pollDevice(
        {
          ipAddress: entry.target,
          vendor: entry.vendor ?? profile.vendor,
          type: entry.type ?? profile.type,
        },
        credentialFor(entry.credential, entry.profile),
      );
      validateReadings(entry, result);
      const detail = `interfaces=${result.interfaces.length} pon=${result.ponTelemetry.length}`;
      console.log(`ok; ${detail}`);
      results.push({
        profile: entry.profile,
        protocol: entry.credential.version,
        status: "passed",
        detail,
      });
    } catch (error) {
      failures += 1;
      const detail = redactCredentialValues(
        error instanceof Error ? error.message : String(error),
        entry.credential,
      );
      console.log(`failed: ${detail}`);
      results.push({
        profile: entry.profile,
        protocol: entry.credential.version,
        status: "failed",
        detail,
      });
    }
  }
  await publishResults(results);
  if (failures > 0) process.exitCode = 1;
}

async function main() {
  const { configPath, live, release } = parseArgs();
  if (!configPath || process.argv.includes("--help")) {
    console.log(usage);
    if (!configPath) process.exitCode = 2;
    return;
  }
  if (release && !live) fail("--release requires --live");
  const config = await loadConfig(configPath);
  checkRetentionState();
  validateConfig(config);
  if (release) validateApprovedTargets(config);
  console.log(`SNMP matrix preflight passed: ${config.checks.length} profiles, protocols v1/v2c/v3`);
  console.log("Retention check passed: telemetry is retained and status goes offline after 3 misses");
  if (live) await runLive(config);
  else console.log("No packets sent. Add --live only after reviewing every configured target.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});