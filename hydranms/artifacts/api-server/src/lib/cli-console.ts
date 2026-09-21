import net from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("ssh2") as { Client: new () => any };

const maxOutputLength = 100_000;
const connectionTimeoutMs = 15_000;

export type CliProtocol = "ssh" | "telnet";
export type CliReachability = "reachable" | "unreachable";

function boundedOutput(value: string): string {
  if (value.length <= maxOutputLength) return value;
  return `${value.slice(0, maxOutputLength)}\n\n[Output truncated]`;
}

function scrubOutput(value: string, username: string, password: string): string {
  return boundedOutput(value)
    .replaceAll(password, "[redacted]")
    .replaceAll(username, "[username]");
}

export async function executeCliCommand(input: {
  host: string;
  protocol: CliProtocol;
  port: number;
  username: string;
  password: string;
  command: string;
}): Promise<string> {
  const command = input.command.trim();
  if (!command) throw new Error("Command is required");
  if (command.length > 2_000) throw new Error("Command is too long");
  if (input.protocol === "ssh") return executeSsh({ ...input, command });
  return executeTelnet({ ...input, command });
}

export function probeCliPort(input: { host: string; port: number }): Promise<{ state: CliReachability; latencyMs: number | null }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host: input.host, port: input.port });
    let settled = false;
    const finish = (state: CliReachability) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ state, latencyMs: state === "reachable" ? Date.now() - startedAt : null });
    };
    socket.setTimeout(3_000, () => finish("unreachable"));
    socket.once("connect", () => finish("reachable"));
    socket.once("error", () => finish("unreachable"));
  });
}

function executeSsh(input: {
  host: string;
  port: number;
  username: string;
  password: string;
  command: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let output = "";
    const timer = setTimeout(() => finish(new Error("SSH command timed out")), connectionTimeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      if (error) reject(error);
      else resolve(scrubOutput(output, input.username, input.password));
    };

    client
      .on("ready", () => {
        client.exec(input.command, (error: Error | undefined, stream: any) => {
          if (error) {
            finish(error);
            return;
          }
          stream.on("data", (chunk: Buffer | string) => {
            output += chunk.toString();
          });
          stream.stderr?.on("data", (chunk: Buffer | string) => {
            output += chunk.toString();
          });
          stream.on("close", () => finish());
        });
      })
      .on("error", (error: Error) => finish(error))
      .connect({
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password,
        readyTimeout: connectionTimeoutMs,
      });
  });
}

function executeTelnet(input: {
  host: string;
  port: number;
  username: string;
  password: string;
  command: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: input.host, port: input.port });
    let settled = false;
    let output = "";
    let commandSent = false;
    const timer = setTimeout(() => finish(new Error("Telnet command timed out")), connectionTimeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(scrubOutput(output, input.username, input.password));
    };

    socket.setTimeout(connectionTimeoutMs, () => finish(new Error("Telnet command timed out")));
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    socket.on("connect", () => {
      setTimeout(() => socket.write(`${input.username}\r\n`), 200);
      setTimeout(() => socket.write(`${input.password}\r\n`), 500);
      setTimeout(() => {
        commandSent = true;
        socket.write(`${input.command}\r\n`);
        setTimeout(() => finish(), 900);
      }, 800);
    });
    socket.on("close", () => {
      if (commandSent) finish();
    });
  });
}