import assert from "node:assert/strict";
import test from "node:test";
import {
  createOltWebLoginTicket,
  isOltDevice,
  isSupportedOltWebPort,
  verifyOltWebLoginTicket,
} from "./lib/olt-web-proxy";

test("OLT bootstrap tickets use an opaque isolated host and reject tampering", () => {
  const originalSecret = process.env.SESSION_SECRET;
  const originalDomain = process.env.OLT_PROXY_BASE_DOMAIN;
  process.env.SESSION_SECRET = "unit-test-olt-proxy-secret";
  process.env.OLT_PROXY_BASE_DOMAIN = "olt.hydranms.in";

  try {
    const issued = createOltWebLoginTicket({
      deviceId: "device-private-id",
      companyId: "company-private-id",
      userId: "user-private-id",
      authSessionId: "session-private-id",
      parentOrigin: "https://hydranms.in",
    });
    const claims = verifyOltWebLoginTicket(issued.ticket);

    assert.match(issued.proxyOrigin, /^https:\/\/[a-f0-9]{32}\.olt\.hydranms\.in$/);
    assert.equal(issued.proxyOrigin.includes("device-private-id"), false);
    assert.ok(claims);
    assert.equal(claims.deviceId, "device-private-id");
    assert.equal(claims.companyId, "company-private-id");
    assert.equal(claims.parentOrigin, "https://hydranms.in");
    assert.ok(Date.parse(issued.ticketExpiresAt) > Date.now());
    assert.equal(verifyOltWebLoginTicket(issued.ticket, "session"), null);

    const [payload, signature] = issued.ticket.split(".");
    const tampered = `${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    assert.equal(verifyOltWebLoginTicket(tampered), null);
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
    if (originalDomain === undefined) delete process.env.OLT_PROXY_BASE_DOMAIN;
    else process.env.OLT_PROXY_BASE_DOMAIN = originalDomain;
  }
});

test("OLT web target classification and port validation stay narrow", () => {
  assert.equal(isOltDevice({ vendor: "VSOL", type: "OLT", mibProfile: "VSOL", ponCount: null, onuCount: null }), true);
  assert.equal(isOltDevice({ vendor: "ZTE", type: "Switch", mibProfile: "ZTE", ponCount: 4, onuCount: 0 }), true);
  assert.equal(isOltDevice({ vendor: "MikroTik", type: "Router", mibProfile: null, ponCount: null, onuCount: null }), false);
  assert.equal(isSupportedOltWebPort(80), true);
  assert.equal(isSupportedOltWebPort(443), true);
  assert.equal(isSupportedOltWebPort(8443), false);
  assert.equal(isSupportedOltWebPort(22), false);
  assert.equal(isSupportedOltWebPort(8080.5), false);
});