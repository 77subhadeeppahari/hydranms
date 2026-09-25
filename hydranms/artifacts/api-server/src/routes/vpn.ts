import { generateKeyPairSync } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import {
  auditLogs,
  db,
  vpnSites,
} from "@workspace/db";
import {
  CreateVpnSiteBody,
  CreateVpnSiteResponse,
  GenerateVpnSiteBundleResponse,
  GetVpnSitesResponse,
  RevokeVpnSiteResponse,
} from "@workspace/api-zod";
import { encryptSecret, decryptSecret } from "../lib/snmp-crypto";

const router = Router();

type Ipv4Range = { start: number; end: number; prefix: number };

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function ipv4ToNumber(value: string): number {
  if (isIP(value) !== 4) throw new Error(`Invalid IPv4 address: ${value}`);
  const octets = value.split(".").map(Number);
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function numberToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function parseCidr(value: string): Ipv4Range {
  const [address, rawPrefix] = value.trim().split("/");
  const prefix = Number(rawPrefix);
  if (!address || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`CIDR must be an IPv4 network such as 192.168.10.0/24`);
  }
  const ip = ipv4ToNumber(address);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (ip & mask) >>> 0;
  if (start !== ip) throw new Error(`${value} contains host bits; enter the network address`);
  const size = 2 ** (32 - prefix);
  return { start, end: start + size - 1, prefix };
}

function rangesOverlap(left: Ipv4Range, right: Ipv4Range): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function configuredNetwork(): string {
  return process.env.WIREGUARD_NETWORK?.trim() || "10.90.0.0/16";
}

function configuredEndpoint(): string {
  const endpoint = process.env.WIREGUARD_ENDPOINT?.trim();
  if (!endpoint) throw new Error("WIREGUARD_ENDPOINT is not configured");
  return endpoint;
}

function configuredServerPublicKey(): string {
  const publicKey = process.env.WIREGUARD_SERVER_PUBLIC_KEY?.trim();
  if (!publicKey) throw new Error("WIREGUARD_SERVER_PUBLIC_KEY is not configured");
  return publicKey;
}

function generateWireGuardKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const privateBytes = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicBytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    privateKey: privateBytes.toString("base64"),
    publicKey: publicBytes.toString("base64"),
  };
}

function siteResponse(site: typeof vpnSites.$inferSelect) {
  return {
    id: site.id,
    companyId: site.companyId,
    name: site.name,
    lanCidr: site.lanCidr,
    tunnelAddress: site.tunnelAddress,
    routerOsVersion: site.routerOsVersion,
    status: ["pending", "active", "offline", "revoked"].includes(site.status)
      ? site.status
      : "pending",
    routeState: ["pending", "applied", "error"].includes(site.routeState)
      ? site.routeState
      : "pending",
    lastHandshakeAt: site.lastHandshakeAt?.toISOString() ?? null,
    lastBundleAt: site.lastBundleAt?.toISOString() ?? null,
    revokedAt: site.revokedAt?.toISOString() ?? null,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  };
}

function currentCompanyId(req: { auth?: { companyId: string | null; user: { role: string } }; header(name: string): string | undefined }): string | null {
  const requested = req.header("x-company-id");
  if (req.auth?.user.role === "super_admin" && requested) return requested;
  return req.auth?.companyId ?? null;
}

function isSuperAdmin(req: { auth?: { user: { role: string } } }): boolean {
  return req.auth?.user.role === "super_admin";
}

async function recordAudit(companyId: string, actorUserId: string | undefined, action: string, targetId: string, metadata: Record<string, unknown>) {
  await db.insert(auditLogs).values({
    id: `audit-${crypto.randomUUID()}`,
    companyId,
    actorUserId: actorUserId ?? null,
    action,
    targetType: "vpn_site",
    targetId,
    metadata,
  });
}

router.get("/vpn/sites", async (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  try {
    const companyId = currentCompanyId(req);
    const rows = companyId
      ? await db.select().from(vpnSites).where(eq(vpnSites.companyId, companyId)).orderBy(vpnSites.createdAt)
      : isSuperAdmin(req)
        ? await db.select().from(vpnSites).orderBy(vpnSites.createdAt)
        : [];
    res.json(GetVpnSitesResponse.parse(rows.map(siteResponse)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to list VPN sites" });
  }
});

router.post("/vpn/sites", async (req, res) => {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ error: "Super-admin access required" });
    return;
  }
  const parsed = CreateVpnSiteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const lanRange = parseCidr(parsed.data.lanCidr);
    const wireguardRange = parseCidr(configuredNetwork());
    if (rangesOverlap(lanRange, wireguardRange)) {
      throw new Error("The customer LAN cannot overlap the WireGuard network");
    }

    const existing = await db.select().from(vpnSites).where(
      inArray(vpnSites.status, ["pending", "active", "offline"]),
    );
    if (existing.some((site) => rangesOverlap(lanRange, parseCidr(site.lanCidr)))) {
      throw new Error("The customer LAN overlaps an existing VPN site");
    }

    const usedTunnelAddresses = new Set(existing.map((site) => site.tunnelAddress.split("/")[0]));
    let tunnelIp: string | null = null;
    for (let offset = 2; offset < 2 ** (32 - wireguardRange.prefix) - 1; offset += 1) {
      const candidate = numberToIpv4(wireguardRange.start + offset);
      if (!usedTunnelAddresses.has(candidate)) {
        tunnelIp = candidate;
        break;
      }
    }
    if (!tunnelIp) throw new Error("The WireGuard address pool is exhausted");

    const keyPair = generateWireGuardKeyPair();
    const id = `vpn-${crypto.randomUUID()}`;
    const [site] = await db.insert(vpnSites).values({
      id,
      companyId: parsed.data.companyId,
      name: parsed.data.name.trim(),
      lanCidr: `${numberToIpv4(lanRange.start)}/${lanRange.prefix}`,
      tunnelAddress: `${tunnelIp}/32`,
      routerOsVersion: parsed.data.routerOsVersion.trim(),
      clientPublicKey: keyPair.publicKey,
      encryptedClientPrivateKey: encryptSecret(keyPair.privateKey),
    }).returning();
    if (!site) throw new Error("VPN site was not created");
    await recordAudit(site.companyId, req.auth?.user.id, "vpn_site_created", site.id, {
      lanCidr: site.lanCidr,
      routerOsVersion: site.routerOsVersion,
    });
    res.status(201).json(CreateVpnSiteResponse.parse(siteResponse(site)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to create VPN site" });
  }
});

router.post("/vpn/sites/:siteId/bundle", async (req, res) => {
  try {
    const siteId = param(req.params.siteId);
    const companyId = currentCompanyId(req);
    const filters = [eq(vpnSites.id, siteId)];
    if (companyId) filters.push(eq(vpnSites.companyId, companyId));
    const [site] = await db.select().from(vpnSites).where(and(...filters)).limit(1);
    if (!site) {
      res.status(404).json({ error: "VPN site not found" });
      return;
    }
    if (site.status === "revoked") {
      res.status(409).json({ error: "This VPN site has been revoked" });
      return;
    }
    if (!/^7(?:\.|$)/.test(site.routerOsVersion.trim())) {
      res.status(409).json({
        error: "Native WireGuard onboarding requires RouterOS 7.x; use a separate compatibility gateway for RouterOS 6.x",
      });
      return;
    }

    const serverEndpoint = configuredEndpoint();
    const serverPublicKey = configuredServerPublicKey();
    const privateKey = decryptSecret(site.encryptedClientPrivateKey);
    const wireguardNetwork = configuredNetwork();
    const interfaceName = process.env.WIREGUARD_INTERFACE?.trim() || "wg-hydranms";
    const endpointPortMatch = serverEndpoint.match(/:(\d+)$/);
    const endpointPort = endpointPortMatch ? Number(endpointPortMatch[1]) : 51820;
    const endpointAddress = endpointPortMatch ? serverEndpoint.slice(0, -endpointPortMatch[0].length) : serverEndpoint;
    const address = site.tunnelAddress;
    const wireguardConfig = `[Interface]
PrivateKey = ${privateKey}
Address = ${address}

[Peer]
PublicKey = ${serverPublicKey}
Endpoint = ${serverEndpoint}
AllowedIPs = ${wireguardNetwork}, ${site.lanCidr}
PersistentKeepalive = 25
`;
    const routerOsScript = `# HydraNMS WireGuard onboarding for ${site.name}
# RouterOS v7. Apply after reviewing the values and existing firewall policy.
/interface/wireguard/add name=${interfaceName} private-key="${privateKey}"
/ip/address/add address=${address} interface=${interfaceName}
/interface/wireguard/peers/add interface=${interfaceName} public-key="${serverPublicKey}" endpoint-address="${endpointAddress}" endpoint-port=${endpointPort} allowed-address="${wireguardNetwork}" persistent-keepalive=25
/ip/route/add dst-address="${wireguardNetwork}" gateway=${interfaceName}
/ip/firewall/filter/add chain=forward action=accept in-interface=${interfaceName} out-interface-list=LAN comment="HydraNMS WireGuard to LAN"
/ip/firewall/filter/add chain=forward action=accept in-interface-list=LAN out-interface=${interfaceName} connection-state=established,related comment="HydraNMS WireGuard return traffic"
`;
    const serverPeerSnippet = `[Peer]
# ${site.name} (${site.id})
PublicKey = ${site.clientPublicKey}
AllowedIPs = ${site.tunnelAddress}, ${site.lanCidr}
`;
    const generatedAt = new Date();
    await db.update(vpnSites).set({ lastBundleAt: generatedAt, updatedAt: generatedAt }).where(eq(vpnSites.id, site.id));
    await recordAudit(site.companyId, req.auth?.user.id, "vpn_site_bundle_generated", site.id, {
      routerOsVersion: site.routerOsVersion,
    });
    res.json(GenerateVpnSiteBundleResponse.parse({
      siteId: site.id,
      name: site.name,
      tunnelAddress: site.tunnelAddress,
      lanCidr: site.lanCidr,
      serverEndpoint,
      serverPublicKey,
      clientPrivateKey: privateKey,
      clientPublicKey: site.clientPublicKey,
      wireguardConfig,
      routerOsScript,
      serverPeerSnippet,
      generatedAt: generatedAt.toISOString(),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to generate VPN bundle";
    res.status(message.includes("not configured") ? 409 : 400).json({ error: message });
  }
});

router.post("/vpn/sites/:siteId/revoke", async (req, res) => {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ error: "Super-admin access required" });
    return;
  }
  try {
    const siteId = param(req.params.siteId);
    const [site] = await db.select().from(vpnSites).where(eq(vpnSites.id, siteId)).limit(1);
    if (!site) {
      res.status(404).json({ error: "VPN site not found" });
      return;
    }
    const revokedAt = new Date();
    const [updated] = await db.update(vpnSites).set({
      status: "revoked",
      routeState: "error",
      revokedAt,
      updatedAt: revokedAt,
    }).where(eq(vpnSites.id, siteId)).returning();
    if (!updated) throw new Error("VPN site could not be revoked");
    await recordAudit(updated.companyId, req.auth?.user.id, "vpn_site_revoked", updated.id, {});
    res.json(RevokeVpnSiteResponse.parse(siteResponse(updated)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to revoke VPN site" });
  }
});

export default router;