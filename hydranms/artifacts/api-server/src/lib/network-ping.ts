import { execFile } from "node:child_process";
import { createConnection } from "node:net";

type PingState = "reachable" | "unreachable" | "unavailable";

export type NetworkPingResult = {
  ip: string;
  state: PingState;
  latencyMs: number | null;
  packetsSent: number;
  packetsReceived: number;
  packetLossPercent: number;
  checkedAt: string;
  message: string;
};

type PingCommandError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
};

function parsePingOutput(output: string) {
  const latencyMatch = output.match(/time[=<]([\d.]+)\s*ms/i);
  const sentMatch = output.match(/(\d+)\s+packets transmitted/i);
  const receivedMatch = output.match(/(\d+)\s+packets (?:received|received,)/i);
  const lossMatch = output.match(/([\d.]+)%\s*packet loss/i);
  return {
    latencyMs: latencyMatch ? Number(latencyMatch[1]) : null,
    packetsSent: sentMatch ? Number(sentMatch[1]) : 1,
    packetsReceived: receivedMatch ? Number(receivedMatch[1]) : 0,
    packetLossPercent: lossMatch ? Number(lossMatch[1]) : 100,
  };
}

function executePing(ip: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "ping",
      ["-4", "-n", "-c", "1", "-W", "2", ip],
      { timeout: 4_000, maxBuffer: 16_000 },
      (error, stdout, stderr) => {
        if (error) {
          const pingError = error as PingCommandError;
          pingError.stdout = stdout;
          pingError.stderr = stderr;
          reject(pingError);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

const tcpProbePorts = [22, 23, 80, 443, 8291, 8728, 8729];

function probeTcpPort(ip: string, port: number): Promise<{ port: number; latencyMs: number } | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = createConnection({ host: ip, port });
    let settled = false;
    const finish = (result: { port: number; latencyMs: number } | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(900, () => finish(null));
    socket.once("connect", () => finish({ port, latencyMs: Date.now() - startedAt }));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      // ECONNREFUSED is still a response from the target host, proving that
      // the IP is reachable even though this particular service is closed.
      finish(error.code === "ECONNREFUSED" ? { port, latencyMs: Date.now() - startedAt } : null);
    });
  });
}

async function probeTcpReachability(ip: string) {
  const results = await Promise.all(tcpProbePorts.map((port) => probeTcpPort(ip, port)));
  return results.find((result): result is { port: number; latencyMs: number } => result !== null) ?? null;
}

export async function pingIpv4(ip: string): Promise<NetworkPingResult> {
  const checkedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await executePing(ip);
    const details = parsePingOutput(`${stdout}\n${stderr}`);
    return {
      ip,
      state: "reachable",
      ...details,
      packetLossPercent: 0,
      checkedAt,
      message: "Reply received",
    };
  } catch (error) {
    const pingError = error as PingCommandError;
    const output = `${pingError.stdout ?? ""}\n${pingError.stderr ?? ""}`;
    const details = parsePingOutput(output);
    const unavailable = pingError.code === "ENOENT" || /operation not permitted|address family not supported|permission denied/i.test(output);
    if (unavailable) {
      const tcpProbe = await probeTcpReachability(ip);
      if (tcpProbe) {
        return {
          ip,
          state: "reachable",
          latencyMs: tcpProbe.latencyMs,
          packetsSent: 1,
          packetsReceived: 1,
          packetLossPercent: 0,
          checkedAt,
          message: `ICMP ping is unavailable; TCP reachability confirmed on port ${tcpProbe.port}`,
        };
      }
    }
    return {
      ip,
      state: unavailable ? "unavailable" : "unreachable",
      ...details,
      checkedAt,
      message: unavailable
        ? "ICMP ping is unavailable on the monitoring server"
        : "No reply received before the timeout",
    };
  }
}