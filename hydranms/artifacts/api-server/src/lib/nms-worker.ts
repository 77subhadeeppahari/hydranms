import {
  credentialById,
  credentialByLabel,
  listPollableDevices,
  pruneTelemetryHistory,
  recordPoll,
  recordPollerLog,
  updateDiscoveryJob,
  upsertDevice,
} from "./nms-store";
import { pollDevice, probeDevice, type PollResult } from "./snmp-poller";

const emptyPollResult: PollResult = {
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

let telemetryCleanupPromise: Promise<void> | null = null;

function scheduleTelemetryCleanup(): void {
  if (telemetryCleanupPromise) return;
  telemetryCleanupPromise = pruneTelemetryHistory()
    .then(({ interfaceSamples, ponTelemetrySamples }) => {
      const deleted = interfaceSamples + ponTelemetrySamples;
      if (deleted > 0) {
        console.info(
          `Pruned ${deleted} telemetry history samples older than the retention period`,
        );
      }
    })
    .catch((error) => {
      console.error("Telemetry history cleanup failed", error);
    })
    .finally(() => {
      telemetryCleanupPromise = null;
    });
}

export async function pollDeviceById(device: {
  id: string;
  companyId: string;
  ipAddress: string;
  vendor: string;
  type: string;
  credentialId: string | null;
  mibProfile: string | null;
  ponCountOid: string | null;
  onuCountOid: string | null;
  rxPowerRoot: string | null;
  txPowerRoot: string | null;
}) {
  if (!device.credentialId) return;
  const startedAt = Date.now();
  try {
    const credentials = await credentialById(device.credentialId);
    const result = await pollDevice(device, credentials);
    await recordPoll(device.id, result, true);
    await recordPollerLog({
      companyId: device.companyId,
      deviceId: device.id,
      status: "success",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    await recordPoll(device.id, emptyPollResult, false);
    await recordPollerLog({
      companyId: device.companyId,
      deviceId: device.id,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown poller error",
    });
    console.error(`SNMP poll failed for ${device.ipAddress}`, error);
    return null;
  }
}

export async function discoverNetwork(input: {
  jobId: string;
  companyId: string;
  network: string;
  credentialLabel: string;
}) {
  let discoveredCount = 0;
  try {
    const credential = await credentialByLabel(input.companyId, input.credentialLabel);
    const addresses = expandNetwork(input.network);
    const queue = [...addresses];
    const worker = async () => {
      while (queue.length > 0) {
        const ipAddress = queue.shift();
        if (!ipAddress) return;
        try {
          const result = await probeDevice(ipAddress, credential.value);
          await upsertDevice({
            companyId: input.companyId,
            name: result.sysName ?? ipAddress,
            ipAddress,
            vendor: "Discovered",
            type: "Network device",
            location: input.network,
            credentialId: credential.id,
          });
          discoveredCount += 1;
        } catch {
          // A failed probe is expected during a range scan and is not a job failure.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, addresses.length) }, () => worker()));
    await updateDiscoveryJob(input.jobId, "completed", discoveredCount);
  } catch (error) {
    await updateDiscoveryJob(input.jobId, "completed", discoveredCount);
    console.error(`Discovery job ${input.jobId} failed`, error);
  }
}

export function startPoller() {
  const intervalMs = Math.max(10_000, Number(process.env.NMS_POLL_INTERVAL_SECONDS ?? 60) * 1000);
  const run = async () => {
    try {
      const devices = await listPollableDevices();
      await Promise.all(devices.map((device) => pollDeviceById(device)));
    } catch (error) {
      console.error("SNMP poller cycle failed", error);
    } finally {
      // Cleanup is deliberately detached from the poll cycle. A slow cleanup
      // must not delay the next poll or a request reading recent history.
      scheduleTelemetryCleanup();
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return timer;
}

function expandNetwork(network: string): string[] {
  const [address, prefixString] = network.split("/");
  const prefix = prefixString ? Number(prefixString) : 32;
  if (!isValidIpv4(address) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error("Discovery network must be an IPv4 CIDR range");
  }
  const base = ipv4ToNumber(address) & (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
  const count = 2 ** (32 - prefix);
  if (count > 4096) throw new Error("Discovery range cannot contain more than 4096 addresses");
  const first = prefix >= 31 ? 0 : 1;
  const last = prefix >= 31 ? count : count - 1;
  return Array.from({ length: Math.max(0, last - first) }, (_, offset) =>
    numberToIpv4((base + first + offset) >>> 0),
  );
}

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
}

function ipv4ToNumber(value: string): number {
  return value.split(".").reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}