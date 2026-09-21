import type { PollResult } from "./snmp-poller";

export type PollStateDevice = {
  consecutiveFailures: number;
  lastSeen: Date | null;
};

export type PollStateUpdate = {
  status: "online" | "warning" | "offline";
  lastSeen: Date | null;
  lastPollAt: Date;
  consecutiveFailures: number;
  telemetry: Pick<
    PollResult,
    "sysUpTimeSeconds" | "systemVersion" | "ramPercent" | "diskPercent" | "interfaces" | "ponCount" | "onuCount" | "rxPower" | "txPower"
  > | null;
};

export function derivePollState(
  device: PollStateDevice,
  result: PollResult,
  success: boolean,
  now: Date,
): PollStateUpdate {
  const consecutiveFailures = success ? 0 : device.consecutiveFailures + 1;
  const status = success
    ? result.ponCount !== null && result.onuCount === 0
      ? "warning"
      : "online"
    : consecutiveFailures >= 3
      ? "offline"
      : "warning";

  return {
    status,
    lastSeen: success ? now : device.lastSeen,
    lastPollAt: now,
    consecutiveFailures,
    telemetry: success
      ? {
          sysUpTimeSeconds: result.sysUpTimeSeconds,
          systemVersion: result.systemVersion,
          ramPercent: result.ramPercent,
          diskPercent: result.diskPercent,
          interfaces: result.interfaces,
          ponCount: result.ponCount,
          onuCount: result.onuCount,
          rxPower: result.rxPower,
          txPower: result.txPower,
        }
      : null,
  };
}