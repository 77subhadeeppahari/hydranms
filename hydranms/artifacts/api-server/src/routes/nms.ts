import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Router, type IRouter, type Request, type Response } from "express";
import { Storage } from "@google-cloud/storage";
import {
  CreateCheckoutBody,
  CreateCompanyBody,
  CreateCompanyUserBody,
  CreateCompanyUserResponse,
  UpdateCompanyProfileBody,
  CheckCompanyProfilePingBody,
  CheckCompanyProfilePingResponse,
  CreateDeviceBody,
  CreatePlanBody,
  CreateSupportTicketBody,
  CreateIncidentTicketBody,
  DiscoverDevicesBody,
  GetAlertsResponse,
  GetCompaniesResponse,
  GetDashboardResponse,
  GetAdminDashboardResponse,
  GetDeviceDetailsResponse,
  GetDeviceHistoryResponse,
  GetDevicesResponse,
  GetNotificationDeliveriesQueryParams,
  GetLicenseResponse,
  GetPlansResponse,
  GetSupportTicketsResponse,
  GetNotificationDeliveryResponse,
  LoginUserBody,
  LoginUserResponse,
  RegisterUserBody,
  RegisterUserResponse,
  UpdateCompanyLicenseBody,
  UpdatePlanBody,
  GetAdminCompanyProfileResponse,
  UpdateAdminCompanyProfileBody,
  UpdateAdminCompanyProfileResponse,
  RequestStorageUploadUrlBody,
  RequestStorageUploadUrlResponse,
  CreateCheckoutResponse,
  CreateCompanyResponse,
  CreateDeviceResponse,
  SubmitContactMessageBody,
  SubmitContactMessageResponse,
  CreateSupportTicketResponse,
  CreateIncidentTicketResponse,
  GetIncidentTicketsResponse,
  ResolveIncidentTicketResponse,
  DiscoverDevicesResponse,
  GetAlertSettingsResponse,
  GetNotificationDeliveriesResponse,
  GetCompanyUsersResponse,
  GetCompanyAuditLogResponse,
  GetCompanyPollerLogResponse,
  GetPaymentWebhookEventsResponse,
  GetPaymentRecordsResponse,
  GetContactSubmissionsResponse,
  PurgeContactSubmissionsResponse,
  UpdateContactSubmissionBody,
  UpdateContactSubmissionResponse,
  UpdateAlertSettingsBody,
  UpdateCompanyUserBody,
  UpdateUserProfileBody,
  ChangeUserPasswordBody,
  UpdateDeviceMibSettingsBody,
  UpdateDeviceMibSettingsResponse,
  UpdateDeviceCliSettingsBody,
  UpdateDeviceCliSettingsResponse,
  ExecuteDeviceCliCommandBody,
  ExecuteDeviceCliCommandResponse,
  GetDeviceCliStatusResponse,
  RetryNotificationResponse,
} from "@workspace/api-zod";
import type { TelegramTestResponse } from "@workspace/api-zod";
import {
  credentialByLabel,
  createDiscoveryJob,
  deleteDevice,
  deviceDetailsById,
  deviceByCompanyId,
  updateDeviceCliSettings,
  type HistoryWindow,
  listDevices as listPersistedDevices,
  listActiveAlerts,
  listPollerLogs,
  saveCredential,
  updateDeviceMibSettings,
  upsertDevice,
} from "../lib/nms-store";
import { decryptSnmpCredentials } from "../lib/snmp-crypto";
import { encryptSecret } from "../lib/snmp-crypto";
import { executeCliCommand, probeCliPort, type CliProtocol } from "../lib/cli-console";
import { pingIpv4 } from "../lib/network-ping";
import { discoverNetwork, pollDeviceById } from "../lib/nms-worker";
import {
  companyResponse,
  companyUserResponse,
  contactIpHash,
  createContactSubmission,
  createCompanyUser,
  createCompany,
  deleteCompany,
  createSession,
  createSupportTicket,
  createTenant,
  createCheckoutSession,
  changeUserPassword as updateUserPassword,
  createPlan,
  getUserProfile,
  getPlatformCompanyProfile,
  updatePlatformCompanyProfile,
  checkoutSessionByReference,
  activateLicenseFromCheckout,
  alertSettingsForCompany,
  claimPaymentWebhook,
  companyById,
  findUserByIdentifier,
  licenseForCompany,
  licenseResponse,
  listNotifications,
  listNotificationHistory,
  listContactSubmissions,
  purgeExpiredContactSubmissions,
  updateContactSubmission,
  notificationById,
  listPaymentWebhooks,
  listCompanyResponses,
  listTenantAuditLogs,
  listCompanyUsers,
  listCompanyPaymentRecords,
  adminDashboardSummary,
  listPlans,
  listSupportTickets,
  listIncidentTickets,
  createIncidentTicket,
  resolveIncidentTicket,
  incidentTicketResponse,
  planById,
  recordPaymentWebhook,
  retryNotification,
  revokeAllSessionsForUser,
  revokeSession,
  updateAlertSettings,
  updateCheckoutSession,
  updatePaymentWebhook,
  supportTicketResponse,
  telegramBotTokenForCompany,
  ticketTelegramBotTokenForCompany,
  updateCompanyLicense,
  updateCompany,
  updateCompanyProfile,
  updateCompanyUser,
  updatePlan,
  updateUserProfile,
  userProfileResponse,
  profilePictureReferences,
  referencedProfilePicturePaths,
  verifyPassword,
} from "../lib/portal-store";
import {
  buildAblePayPaymentFields,
  ablePayAmounts,
  ABLEPAY_GST_RATE,
  createAblePayCheckout,
  parseAblePayWebhook,
  validateAblePayAmount,
  renderAblePayPaymentForm,
  verifyAblePayResponse,
  verifyAblePaySignature,
  getTelegramBotInfo,
  sendTelegram,
} from "../lib/providers";
import { deliverNotification, queueCompanyTicketAlert, queueLicenseEmail } from "../lib/notification-service";
import { isPublicPortalRoute, optionalPortalAuth, requirePortalAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function alertEventType(dedupKey: string) {
  if (dedupKey.startsWith("device-down:")) return "device.down" as const;
  if (dedupKey.startsWith("device-recovered:")) return "device.recovered" as const;
  if (dedupKey.startsWith("port-state:")) {
    return dedupKey.endsWith(":up") ? ("port.up" as const) : ("port.down" as const);
  }
  if (dedupKey.startsWith("sfp-removed:")) return "sfp.removed" as const;
  if (dedupKey.endsWith(":rx")) return "sfp.rx.changed" as const;
  if (dedupKey.endsWith(":tx")) return "sfp.tx.changed" as const;
  return "threshold.breached" as const;
}

const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};

function publicPortalUrl(req: Request): string {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const protocol = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.get("host");
  if (!host) throw new Error("Unable to determine the public portal URL");
  const devDomain = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (devDomain && /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) {
    return `https://${devDomain}`;
  }
  return `${protocol}://${host}`;
}

function htmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

function paymentMetadataMismatch(
  webhook: { companyId?: string; planId?: string },
  checkout: { companyId: string; planId: string },
): string | null {
  const mismatches: string[] = [];
  if (webhook.companyId && webhook.companyId !== checkout.companyId) {
    mismatches.push("company");
  }
  if (webhook.planId && webhook.planId !== checkout.planId) {
    mismatches.push("plan");
  }
  return mismatches.length
    ? `Payment metadata does not match checkout (${mismatches.join(" and ")})`
    : null;
}

function paymentResultPage(title: string, message: string, success: boolean): string {
  const accent = success ? "#159c98" : "#c85c42";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlText(title)} · HydraNMS</title><style>body{margin:0;background:#f1f6f5;color:#163239;font:16px Arial,sans-serif;display:grid;place-items:center;min-height:100vh}.card{background:#fff;border:1px solid #d8e5e4;border-radius:14px;padding:34px;max-width:460px;box-shadow:0 18px 50px #16323918;text-align:center}h1{color:${accent};font-size:24px;margin:0 0 12px}p{color:#66777a;line-height:1.6}.mark{color:${accent};font-size:42px;font-weight:800;margin-bottom:15px}</style></head><body><main class="card"><div class="mark">${success ? "✓" : "!"}</div><h1>${htmlText(title)}</h1><p>${htmlText(message)}</p></main></body></html>`;
}

function notificationDeliveryResponse(delivery: Awaited<ReturnType<typeof notificationById>>) {
  if (!delivery) return null;
  return {
    id: delivery.id,
    companyId: delivery.companyId,
    channel: delivery.channel,
    eventType: delivery.eventType,
    recipient: delivery.recipient,
    status: delivery.status,
    attempts: delivery.attempts,
    maxAttempts: delivery.maxAttempts,
    nextAttemptAt: delivery.nextAttemptAt.toISOString(),
    retryable: delivery.status === "failed" && delivery.attempts < delivery.maxAttempts,
    lastError: delivery.lastError,
    providerMessageId: delivery.providerMessageId,
    createdAt: delivery.createdAt.toISOString(),
    updatedAt: delivery.updatedAt.toISOString(),
  };
}

function registrationErrorMessage(error: unknown): string {
  const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const cause = value.cause && typeof value.cause === "object" ? (value.cause as Record<string, unknown>) : {};
  const code = String(value.code ?? cause.code ?? "");
  const constraint = String(value.constraint ?? cause.constraint ?? "");
  const message = String(value.message ?? cause.message ?? "").toLowerCase();
  const duplicate = code === "23505" || message.includes("unique constraint") || message.includes("duplicate key");
  if (!duplicate) return "Unable to register this company right now. Please try again.";
  if (constraint.includes("subdomain") || message.includes("companies_subdomain_unique")) {
    return "That portal subdomain is already in use. Choose a different subdomain.";
  }
  if (constraint.includes("username") || message.includes("portal_users_username_unique")) {
    return "That admin username is already registered. Choose a different username.";
  }
  if (constraint.includes("email") || message.includes("portal_users_email_unique")) {
    return "An account already exists for that email. Sign in to continue or use a different email.";
  }
  return "That company, email, username, or portal subdomain is already registered. Sign in or use different details.";
}

router.use((req, res, next) => {
  if (isPublicPortalRoute(req)) {
    next();
    return;
  }
  if (req.path === "/billing/checkout" && req.method === "POST") {
    void optionalPortalAuth(req, res, next);
    return;
  }
  void requirePortalAuth(req, res, next);
});

const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: "http://127.0.0.1:1106/token",
    type: "external_account",
    credential_source: {
      url: "http://127.0.0.1:1106/credential",
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

const PROFILE_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000;
const PROFILE_UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function privateObjectDirectory(): { bucketName: string; objectPrefix: string } {
  const privateDir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!privateDir) throw new Error("Private object storage is not configured");
  const parts = privateDir.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts.slice(1).join("/")) {
    throw new Error("Invalid private object storage directory");
  }
  return {
    bucketName: parts[0],
    objectPrefix: parts.slice(1).join("/"),
  };
}

function privateObjectLocation(objectPath: string): { bucketName: string; objectName: string } {
  if (!objectPath.startsWith("/objects/")) throw new Error("Invalid object path");
  const { bucketName, objectPrefix } = privateObjectDirectory();
  const entityId = objectPath.slice("/objects/".length);
  if (!entityId || entityId.includes("..")) throw new Error("Invalid object path");
  return { bucketName, objectName: `${objectPrefix}/${entityId}` };
}

async function signedObjectUploadUrl(bucketName: string, objectName: string): Promise<string> {
  const response = await fetch("http://127.0.0.1:1106/object-storage/signed-object-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method: "PUT",
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Unable to sign object upload URL (${response.status})`);
  const payload = await response.json() as { signed_url?: string };
  if (!payload.signed_url) throw new Error("Object storage did not return an upload URL");
  return payload.signed_url;
}

function isManagedProfileUploadPath(objectPath: string): boolean {
  return /^\/objects\/uploads\/[^/]+$/.test(objectPath);
}

async function deleteUnreferencedProfilePicture(objectPath: string): Promise<void> {
  if (!isManagedProfileUploadPath(objectPath)) return;
  const referencedPaths = await referencedProfilePicturePaths();
  if (referencedPaths.has(objectPath)) return;

  const { bucketName, objectName } = privateObjectLocation(objectPath);
  await objectStorageClient.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
  logger.info({ objectPath }, "Removed unreferenced profile picture");
}

export async function cleanupAbandonedProfilePictures(): Promise<void> {
  const { bucketName, objectPrefix } = privateObjectDirectory();
  const referencedPaths = await referencedProfilePicturePaths();
  const [files] = await objectStorageClient
    .bucket(bucketName)
    .getFiles({ prefix: `${objectPrefix}/uploads/` });
  const cutoff = Date.now() - PROFILE_UPLOAD_RETENTION_MS;
  let deleted = 0;

  for (const file of files) {
    const fullPrefix = `${objectPrefix}/`;
    if (!file.name.startsWith(fullPrefix)) continue;
    const relativePath = `/objects/${file.name.slice(fullPrefix.length)}`;
    if (!isManagedProfileUploadPath(relativePath) || referencedPaths.has(relativePath)) continue;

    try {
      const [metadata] = await file.getMetadata();
      const lastUpdated = Date.parse(metadata.updated ?? metadata.timeCreated ?? "");
      if (!Number.isFinite(lastUpdated) || lastUpdated > cutoff) continue;
      await file.delete({ ignoreNotFound: true });
      deleted += 1;
    } catch (error) {
      logger.error({ err: error, objectPath: relativePath }, "Abandoned profile picture cleanup failed");
    }
  }

  if (deleted > 0) {
    logger.info({ deleted }, "Removed abandoned profile pictures");
  }
}

export function startProfilePictureCleanup() {
  const run = () => cleanupAbandonedProfilePictures().catch((error) => {
    logger.error({ err: error }, "Profile picture cleanup sweep failed");
  });
  void run();
  const timer = setInterval(run, PROFILE_UPLOAD_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}

function superAdminOnly(req: Request, res: Response): boolean {
  if (req.auth?.user.role === "super_admin") return true;
  res.status(403).json({ error: "Super-admin access required" });
  return false;
}

function authenticatedOnly(req: Request, res: Response): boolean {
  if (req.auth) return true;
  res.status(401).json({ error: "Authentication required" });
  return false;
}

router.get("/admin/company-profile", async (req, res) => {
  if (!authenticatedOnly(req, res)) return;
  try {
    res.set("Cache-Control", "no-store");
    const profile = await getPlatformCompanyProfile();
    res.json(GetAdminCompanyProfileResponse.parse({
      companyName: profile.companyName,
      address: profile.address,
      gstNumber: profile.gstNumber,
      phoneNumber: profile.phoneNumber,
      email: profile.email,
      logoPath: profile.logoPath,
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read company details" });
  }
});

router.post("/contact", async (req, res) => {
  const parsed = SubmitContactMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
    const submission = await createContactSubmission({
      ...parsed.data,
      ipHash: contactIpHash(ipAddress),
    });
    if (!submission.accepted) {
      res.status(429).json({
        error: submission.reason === "honeypot"
          ? "Please try again in a moment. If the problem continues, email hello@hydranms.in."
          : "Too many messages from this network. Please try again later.",
      });
      return;
    }
    res.status(201).json(SubmitContactMessageResponse.parse({ received: true }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to send your message" });
  }
});

router.get("/admin/contact-submissions", async (req, res) => {
  if (!superAdminOnly(req, res)) return;
  try {
    res.set("Cache-Control", "no-store");
    const submissions = await listContactSubmissions();
    res.json(GetContactSubmissionsResponse.parse(submissions));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read contact inquiries" });
  }
});

router.post("/admin/contact-submissions/cleanup", async (req, res) => {
  if (!superAdminOnly(req, res)) return;
  try {
    const result = await purgeExpiredContactSubmissions({ actorUserId: req.auth?.user.id });
    logger.info(
      {
        actorUserId: req.auth?.user.id,
        deletedCount: result.deletedCount,
        cutoff: result.cutoff.toISOString(),
      },
      "Super-admin ran contact submission retention cleanup",
    );
    res.json(PurgeContactSubmissionsResponse.parse({
      deletedCount: result.deletedCount,
      retentionDays: result.retentionDays,
      cutoff: result.cutoff.toISOString(),
    }));
  } catch (error) {
    logger.error({ err: error, actorUserId: req.auth?.user.id }, "Contact submission retention cleanup failed");
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to clean up contact inquiries" });
  }
});

router.patch("/admin/contact-submissions/:submissionId", async (req, res) => {
  if (!superAdminOnly(req, res)) return;
  const parsed = UpdateContactSubmissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const submission = await updateContactSubmission(req.params.submissionId, parsed.data);
    if (!submission) {
      res.status(404).json({ error: "Contact inquiry not found" });
      return;
    }
    res.json(UpdateContactSubmissionResponse.parse(submission));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update contact inquiry" });
  }
});

router.patch("/admin/company-profile", async (req, res) => {
  if (!superAdminOnly(req, res)) return;
  const parsed = UpdateAdminCompanyProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const profile = await updatePlatformCompanyProfile(parsed.data);
    res.json(UpdateAdminCompanyProfileResponse.parse({
      companyName: profile.companyName,
      address: profile.address,
      gstNumber: profile.gstNumber,
      phoneNumber: profile.phoneNumber,
      email: profile.email,
      logoPath: profile.logoPath,
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to save company details" });
  }
});

router.post("/storage/uploads/request-url", async (req, res) => {
  const parsed = RequestStorageUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const uploadInput = parsed.data as typeof parsed.data & { purpose?: "company_logo" | "profile" };
  if ((uploadInput.purpose ?? "company_logo") === "company_logo" && !superAdminOnly(req, res)) return;
  if (!parsed.data.contentType.startsWith("image/") || parsed.data.size > 5_000_000) {
    res.status(400).json({ error: "Profile images must be an image no larger than 5 MB" });
    return;
  }
  try {
    const objectId = randomUUID();
    const { bucketName, objectPrefix } = privateObjectDirectory();
    const objectName = `${objectPrefix}/uploads/${objectId}`;
    const uploadURL = await signedObjectUploadUrl(bucketName, objectName);
    res.json(RequestStorageUploadUrlResponse.parse({
      uploadURL,
      objectPath: `/objects/uploads/${objectId}`,
    }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to prepare image upload" });
  }
});

router.get("/storage/objects/*path", async (req, res) => {
  if (!authenticatedOnly(req, res)) return;
  try {
    const raw = req.params.path;
    const objectPath = `/objects/${Array.isArray(raw) ? raw.join("/") : raw}`;
    const references = await profilePictureReferences(objectPath);
    const isPermitted =
      references.userIds.includes(req.auth!.user.id) ||
      (references.platformLogo && req.auth!.user.role === "super_admin");
    if (!isPermitted) {
      res.status(references.userIds.length > 0 || references.platformLogo ? 403 : 404).json({
        error: references.userIds.length > 0 || references.platformLogo
          ? "You do not have access to this object"
          : "Object not found",
      });
      return;
    }
    const { bucketName, objectName } = privateObjectLocation(objectPath);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    const [metadata] = await file.getMetadata();
    res.setHeader("Content-Type", metadata.contentType || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
    Readable.from(file.createReadStream()).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to read object" });
  }
});

function companyIdFromRequest(req: {
  header(name: string): string | undefined;
  auth?: { companyId: string | null; user: { role: string } };
}): string {
  const requestedCompany = req.header("x-company-id");
  if (req.auth?.user.role === "super_admin" && requestedCompany) return requestedCompany;
  if (req.auth?.companyId) return req.auth.companyId;
  throw new Error("A tenant company is required");
}

function optionalOid(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const oid = value.trim();
  if (!/^\d+(?:\.\d+)+$/.test(oid)) {
    throw new Error(`${field} must be a numeric SNMP OID`);
  }
  return oid;
}

function deviceResponse(device: {
  id: string;
  name: string;
  ipAddress: string;
  vendor: string;
  type: string;
  status: string;
  uptimePercent: number;
  lastSeen: Date | null;
  location: string;
  mibProfile: string | null;
  ponCountOid: string | null;
  onuCountOid: string | null;
  rxPowerRoot: string | null;
  txPowerRoot: string | null;
  ponCount: number | null;
  onuCount: number | null;
  rxPower: number | null;
  txPower: number | null;
  sysUpTimeSeconds: number | null;
  systemVersion: string | null;
  ramPercent: number | null;
  diskPercent: number | null;
  interfaceCount: number;
  lastPollAt: Date | null;
  cliProtocol: string | null;
  sshPort: number | null;
  telnetPort: number | null;
  cliUsername: string | null;
  encryptedCliPassword: string | null;
}) {
  return {
    id: device.id,
    name: device.name,
    ipAddress: device.ipAddress,
    vendor: device.vendor,
    type: device.type,
    status: ["online", "warning", "offline", "discovering"].includes(device.status)
      ? device.status
      : "discovering",
    uptime: device.uptimePercent,
    lastSeen: device.lastSeen?.toISOString() ?? "Never",
    location: device.location,
    mibProfile: device.mibProfile,
    ponCountOid: device.ponCountOid,
    onuCountOid: device.onuCountOid,
    rxPowerRoot: device.rxPowerRoot,
    txPowerRoot: device.txPowerRoot,
    ponCount: device.ponCount,
    onuCount: device.onuCount,
    rxPower: device.rxPower,
    txPower: device.txPower,
    sysUpTimeSeconds: device.sysUpTimeSeconds,
    systemVersion: device.systemVersion,
    ramPercent: device.ramPercent,
    diskPercent: device.diskPercent,
    interfaceCount: device.interfaceCount,
    lastPollAt: device.lastPollAt?.toISOString() ?? null,
    cliConfigured: Boolean(device.cliProtocol && device.cliUsername && device.encryptedCliPassword),
    cliProtocol: device.cliProtocol,
    sshPort: device.sshPort,
    telnetPort: device.telnetPort,
    cliUsername: device.cliUsername,
  };
}

function interfaceTelemetryResponse<T extends { ifIndex: number }>(item: T) {
  return { ...item, seriesKey: `interface:${item.ifIndex}` };
}

function ponTelemetryResponse<T extends { ponIndex: number; onuIndex: number }>(item: T) {
  return { ...item, seriesKey: `onu:${item.ponIndex}:${item.onuIndex}` };
}

const uptimeSeries = [
    { label: "Mon", value: 99.92 },
    { label: "Tue", value: 99.97 },
    { label: "Wed", value: 99.95 },
    { label: "Thu", value: 99.99 },
    { label: "Fri", value: 99.96 },
    { label: "Sat", value: 99.98 },
    { label: "Sun", value: 99.98 },
];

router.get("/dashboard", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const [company, persisted, activeAlerts] = await Promise.all([
      companyResponse(companyId),
      listPersistedDevices(companyId),
      listActiveAlerts(companyId),
    ]);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const uptime =
      persisted.length > 0
        ? persisted.reduce((sum, device) => sum + device.uptimePercent, 0) / persisted.length
        : 100;
    const breakdown = new Map<string, number>();
    for (const device of persisted) {
      breakdown.set(device.type, (breakdown.get(device.type) ?? 0) + 1);
    }
    res.json(
      GetDashboardResponse.parse({
        companyName: company.name,
        subdomain: company.subdomain,
        uptime,
        totalDevices: persisted.length,
        onlineDevices: persisted.filter((device) => device.status === "online").length,
        openAlerts: activeAlerts.length,
        deviceBreakdown: [...breakdown.entries()].map(([label, count]) => ({
          label,
          count,
          color: "#53D8B4",
        })),
        uptimeSeries,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read dashboard" });
  }
});

router.get("/admin/dashboard", async (req, res) => {
  if (req.auth?.user.role !== "super_admin") {
    res.status(403).json({ error: "Super-admin access required" });
    return;
  }
  try {
    res.json(GetAdminDashboardResponse.parse(await adminDashboardSummary()));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read admin dashboard" });
  }
});

router.get("/company/profile", async (req, res) => {
  try {
    const company = await companyResponse(companyIdFromRequest(req));
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(CreateCompanyResponse.parse(company));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read company profile" });
  }
});

router.patch("/company/profile", async (req, res) => {
  const parsed = UpdateCompanyProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const company = await updateCompanyProfile(companyIdFromRequest(req), parsed.data);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(CreateCompanyResponse.parse(company));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to update company profile" });
  }
});

router.get("/company/audit-log", async (req, res) => {
  if (!req.auth || req.auth.user.role === "super_admin" || !req.auth.companyId) {
    res.status(403).json({ error: "Tenant user access required" });
    return;
  }
  const requestedLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  try {
    res.json(GetCompanyAuditLogResponse.parse(await listTenantAuditLogs(req.auth.companyId, limit)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read tenant audit log" });
  }
});

router.post("/company/profile/ping", async (req, res) => {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = CheckCompanyProfilePingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const ip = parsed.data.ip.trim();
  if (isIP(ip) !== 4) {
    res.status(400).json({ error: "Enter a valid IPv4 address" });
    return;
  }
  try {
    res.json(CheckCompanyProfilePingResponse.parse(await pingIpv4(ip)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to check IP reachability" });
  }
});

router.get("/companies/poller-log", async (req, res) => {
  if (!superAdminOnly(req, res)) return;
  const companyId = typeof req.query.companyId === "string" ? req.query.companyId : "";
  if (!companyId) {
    res.status(400).json({ error: "companyId is required" });
    return;
  }
  const requestedLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100;
  try {
    res.json(GetCompanyPollerLogResponse.parse(await listPollerLogs(companyId, limit)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read company poller log" });
  }
});

function canManageCompanyUsers(req: Request): boolean {
  return req.auth?.user.role === "company_admin" || req.auth?.user.role === "super_admin";
}

router.get("/company/users", async (req, res) => {
  if (!canManageCompanyUsers(req)) {
    res.status(403).json({ error: "Company-admin access required" });
    return;
  }
  try {
    const users = await listCompanyUsers(companyIdFromRequest(req));
    res.json(GetCompanyUsersResponse.parse(users));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read company users" });
  }
});

router.post("/company/users", async (req, res) => {
  if (!canManageCompanyUsers(req)) {
    res.status(403).json({ error: "Company-admin access required" });
    return;
  }
  const parsed = CreateCompanyUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const user = await createCompanyUser({
      ...parsed.data,
      companyId: companyIdFromRequest(req),
    });
    res.status(201).json(CreateCompanyUserResponse.parse(user));
  } catch (error) {
    res.status(409).json({ error: registrationErrorMessage(error) });
  }
});

router.patch("/company/users/:userId", async (req, res) => {
  if (!canManageCompanyUsers(req)) {
    res.status(403).json({ error: "Company-admin access required" });
    return;
  }
  if (req.auth?.user.id === req.params.userId) {
    res.status(400).json({ error: "You cannot change your own role or status" });
    return;
  }
  const parsed = UpdateCompanyUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const user = await updateCompanyUser(companyIdFromRequest(req), req.params.userId, parsed.data);
    if (!user) {
      res.status(404).json({ error: "Company user not found" });
      return;
    }
    res.json(CreateCompanyUserResponse.parse(user));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update company user" });
  }
});

router.get("/devices", async (req, res) => {
  try {
    const persisted = await listPersistedDevices(companyIdFromRequest(req));
    res.json(GetDevicesResponse.parse(persisted.map(deviceResponse)));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to read devices" });
  }
});

router.delete("/devices/:deviceId", async (req, res): Promise<void> => {
  try {
    const deviceId = Array.isArray(req.params.deviceId) ? req.params.deviceId[0] : req.params.deviceId;
    const deleted = await deleteDevice(companyIdFromRequest(req), deviceId);
    if (!deleted) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to delete device" });
  }
});

router.get("/devices/:deviceId/details", async (req, res): Promise<void> => {
  try {
    const deviceId = Array.isArray(req.params.deviceId) ? req.params.deviceId[0] : req.params.deviceId;
    const details = await deviceDetailsById(companyIdFromRequest(req), deviceId);
    if (!details) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.json(
      GetDeviceDetailsResponse.parse({
        device: deviceResponse(details.device),
        interfaces: details.interfaces.map(interfaceTelemetryResponse),
        ponTelemetry: details.ponTelemetry.map(ponTelemetryResponse),
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read device details" });
  }
});

router.patch("/devices/:deviceId/mib-settings", async (req, res): Promise<void> => {
  const parsed = UpdateDeviceMibSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const deviceId = Array.isArray(req.params.deviceId) ? req.params.deviceId[0] : req.params.deviceId;
    const companyId = companyIdFromRequest(req);
    const updated = await updateDeviceMibSettings(companyId, deviceId, {
      mibProfile: parsed.data.mibProfile ?? null,
      ponCountOid: optionalOid(parsed.data.ponCountOid, "ponCountOid"),
      onuCountOid: optionalOid(parsed.data.onuCountOid, "onuCountOid"),
      rxPowerRoot: optionalOid(parsed.data.rxPowerRoot, "rxPowerRoot"),
      txPowerRoot: optionalOid(parsed.data.txPowerRoot, "txPowerRoot"),
    });
    if (!updated) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.json(UpdateDeviceMibSettingsResponse.parse(deviceResponse(updated)));
    void pollDeviceById(updated);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update device MIB settings" });
  }
});

router.patch("/devices/:deviceId/cli-settings", async (req, res): Promise<void> => {
  const parsed = UpdateDeviceCliSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const deviceId = Array.isArray(req.params.deviceId) ? req.params.deviceId[0] : req.params.deviceId;
    const updated = await updateDeviceCliSettings(companyIdFromRequest(req), deviceId, {
      cliProtocol: parsed.data.cliProtocol,
      sshPort: parsed.data.sshPort,
      telnetPort: parsed.data.telnetPort,
      cliUsername: parsed.data.cliUsername,
      cliPassword: parsed.data.cliPassword,
    });
    if (!updated) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.json(UpdateDeviceCliSettingsResponse.parse(deviceResponse(updated)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update device CLI settings" });
  }
});

router.post("/devices/:deviceId/cli/execute", async (req, res): Promise<void> => {
  const parsed = ExecuteDeviceCliCommandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const deviceId = Array.isArray(req.params.deviceId) ? req.params.deviceId[0] : req.params.deviceId;
    const device = await deviceByCompanyId(companyIdFromRequest(req), deviceId);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    if (!device.cliProtocol || !device.cliUsername || !device.encryptedCliPassword) {
      res.status(400).json({ error: "CLI access is not configured for this device" });
      return;
    }
    if (device.cliProtocol !== "both" && device.cliProtocol !== parsed.data.protocol) {
      res.status(400).json({ error: `This device is configured for ${device.cliProtocol.toUpperCase()} only` });
      return;
    }
    const encrypted = decryptSnmpCredentials<{ password: string }>(device.encryptedCliPassword);
    const password = encrypted.password;
    if (!password) {
      res.status(400).json({ error: "CLI password is not configured for this device" });
      return;
    }
    const port = parsed.data.protocol === "ssh" ? device.sshPort : device.telnetPort;
    if (!port) {
      res.status(400).json({ error: `${parsed.data.protocol.toUpperCase()} port is not configured` });
      return;
    }
    const startedAt = Date.now();
    const output = await executeCliCommand({
      host: device.ipAddress,
      protocol: parsed.data.protocol as CliProtocol,
      port,
      username: device.cliUsername,
      password,
      command: parsed.data.command,
    });
    res.json(
      ExecuteDeviceCliCommandResponse.parse({
        protocol: parsed.data.protocol,
        command: parsed.data.command,
        output,
        durationMs: Date.now() - startedAt,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to execute CLI command" });
  }
});

router.get("/devices/:deviceId/cli/status", async (req, res): Promise<void> => {
  try {
    const deviceId = Array.isArray(req.params.deviceId) ? req.params.deviceId[0] : req.params.deviceId;
    const device = await deviceByCompanyId(companyIdFromRequest(req), deviceId);
    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    const configured = (protocol: "ssh" | "telnet") =>
      Boolean(device.cliProtocol && device.cliUsername && device.encryptedCliPassword) &&
      (device.cliProtocol === "both" || device.cliProtocol === protocol);
    const check = async (protocol: "ssh" | "telnet") => {
      const port = protocol === "ssh" ? device.sshPort : device.telnetPort;
      if (!configured(protocol) || !port) return { state: "not_configured" as const, latencyMs: null };
      return probeCliPort({ host: device.ipAddress, port });
    };
    const [ssh, telnet] = await Promise.all([check("ssh"), check("telnet")]);
    res.json(GetDeviceCliStatusResponse.parse({ ssh, telnet }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to check CLI status" });
  }
});

router.get("/devices/history", async (req, res): Promise<void> => {
  try {
    const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId : "";
    const requestedWindow = typeof req.query.window === "string" ? req.query.window : "24h";
    if (!deviceId) {
      res.status(400).json({ error: "deviceId is required" });
      return;
    }
    if (!["1h", "6h", "24h", "7d"].includes(requestedWindow)) {
      res.status(400).json({ error: "window must be one of 1h, 6h, 24h, or 7d" });
      return;
    }
    const details = await deviceDetailsById(
      companyIdFromRequest(req),
      deviceId,
      requestedWindow as HistoryWindow,
    );
    if (!details) {
      res.status(404).json({ error: "Device not found" });
      return;
    }
    res.json(
      GetDeviceHistoryResponse.parse({
        interfaceHistory: details.interfaceHistory.map(interfaceTelemetryResponse),
        opticalHistory: details.opticalHistory.map(ponTelemetryResponse),
        historyWindow: details.historyWindow,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read device history" });
  }
});

router.post("/devices", async (req, res) => {
  const parsed = CreateDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const companyId = companyIdFromRequest(req);
    const snmpVersion = parsed.data.snmpVersion ?? "v2c";
    if (snmpVersion !== "v3" && !parsed.data.snmpCommunity) {
      res.status(400).json({ error: "snmpCommunity is required for SNMPv1/v2c" });
      return;
    }
    if (snmpVersion === "v3" && !parsed.data.snmpUsername) {
      res.status(400).json({ error: "snmpUsername is required for SNMPv3" });
      return;
    }
    const credentialLabel =
      parsed.data.snmpCredentialLabel ?? `device-${parsed.data.ipAddress}`;
    const credentialId = await saveCredential(companyId, credentialLabel, {
      version: snmpVersion,
      community: parsed.data.snmpCommunity,
      username: parsed.data.snmpUsername,
      authProtocol: parsed.data.snmpAuthProtocol,
      authPassword: parsed.data.snmpAuthPassword,
      privProtocol: parsed.data.snmpPrivProtocol,
      privPassword: parsed.data.snmpPrivPassword,
      securityLevel: parsed.data.snmpSecurityLevel,
    });
    const id = await upsertDevice({
      companyId,
      name: parsed.data.name,
      ipAddress: parsed.data.ipAddress,
      vendor: parsed.data.vendor,
      type: parsed.data.type,
      location: parsed.data.location,
      credentialId,
      mibProfile: parsed.data.mibProfile ?? null,
      ponCountOid: optionalOid(parsed.data.ponCountOid, "ponCountOid"),
      onuCountOid: optionalOid(parsed.data.onuCountOid, "onuCountOid"),
      rxPowerRoot: optionalOid(parsed.data.rxPowerRoot, "rxPowerRoot"),
      txPowerRoot: optionalOid(parsed.data.txPowerRoot, "txPowerRoot"),
    });
    const persisted = await listPersistedDevices(companyId);
    const created = persisted.find((device) => device.id === id);
    if (!created) throw new Error("Device was not persisted");
    res.status(201).json(CreateDeviceResponse.parse(deviceResponse(created)));
    void pollDeviceById(created);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to save device" });
  }
});

router.post("/devices/discover", async (req, res) => {
  const parsed = DiscoverDevicesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const companyId = companyIdFromRequest(req);
    const id = `DISC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const credential = await credentialByLabel(companyId, parsed.data.credentialLabel);
    await createDiscoveryJob({
      id,
      companyId,
      network: parsed.data.network,
      version: parsed.data.snmpVersion,
      credentialId: credential.id,
    });
    const job = {
      id,
      status: "running" as const,
      network: parsed.data.network,
      discoveredCount: 0,
    };
    res.status(202).json(DiscoverDevicesResponse.parse(job));
    void discoverNetwork({
      jobId: id,
      companyId,
      network: parsed.data.network,
      credentialLabel: parsed.data.credentialLabel,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to start discovery" });
  }
});

router.get("/alerts", async (req, res) => {
  try {
    const alerts = await listActiveAlerts(companyIdFromRequest(req));
    res.json(
      GetAlertsResponse.parse(
        alerts.map((alert) => ({
          id: alert.id,
          severity: alert.severity,
          eventType: alertEventType(alert.dedupKey),
          title: alert.title,
          deviceName: alert.deviceName,
          message: alert.message,
          time: alert.updatedAt.toISOString(),
          acknowledged: alert.acknowledged,
        })),
      ),
    );
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to read alerts" });
  }
});

router.get("/settings/alerts", async (req, res) => {
  try {
    const companyId = companyIdFromRequest(req);
    const settings = await alertSettingsForCompany(companyId);
    if (!settings) {
      res.status(404).json({ error: "Alert settings not found" });
      return;
    }
    res.json(
      GetAlertSettingsResponse.parse({
        emailEnabled: settings.emailEnabled,
        emailAddress: settings.emailAddress,
        telegramEnabled: settings.telegramEnabled,
        telegramChatId: settings.telegramChatId,
        ticketTelegramEnabled: settings.ticketTelegramEnabled,
        ticketTelegramChatId: settings.ticketTelegramChatId,
        rxPowerLowThreshold: settings.rxPowerLowThreshold,
        rxPowerHighThreshold: settings.rxPowerHighThreshold,
        txPowerLowThreshold: settings.txPowerLowThreshold,
        txPowerHighThreshold: settings.txPowerHighThreshold,
        emailProviderConfigured: Boolean(process.env.EMAIL_PROVIDER && process.env.EMAIL_FROM),
        telegramProviderConfigured: Boolean(await telegramBotTokenForCompany(companyId)),
        ticketTelegramProviderConfigured: Boolean(await ticketTelegramBotTokenForCompany(companyId)),
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read alert settings" });
  }
});

router.patch("/settings/alerts", async (req, res) => {
  const parsed = UpdateAlertSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const companyId = companyIdFromRequest(req);
    const current = await alertSettingsForCompany(companyId);
    const tokenWasProvided = parsed.data.telegramBotToken !== undefined;
    const submittedToken = parsed.data.telegramBotToken?.trim() || null;
    const effectiveTelegramToken = tokenWasProvided
      ? submittedToken
      : await telegramBotTokenForCompany(companyId);
    const ticketTokenWasProvided = parsed.data.ticketTelegramBotToken !== undefined;
    const submittedTicketToken = parsed.data.ticketTelegramBotToken?.trim() || null;
    const effectiveTicketToken = ticketTokenWasProvided
      ? submittedTicketToken
      : await ticketTelegramBotTokenForCompany(companyId);
    if (parsed.data.emailEnabled && (!process.env.EMAIL_PROVIDER || !process.env.EMAIL_FROM)) {
      res.status(409).json({ error: "Configure EMAIL_PROVIDER and EMAIL_FROM before enabling email alerts" });
      return;
    }
    if (parsed.data.telegramEnabled && !effectiveTelegramToken) {
      res.status(409).json({ error: "Add a Telegram bot token before enabling Telegram alerts" });
      return;
    }
    if (parsed.data.telegramEnabled && !parsed.data.telegramChatId?.trim()) {
      res.status(400).json({ error: "Enter a Telegram chat ID before enabling Telegram alerts" });
      return;
    }
    if (parsed.data.ticketTelegramEnabled && !effectiveTicketToken) {
      res.status(409).json({ error: "Add a separate Telegram bot token before enabling ticket alerts" });
      return;
    }
    if (parsed.data.ticketTelegramEnabled && !parsed.data.ticketTelegramChatId?.trim()) {
      res.status(400).json({ error: "Enter a Telegram chat ID before enabling ticket alerts" });
      return;
    }
    const settings = await updateAlertSettings(companyId, {
      emailEnabled: parsed.data.emailEnabled,
      emailAddress: parsed.data.emailAddress ?? null,
      telegramEnabled: parsed.data.telegramEnabled,
      telegramChatId: parsed.data.telegramChatId ?? null,
      telegramBotTokenEncrypted: tokenWasProvided
        ? submittedToken
          ? encryptSecret(submittedToken)
          : null
        : (current?.telegramBotTokenEncrypted ?? null),
      ticketTelegramEnabled: parsed.data.ticketTelegramEnabled ?? current?.ticketTelegramEnabled ?? false,
      ticketTelegramChatId: parsed.data.ticketTelegramChatId ?? current?.ticketTelegramChatId ?? null,
      ticketTelegramBotTokenEncrypted: ticketTokenWasProvided
        ? submittedTicketToken
          ? encryptSecret(submittedTicketToken)
          : null
        : (current?.ticketTelegramBotTokenEncrypted ?? null),
      rxPowerLowThreshold:
        parsed.data.rxPowerLowThreshold === undefined
          ? (current?.rxPowerLowThreshold ?? null)
          : parsed.data.rxPowerLowThreshold,
      rxPowerHighThreshold:
        parsed.data.rxPowerHighThreshold === undefined
          ? (current?.rxPowerHighThreshold ?? null)
          : parsed.data.rxPowerHighThreshold,
      txPowerLowThreshold:
        parsed.data.txPowerLowThreshold === undefined
          ? (current?.txPowerLowThreshold ?? null)
          : parsed.data.txPowerLowThreshold,
      txPowerHighThreshold:
        parsed.data.txPowerHighThreshold === undefined
          ? (current?.txPowerHighThreshold ?? null)
          : parsed.data.txPowerHighThreshold,
    });
    res.json(
      GetAlertSettingsResponse.parse({
        emailEnabled: settings.emailEnabled,
        emailAddress: settings.emailAddress,
        telegramEnabled: settings.telegramEnabled,
        telegramChatId: settings.telegramChatId,
        ticketTelegramEnabled: settings.ticketTelegramEnabled,
        ticketTelegramChatId: settings.ticketTelegramChatId,
        rxPowerLowThreshold: settings.rxPowerLowThreshold,
        rxPowerHighThreshold: settings.rxPowerHighThreshold,
        txPowerLowThreshold: settings.txPowerLowThreshold,
        txPowerHighThreshold: settings.txPowerHighThreshold,
        emailProviderConfigured: Boolean(process.env.EMAIL_PROVIDER && process.env.EMAIL_FROM),
        telegramProviderConfigured: Boolean(effectiveTelegramToken),
        ticketTelegramProviderConfigured: Boolean(effectiveTicketToken),
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update alert settings" });
  }
});

router.post("/settings/alerts/telegram/test", async (req, res) => {
  const chatIdValue = req.body && typeof req.body === "object" ? (req.body as { chatId?: unknown }).chatId : undefined;
  const botTokenValue = req.body && typeof req.body === "object" ? (req.body as { botToken?: unknown }).botToken : undefined;
  if (typeof chatIdValue !== "string" || !chatIdValue.trim()) {
    res.status(400).json({ error: "Enter a Telegram chat ID before sending a test alert" });
    return;
  }
  const companyId = companyIdFromRequest(req);
  const configuredToken = await telegramBotTokenForCompany(companyId);
  const botToken = typeof botTokenValue === "string" && botTokenValue.trim()
    ? botTokenValue.trim()
    : configuredToken;
  if (!botToken) {
    res.status(409).json({ error: "Add a Telegram bot token before testing Telegram alerts" });
    return;
  }
  const chatId = chatIdValue.trim();
  try {
    const bot = await getTelegramBotInfo(botToken);
    const delivery = await sendTelegram({
      chatId,
      token: botToken,
      text: [
        "HydraNMS Telegram test",
        "",
        "Your bot is connected and this chat can receive network alerts.",
      ].join("\n"),
    });
    const response: TelegramTestResponse = {
      ok: true,
      botUsername: bot.username,
      botName: bot.firstName,
      providerMessageId: delivery.providerMessageId ?? null,
    };
    res.json(response);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Telegram test failed" });
  }
});

router.get("/companies", async (_req, res) => {
  try {
    res.json(GetCompaniesResponse.parse(await listCompanyResponses()));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unable to read companies" });
  }
});

router.post("/companies", async (req, res) => {
  const parsed = CreateCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const company = await createCompany(parsed.data);
    if (!company) {
      res.status(500).json({ error: "Company was not persisted" });
      return;
    }
    res.status(201).json(CreateCompanyResponse.parse(company));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to create company" });
  }
});

router.patch("/companies/:companyId", async (req, res) => {
  const parsed = CreateCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const company = await updateCompany(req.params.companyId, parsed.data);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(CreateCompanyResponse.parse(company));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to update company" });
  }
});

router.delete("/companies/:companyId", async (req, res) => {
  try {
    const deleted = await deleteCompany(req.params.companyId);
    if (!deleted) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.status(204).send();
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to delete company" });
  }
});

router.patch("/companies/:companyId/license", async (req, res) => {
  const parsed = UpdateCompanyLicenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const company = await companyResponse(req.params.companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const plan = await planById(parsed.data.planId);
    if (!plan) {
      res.status(400).json({ error: "Unknown subscription plan" });
      return;
    }
    if (!req.auth?.user.id) throw new Error("Authenticated user is required");
    const value = await updateCompanyLicense(
      req.params.companyId,
      {
        status: parsed.data.status,
        planId: parsed.data.planId,
        expiresAt: parsed.data.expiresAt.toISOString().slice(0, 10),
      },
      req.auth.user.id,
    );
    if (!value) {
      res.status(500).json({ error: "License was not persisted" });
      return;
    }
    res.json(GetLicenseResponse.parse(await licenseResponse(value)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to update license" });
  }
});

router.get("/plans", async (_req, res) => {
  res.json(GetPlansResponse.parse(await listPlans()));
});

router.post("/plans", async (req, res) => {
  if (req.auth?.user.role !== "super_admin") {
    res.status(403).json({ error: "Super-admin access required" });
    return;
  }
  const parsed = CreatePlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const plan = await createPlan(parsed.data);
    if (!plan) {
      res.status(500).json({ error: "Plan was not persisted" });
      return;
    }
    res.status(201).json(plan);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to create plan" });
  }
});

router.patch("/plans/:planId", async (req, res) => {
  if (req.auth?.user.role !== "super_admin") {
    res.status(403).json({ error: "Super-admin access required" });
    return;
  }
  const parsed = UpdatePlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const plan = await updatePlan(req.params.planId, parsed.data);
    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    res.json(plan);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to update plan" });
  }
});

router.post("/billing/checkout", async (req, res) => {
  const parsed = CreateCheckoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const selectedPlan = await planById(parsed.data.planId);
    if (!selectedPlan) {
      res.status(400).json({ error: "Unknown subscription plan" });
      return;
    }
    const amounts = ablePayAmounts(selectedPlan.price);
    try {
      validateAblePayAmount(amounts.totalAmount);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "This plan price is below AblePay's minimum transaction amount" });
      return;
    }
    const companyId = req.auth?.companyId ?? parsed.data.companyId;
    if (!companyId) {
      res.status(400).json({ error: "A company is required to create checkout" });
      return;
    }
    if (req.auth?.user.role !== "super_admin" && req.auth?.companyId && req.auth.companyId !== companyId) {
      res.status(403).json({ error: "You do not have access to this company" });
      return;
    }
    const company = await companyById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    if (!req.auth && company.status !== "pending") {
      res.status(403).json({ error: "Only a pending company can start public checkout" });
      return;
    }
    const session = await createCheckoutSession({
      companyId,
      planId: selectedPlan.id,
      amount: amounts.totalAmount,
      currency: "INR",
    });
    try {
      const provider = await createAblePayCheckout({
        orderId: session.id,
        amount: amounts.totalAmount,
        currency: "INR",
        planId: selectedPlan.id,
        companyId,
        customerEmail: company.email,
        redirectUrl: `${publicPortalUrl(req)}/api/billing/ablepay/redirect/${session.id}`,
      });
      await updateCheckoutSession(session.id, {
        status: "pending",
        providerSessionId: provider.providerSessionId,
        checkoutUrl: provider.checkoutUrl,
      });
      res.json(
        CreateCheckoutResponse.parse({
          id: session.id,
          provider: "ablepay",
          status: "pending",
          amount: amounts.totalAmount,
          subtotal: amounts.subtotal,
          gstRate: ABLEPAY_GST_RATE,
          gstAmount: amounts.gstAmount,
          currency: "INR",
          checkoutUrl: provider.checkoutUrl,
        }),
      );
    } catch (error) {
      await updateCheckoutSession(session.id, { status: "failed" });
      res.status(503).json({ error: error instanceof Error ? error.message : "AblePay checkout is unavailable" });
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to create checkout" });
  }
});

router.get("/billing/ablepay/redirect/:checkoutId", async (req, res) => {
  try {
    const session = await checkoutSessionByReference(req.params.checkoutId);
    if (!session) {
      res.status(404).type("html").send(paymentResultPage("Checkout not found", "This AblePay checkout session is no longer available.", false));
      return;
    }
    const company = await companyById(session.companyId);
    const plan = await planById(session.planId);
    if (!company || !plan) {
      res.status(404).type("html").send(paymentResultPage("Checkout unavailable", "The company or subscription plan could not be found.", false));
      return;
    }
    const baseUrl = publicPortalUrl(req);
    const payment = buildAblePayPaymentFields({
      orderId: session.providerSessionId ?? session.id,
      amount: session.amount,
      currency: session.currency,
      planId: plan.id,
      companyId: company.id,
      customerName: company.name,
      customerEmail: company.email,
      customerPhone: company.contactNumber,
      address: company.address,
      returnUrl: `${baseUrl}/api/billing/ablepay/return`,
      failureUrl: `${baseUrl}/api/billing/ablepay/failure`,
      cancelUrl: `${baseUrl}/api/billing/ablepay/cancel`,
    });
    res.type("html").send(renderAblePayPaymentForm(payment));
  } catch (error) {
    res.status(503).type("html").send(paymentResultPage("AblePay is not ready", error instanceof Error ? error.message : "Payment configuration is incomplete.", false));
  }
});

async function handleAblePayBrowserResponse(req: Request, res: Response, outcome: "success" | "failure" | "cancel") {
  const payload = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const orderId = String(payload.order_id ?? "");
  if (!orderId) {
    res.status(400).type("html").send(paymentResultPage("Invalid payment response", "AblePay did not return a merchant order ID.", false));
    return;
  }
  const eventId = String(payload.transaction_id ?? `browser-${orderId}`);
  const event = await recordPaymentWebhook({
    provider: "ablepay",
    eventId: `browser:${eventId}`,
    eventType: `payment.${outcome}`,
    payload,
  });
  if (!event) {
    res.status(500).type("html").send(paymentResultPage("Payment response error", "HydraNMS could not record the AblePay response.", false));
    return;
  }
  try {
    if (!verifyAblePayResponse(payload)) {
      await updatePaymentWebhook(event.id, { status: "rejected", error: "Invalid AblePay response hash" });
      res.status(401).type("html").send(paymentResultPage("Payment response rejected", "The payment response could not be verified.", false));
      return;
    }
    if (event.status === "processed") {
      res.type("html").send(paymentResultPage("Payment already processed", "This payment response has already been applied to the account.", true));
      return;
    }
    const claimed = await claimPaymentWebhook(event.id);
    if (!claimed) {
      res.type("html").send(paymentResultPage("Payment is being processed", "The payment response is already being handled safely.", true));
      return;
    }
    const paid = outcome === "success" && String(payload.response_code ?? "") === "0";
    if (!paid) {
      const checkout = await checkoutSessionByReference(orderId);
      if (checkout) await updateCheckoutSession(checkout.id, { status: "failed" });
      await updatePaymentWebhook(event.id, { status: "ignored", processedAt: new Date() });
      res.type("html").send(paymentResultPage(outcome === "cancel" ? "Payment cancelled" : "Payment failed", String(payload.response_message ?? "No payment was captured."), false));
      return;
    }
    const activated = await activateLicenseFromCheckout(orderId);
    const delivery = await queueLicenseEmail({
      companyId: activated.company.id,
      companyEmail: activated.company.email,
      companyName: activated.company.name,
      planName: activated.plan.name,
      license: activated.license,
    });
    if (delivery) void deliverNotification(delivery.id);
    await updatePaymentWebhook(event.id, { status: "processed", processedAt: new Date() });
    res.type("html").send(paymentResultPage("Payment successful", "Your HydraNMS license is active. A license email has been queued for delivery.", true));
  } catch (error) {
    await updatePaymentWebhook(event.id, { status: "failed", error: error instanceof Error ? error.message : "Unable to process AblePay response" });
    res.status(500).type("html").send(paymentResultPage("Payment recorded for review", "The payment was received, but license activation needs administrator attention.", false));
  }
}

router.post("/billing/ablepay/return", (req, res) => {
  void handleAblePayBrowserResponse(req, res, "success");
});

router.post("/billing/ablepay/failure", (req, res) => {
  void handleAblePayBrowserResponse(req, res, "failure");
});

router.post("/billing/ablepay/cancel", (req, res) => {
  void handleAblePayBrowserResponse(req, res, "cancel");
});

router.post("/billing/webhooks/ablepay", async (req, res) => {
  const responsePayload =
    req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  if ("order_id" in responsePayload && "response_code" in responsePayload) {
    const responseCode = String(responsePayload.response_code ?? "");
    const responseMessage = String(responsePayload.response_message ?? "").toLowerCase();
    const outcome =
      responseCode === "0"
        ? "success"
        : responseMessage.includes("cancel")
          ? "cancel"
          : "failure";
    await handleAblePayBrowserResponse(req, res, outcome);
    return;
  }
  let webhook;
  try {
    webhook = parseAblePayWebhook(req.body);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid AblePay webhook" });
    return;
  }
  const event = await recordPaymentWebhook({
    provider: "ablepay",
    eventId: webhook.eventId,
    eventType: webhook.eventType,
    payload: req.body as Record<string, unknown>,
  });
  if (!event) {
    res.status(500).json({ error: "Unable to record payment webhook" });
    return;
  }
  const signature = req.header("x-ablepay-signature");
  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
  if (!verifyAblePaySignature(rawBody, signature)) {
    await updatePaymentWebhook(event.id, {
      status: "rejected",
      error: process.env.ABLEPAY_WEBHOOK_SECRET ? "Invalid webhook signature" : "ABLEPAY_WEBHOOK_SECRET is not configured",
    });
    res.status(process.env.ABLEPAY_WEBHOOK_SECRET ? 401 : 503).json({ error: "Webhook verification failed" });
    return;
  }
  if (event.status === "processed") {
    res.json({ received: true, duplicate: true });
    return;
  }
  const claimed = await claimPaymentWebhook(event.id);
  if (!claimed) {
    res.json({ received: true, duplicate: true });
    return;
  }
  const paid = ["paid", "succeeded", "success", "completed"].includes(webhook.status);
  try {
    if (!paid) {
      const checkout = await checkoutSessionByReference(webhook.checkoutId);
      if (checkout) await updateCheckoutSession(checkout.id, { status: "failed" });
      await updatePaymentWebhook(event.id, { status: "ignored", processedAt: new Date() });
      res.json({ received: true });
      return;
    }
    const checkout = await checkoutSessionByReference(webhook.checkoutId);
    if (!checkout) throw new Error("Checkout session not found");
    const metadataError = paymentMetadataMismatch(webhook, checkout);
    if (metadataError) {
      await updatePaymentWebhook(event.id, {
        status: "rejected",
        error: metadataError,
        processedAt: new Date(),
      });
      res.status(400).json({ error: "Payment metadata does not match checkout" });
      return;
    }
    const activated = await activateLicenseFromCheckout(webhook.checkoutId);
    const delivery = await queueLicenseEmail({
      companyId: activated.company.id,
      companyEmail: activated.company.email,
      companyName: activated.company.name,
      planName: activated.plan.name,
      license: activated.license,
    });
    if (delivery) void deliverNotification(delivery.id);
    await updatePaymentWebhook(event.id, { status: "processed", processedAt: new Date() });
    res.json({ received: true });
  } catch (error) {
    await updatePaymentWebhook(event.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unable to process payment webhook",
    });
    res.status(500).json({ error: "Payment confirmation was recorded but could not activate the license" });
  }
});

router.get("/billing/license", async (req, res) => {
  try {
    const value = await licenseForCompany(companyIdFromRequest(req));
    if (!value) {
      res.status(404).json({ error: "License not found" });
      return;
    }
    res.json(GetLicenseResponse.parse(await licenseResponse(value)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read license" });
  }
});

router.get("/billing/payments", async (req, res) => {
  try {
    res.json(GetPaymentRecordsResponse.parse(await listCompanyPaymentRecords(companyIdFromRequest(req))));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read payment history" });
  }
});

router.get("/admin/notifications", async (req, res) => {
  try {
    const query = GetNotificationDeliveriesQueryParams.parse(req.query);
    const result = await listNotificationHistory({
      companyId: req.auth?.user.role === "super_admin" ? undefined : companyIdFromRequest(req),
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      channel: query.channel,
      eventType: query.eventType,
      recipient: query.recipient,
    });
    res.json(
      GetNotificationDeliveriesResponse.parse({
        items: result.items.map((delivery) => notificationDeliveryResponse(delivery)),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        hasMore: result.hasMore,
      }),
    );
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read notification deliveries" });
  }
});

router.get("/admin/notifications/:id", async (req, res) => {
  try {
    const delivery = await notificationById(
      req.params.id,
      req.auth?.user.role === "super_admin" ? undefined : companyIdFromRequest(req),
    );
    if (!delivery) {
      res.status(404).json({ error: "Notification delivery not found" });
      return;
    }
    res.json(GetNotificationDeliveryResponse.parse(notificationDeliveryResponse(delivery)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read notification delivery" });
  }
});

router.post("/admin/notifications/:id/retry", async (req, res) => {
  if (req.auth?.user.role !== "super_admin") {
    res.status(403).json({ error: "Super-admin access required" });
    return;
  }
  const delivery = await retryNotification(req.params.id);
  if (!delivery) {
    const existing = await listNotifications().then((items) => items.find((item) => item.id === req.params.id));
    if (existing && existing.status === "failed" && existing.attempts >= existing.maxAttempts) {
      res.status(409).json({
        error: `This delivery has exhausted its maximum of ${existing.maxAttempts} attempts and cannot be retried.`,
      });
      return;
    }
    res.status(404).json({ error: "Failed notification delivery not found" });
    return;
  }
  const result = await deliverNotification(delivery.id);
  res.json(
    RetryNotificationResponse.parse({
      id: result?.id ?? delivery.id,
      status: result?.status ?? "queued",
    }),
  );
});

router.get("/admin/billing/webhook-events", async (req, res) => {
  if (req.auth?.user.role !== "super_admin") {
    res.status(403).json({ error: "Super-admin access required" });
    return;
  }
  const events = await listPaymentWebhooks();
  res.json(
    GetPaymentWebhookEventsResponse.parse(
      events.map((event) => ({
        id: event.id,
        provider: event.provider,
        eventId: event.eventId,
        eventType: event.eventType,
        status: event.status,
        error: event.error,
        attempts: event.attempts,
        receivedAt: event.receivedAt.toISOString(),
        processedAt: event.processedAt?.toISOString() ?? null,
      })),
    ),
  );
});

router.get("/support/tickets", async (req, res) => {
  try {
    const result = await listSupportTickets(companyIdFromRequest(req));
    res.json(GetSupportTicketsResponse.parse(result.map(supportTicketResponse)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read support tickets" });
  }
});

router.post("/support/tickets", async (req, res) => {
  const parsed = CreateSupportTicketBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    if (!req.auth?.user.id) throw new Error("Authenticated user is required");
    const ticket = await createSupportTicket({
      ...parsed.data,
      companyId: companyIdFromRequest(req),
      createdBy: req.auth.user.id,
    });
    res.status(201).json(CreateSupportTicketResponse.parse(supportTicketResponse(ticket)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to create support ticket" });
  }
});

function canManageIncidentTickets(req: Request): boolean {
  return req.auth?.user.role === "company_admin" ||
    req.auth?.user.role === "operator" ||
    req.auth?.user.role === "super_admin";
}

router.get("/tickets", async (req, res) => {
  if (!canManageIncidentTickets(req)) {
    res.status(403).json({ error: "Company-admin or operator access required" });
    return;
  }
  try {
    const tickets = await listIncidentTickets(companyIdFromRequest(req));
    res.json(GetIncidentTicketsResponse.parse(tickets.map(incidentTicketResponse)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to read incident tickets" });
  }
});

router.post("/tickets", async (req, res) => {
  if (!canManageIncidentTickets(req)) {
    res.status(403).json({ error: "Company-admin or operator access required" });
    return;
  }
  const parsed = CreateIncidentTicketBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    if (!req.auth?.user.id) throw new Error("Authenticated user is required");
    const ticket = await createIncidentTicket({
      ...parsed.data,
      companyId: companyIdFromRequest(req),
      createdBy: req.auth.user.id,
    });
    void queueCompanyTicketAlert({
      companyId: ticket.companyId,
      eventType: "ticket.opened",
      title: ticket.title,
      message: ticket.description,
      ticketId: ticket.id,
      timestamp: ticket.createdAt,
    }).catch((error) => console.error("Unable to queue manual ticket notification", error));
    res.status(201).json(CreateIncidentTicketResponse.parse(incidentTicketResponse(ticket)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to create incident ticket" });
  }
});

router.patch("/tickets/:ticketId/resolve", async (req, res) => {
  if (!canManageIncidentTickets(req)) {
    res.status(403).json({ error: "Company-admin or operator access required" });
    return;
  }
  try {
    if (!req.auth?.user.id) throw new Error("Authenticated user is required");
    const ticket = await resolveIncidentTicket(
      companyIdFromRequest(req),
      req.params.ticketId,
      req.auth.user.id,
    );
    if (!ticket) {
      res.status(404).json({ error: "Open incident ticket not found" });
      return;
    }
    void queueCompanyTicketAlert({
      companyId: ticket.companyId,
      eventType: "ticket.resolved",
      title: ticket.title,
      message: "The ticket was manually resolved by a company administrator or operator.",
      ticketId: ticket.id,
      timestamp: ticket.resolvedAt ?? ticket.updatedAt,
    }).catch((error) => console.error("Unable to queue manual ticket resolution notification", error));
    res.json(ResolveIncidentTicketResponse.parse(incidentTicketResponse(ticket)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to resolve incident ticket" });
  }
});

router.post("/auth/register", async (req, res) => {
  const parsed = RegisterUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const created = await createTenant(parsed.data);
    const company = await companyResponse(created.company.id);
    if (!company) throw new Error("Company was not persisted");
    res.status(201).json(
      RegisterUserResponse.parse({
        user: {
          id: created.user.id,
          username: created.user.username,
          email: created.user.email,
          role: created.user.role,
        name: created.user.displayName || created.user.username,
        avatarPath: created.user.avatarPath,
        },
        company,
        nextStep: "payment",
      }),
    );
  } catch (error) {
    res.status(409).json({ error: registrationErrorMessage(error) });
  }
});

router.post("/auth/login", async (req, res) => {
  const parsed = LoginUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = await findUserByIdentifier(parsed.data.identifier);
  if (!user || user.status !== "active" || !verifyPassword(parsed.data.password, user.passwordSalt, user.passwordHash)) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }
  const token = await createSession(user);
  res.cookie("hydranms_session", token, {
    ...sessionCookieOptions,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  const company = user.companyId ? await companyResponse(user.companyId) : (await listCompanyResponses())[0] ?? null;
  res.json(
    LoginUserResponse.parse({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        name: user.displayName || user.username,
        avatarPath: user.avatarPath,
      },
      company,
      token,
    }),
  );
});

router.get("/auth/profile", async (req, res) => {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const profile = await getUserProfile(req.auth.user.id);
  if (!profile) {
    res.status(404).json({ error: "User profile not found" });
    return;
  }
  res.json(profile);
});

router.patch("/auth/profile", async (req, res) => {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = UpdateUserProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const previousProfile = await getUserProfile(req.auth.user.id);
    const profile = await updateUserProfile(req.auth.user.id, parsed.data);
    if (!profile) {
      res.status(404).json({ error: "User profile not found" });
      return;
    }
    if (previousProfile?.avatarPath && previousProfile.avatarPath !== profile.avatarPath) {
      void deleteUnreferencedProfilePicture(previousProfile.avatarPath).catch((error) => {
        logger.error(
          { err: error, objectPath: previousProfile.avatarPath, userId: req.auth?.user.id },
          "Profile picture cleanup failed",
        );
      });
    }
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Unable to update user profile" });
  }
});

router.patch("/auth/profile/password", async (req, res) => {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const parsed = ChangeUserPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const profile = await updateUserPassword(
    req.auth.user.id,
    parsed.data.currentPassword,
    parsed.data.newPassword,
  );
  if (!profile) {
    res.status(400).json({ error: "Current password is incorrect" });
    return;
  }
  const user = await findUserByIdentifier(profile.username);
  if (!user) {
    res.status(404).json({ error: "User profile not found" });
    return;
  }
  const token = await createSession(user);
  res.cookie("hydranms_session", token, {
    ...sessionCookieOptions,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  res.json({ user: profile, token });
});

router.post("/auth/logout", async (req, res) => {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  await revokeSession(req.auth.sessionId);
  res.clearCookie("hydranms_session", sessionCookieOptions);
  res.status(204).end();
});

router.post("/auth/sessions/revoke", async (req, res) => {
  if (!req.auth) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  await revokeAllSessionsForUser(req.auth.user.id);
  res.clearCookie("hydranms_session", sessionCookieOptions);
  res.status(204).end();
});

export default router;