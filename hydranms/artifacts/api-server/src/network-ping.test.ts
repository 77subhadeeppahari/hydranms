import assert from "node:assert/strict";
import test from "node:test";
import { pingIpv4 } from "./lib/network-ping";

test("checks loopback reachability when ICMP is unavailable", async () => {
  const result = await pingIpv4("127.0.0.1");

  assert.equal(result.state, "reachable");
  assert.equal(result.packetsSent, 1);
  assert.equal(result.packetsReceived, 1);
  assert.equal(result.packetLossPercent, 0);
});