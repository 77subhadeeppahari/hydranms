import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, like, lte, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  alertSettings,
  auditLogs,
  authSessions,
  checkoutSessions,
  contactSubmissions,
  companies,
  licenses,
  monitoredDevices,
  notificationDeliveries,
  paymentWebhookEvents,
  plans,
  portalUsers,
  supportTickets,
  snmpCredentials,
  deviceInterfaces,
  deviceInterfaceSamples,
  discoveryJobs,
  incidentTickets,
  nmsAlerts,
  ponTelemetry,
  ponTelemetrySamples,
  platformCompanyProfile,
} from "@workspace/db/schema";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { decryptLicenseKey, encryptLicenseKey } from "./license-crypto";
import { decryptSecret, encryptSecret } from "./snmp-crypto";
import { ablePayAmounts, ABLEPAY_GST_RATE } from "./providers";
import { logger } from "./logger";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONTACT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const CONTACT_RATE_LIMIT_MAX = 5;
// Contact submissions contain direct personal data. Keep them for 180 days
// after receipt, then remove them regardless of review state.
export const CONTACT_SUBMISSION_RETENTION_DAYS = 180;
const CONTACT_SUBMISSION_RETENTION_MS =
  CONTACT_SUBMISSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const CONTACT_SUBMISSION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const planSeeds = [
  {
    id: "starter",
    name: "Starter",
    price: 2499,
    interval: "monthly",
    deviceLimit: 50,
    features: ["50 monitored devices", "SNMP v2c polling", "Email alerts", "Business-hours support"],
    popular: false,
  },
  {
    id: "growth",
    name: "Growth",
    price: 7499,
    interval: "monthly",
    deviceLimit: 250,
    features: ["250 monitored devices", "SNMP v1/v2c/v3", "Telegram + email alerts", "24/7 support PIN"],
    popular: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: 14999,
    interval: "monthly",
    deviceLimit: 1000,
    features: ["1,000 monitored devices", "PON/ONU optical telemetry", "Custom domains", "Priority support"],
    popular: false,
  },
] as const;

export type AuthUser = Pick<
  typeof portalUsers.$inferSelect,
  "id" | "companyId" | "username" | "displayName" | "email" | "avatarPath" | "role" | "status"
>;

export type AuthContext = {
  user: AuthUser;
  companyId: string | null;
  sessionId: string;
};

export function contactIpHash(ipAddress: string): string {
  return createHmac("sha256", process.env.SESSION_SECRET ?? "hydranms-contact-rate-limit")
    .update(ipAddress)
    .digest("hex");
}

export function contactSubmissionRetentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - CONTACT_SUBMISSION_RETENTION_MS);
}

export async function createContactSubmission(input: {
  name: string;
  email: string;
  company?: string;
  message: string;
  ipHash: string;
  website?: string;
}) {
  if (input.website?.trim()) {
    return { accepted: false as const, reason: "honeypot" as const };
  }

  const since = new Date(Date.now() - CONTACT_RATE_LIMIT_WINDOW_MS);
  const [{ total }] = await db
    .select({ total: count() })
    .from(contactSubmissions)
    .where(and(eq(contactSubmissions.ipHash, input.ipHash), gte(contactSubmissions.createdAt, since)));
  if (Number(total) >= CONTACT_RATE_LIMIT_MAX) {
    return { accepted: false as const, reason: "rate_limit" as const };
  }

  const [submission] = await db
    .insert(contactSubmissions)
    .values({
      id: `CONTACT-${randomUUID()}`,
      name: input.name.trim(),
      email: normalized(input.email),
      company: input.company?.trim() ?? "",
      message: input.message.trim(),
      ipHash: input.ipHash,
    })
    .returning({ id: contactSubmissions.id });
  return { accepted: true as const, id: submission.id };
}

export async function purgeExpiredContactSubmissions(input: {
  now?: Date;
  actorUserId?: string | null;
} = {}) {
  const cutoff = contactSubmissionRetentionCutoff(input.now);
  const deleted = await db
    .delete(contactSubmissions)
    .where(lt(contactSubmissions.createdAt, cutoff))
    .returning({ id: contactSubmissions.id });

  if (deleted.length > 0) {
    await db.insert(auditLogs).values({
      id: `audit-${randomUUID()}`,
      companyId: null,
      actorUserId: input.actorUserId ?? null,
      action: "contact_submissions.purged",
      targetType: "contact_submissions",
      targetId: null,
      metadata: {
        deletedCount: deleted.length,
        retentionDays: CONTACT_SUBMISSION_RETENTION_DAYS,
        cutoff: cutoff.toISOString(),
      },
    });
  }

  return {
    deletedCount: deleted.length,
    retentionDays: CONTACT_SUBMISSION_RETENTION_DAYS,
    cutoff,
  };
}

export function startContactSubmissionCleanup() {
  const run = () => purgeExpiredContactSubmissions()
    .then(({ deletedCount, cutoff }) => {
      logger.info(
        { deletedCount, cutoff: cutoff.toISOString() },
        "Contact submission retention cleanup completed",
      );
    })
    .catch((error) => {
      logger.error({ err: error }, "Contact submission retention cleanup failed");
    });
  void run();
  const timer = setInterval(run, CONTACT_SUBMISSION_CLEANUP_INTERVAL_MS);
  timer.unref();
  return timer;
}

export async function listContactSubmissions() {
  const submissions = await db
    .select({
      id: contactSubmissions.id,
      name: contactSubmissions.name,
      email: contactSubmissions.email,
      company: contactSubmissions.company,
      message: contactSubmissions.message,
      handled: contactSubmissions.handled,
      internalNote: contactSubmissions.internalNote,
      createdAt: contactSubmissions.createdAt,
    })
    .from(contactSubmissions)
    .orderBy(desc(contactSubmissions.createdAt), desc(contactSubmissions.id));

  return submissions.map((submission) => ({
    id: submission.id,
    name: submission.name,
    email: submission.email,
    company: submission.company,
    message: submission.message,
    handled: submission.handled,
    internalNote: submission.internalNote,
    receivedAt: submission.createdAt.toISOString(),
  }));
}

export async function updateContactSubmission(
  id: string,
  input: { handled: boolean; internalNote?: string | null },
) {
  const [submission] = await db
    .update(contactSubmissions)
    .set({
      handled: input.handled,
      internalNote: input.internalNote?.trim() || null,
    })
    .where(eq(contactSubmissions.id, id))
    .returning({
      id: contactSubmissions.id,
      name: contactSubmissions.name,
      email: contactSubmissions.email,
      company: contactSubmissions.company,
      message: contactSubmissions.message,
      handled: contactSubmissions.handled,
      internalNote: contactSubmissions.internalNote,
      createdAt: contactSubmissions.createdAt,
    });

  if (!submission) return null;
  return {
    id: submission.id,
    name: submission.name,
    email: submission.email,
    company: submission.company,
    message: submission.message,
    handled: submission.handled,
    internalNote: submission.internalNote,
    receivedAt: submission.createdAt.toISOString(),
  };
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: scryptSync(password, salt, 64).toString("hex"),
  };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function ensurePortalData(): Promise<void> {
  await db
    .insert(platformCompanyProfile)
    .values({
      id: "default",
      companyName: "HydraNMS Technologies Pvt. Ltd.",
      address: "",
      gstNumber: null,
      phoneNumber: "",
      email: "",
      logoPath: null,
    })
    .onConflictDoNothing({ target: platformCompanyProfile.id });
  for (const plan of planSeeds) {
    await db
      .insert(plans)
      .values({ ...plan, features: [...plan.features] })
      .onConflictDoNothing({ target: plans.id });
  }
  const adminPassword = process.env.SUPERADMIN_PASSWORD?.trim();
  if (!adminPassword) return;
  const username = normalized(process.env.SUPERADMIN_USERNAME ?? "superadmin-admin");
  const email = normalized(process.env.SUPERADMIN_EMAIL ?? "superadmin-admin@hydranms.in");
  const existing = await db
    .select()
    .from(portalUsers)
    .where(or(eq(portalUsers.email, email), eq(portalUsers.username, username)))
    .limit(1);
  const password = hashPassword(adminPassword);
  if (existing[0]) {
    await db
      .update(portalUsers)
      .set({
        email,
        username,
        companyId: null,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        role: "super_admin",
        status: "active",
        updatedAt: new Date(),
      })
      .where(eq(portalUsers.id, existing[0].id));
    return;
  }
  await db.insert(portalUsers).values({
    id: `usr-${randomUUID()}`,
    companyId: null,
    username,
    email,
    passwordHash: password.hash,
    passwordSalt: password.salt,
    role: "super_admin",
    status: "active",
  });
}

export async function findUserByIdentifier(identifier: string): Promise<typeof portalUsers.$inferSelect | null> {
  const value = normalized(identifier);
  const result = await db
    .select()
    .from(portalUsers)
    .where(or(eq(portalUsers.email, value), eq(portalUsers.username, value)))
    .limit(1);
  return result[0] ?? null;
}

export function userProfileResponse(user: typeof portalUsers.$inferSelect) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    name: user.displayName || user.username,
    avatarPath: user.avatarPath,
  };
}

export async function getUserProfile(userId: string) {
  const [user] = await db.select().from(portalUsers).where(eq(portalUsers.id, userId)).limit(1);
  return user ? userProfileResponse(user) : null;
}

export async function profilePictureReferences(objectPath: string): Promise<{
  userIds: string[];
  platformLogo: boolean;
}> {
  const [users, platformProfiles] = await Promise.all([
    db
      .select({ id: portalUsers.id })
      .from(portalUsers)
      .where(eq(portalUsers.avatarPath, objectPath)),
    db
      .select({ id: platformCompanyProfile.id })
      .from(platformCompanyProfile)
      .where(eq(platformCompanyProfile.logoPath, objectPath))
      .limit(1),
  ]);

  return {
    userIds: users.map((user) => user.id),
    platformLogo: platformProfiles.length > 0,
  };
}

export async function referencedProfilePicturePaths(): Promise<Set<string>> {
  const [users, platformProfiles] = await Promise.all([
    db
      .select({ avatarPath: portalUsers.avatarPath })
      .from(portalUsers)
      .where(sql`${portalUsers.avatarPath} IS NOT NULL`),
    db
      .select({ logoPath: platformCompanyProfile.logoPath })
      .from(platformCompanyProfile)
      .where(sql`${platformCompanyProfile.logoPath} IS NOT NULL`),
  ]);

  return new Set([
    ...users.map((user) => user.avatarPath),
    ...platformProfiles.map((profile) => profile.logoPath),
  ].filter((path): path is string => Boolean(path)));
}

export async function updateUserProfile(
  userId: string,
  input: { name: string; avatarPath?: string | null },
) {
  const [user] = await db
    .update(portalUsers)
    .set({
      displayName: input.name.trim(),
      ...(input.avatarPath !== undefined ? { avatarPath: input.avatarPath } : {}),
      updatedAt: new Date(),
    })
    .where(eq(portalUsers.id, userId))
    .returning();
  return user ? userProfileResponse(user) : null;
}

export async function changeUserPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
) {
  const [user] = await db.select().from(portalUsers).where(eq(portalUsers.id, userId)).limit(1);
  if (!user || !verifyPassword(currentPassword, user.passwordSalt, user.passwordHash)) return null;
  const password = hashPassword(newPassword);
  const [updated] = await db
    .update(portalUsers)
    .set({ passwordHash: password.hash, passwordSalt: password.salt, updatedAt: new Date() })
    .where(eq(portalUsers.id, userId))
    .returning();
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
  return updated ? userProfileResponse(updated) : null;
}

export type ManagedUserRole = "company_admin" | "operator";
export type ManagedUserStatus = "active" | "inactive";

export function companyUserResponse(user: typeof portalUsers.$inferSelect) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role as ManagedUserRole,
    status: user.status as ManagedUserStatus,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function listCompanyUsers(companyId: string) {
  const users = await db
    .select()
    .from(portalUsers)
    .where(eq(portalUsers.companyId, companyId))
    .orderBy(asc(portalUsers.username));
  return users.map(companyUserResponse);
}

export async function createCompanyUser(input: {
  companyId: string;
  username: string;
  email: string;
  password: string;
  role: ManagedUserRole;
}) {
  const company = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  if (!company[0]) throw new Error("Company not found");
  const password = hashPassword(input.password);
  const [user] = await db
    .insert(portalUsers)
    .values({
      id: `usr-${randomUUID()}`,
      companyId: input.companyId,
      username: normalized(input.username),
      email: normalized(input.email),
      passwordHash: password.hash,
      passwordSalt: password.salt,
      role: input.role,
      status: "active",
    })
    .returning();
  return companyUserResponse(user);
}

export async function updateCompanyUser(
  companyId: string,
  userId: string,
  input: { role?: ManagedUserRole; status?: ManagedUserStatus },
) {
  const [user] = await db
    .update(portalUsers)
    .set({
      ...(input.role ? { role: input.role } : {}),
      ...(input.status ? { status: input.status } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(portalUsers.id, userId), eq(portalUsers.companyId, companyId)))
    .returning();
  return user ? companyUserResponse(user) : null;
}

export async function createTenant(input: {
  companyName: string;
  subdomain: string;
  email: string;
  contactNumber: string;
  gstNumber?: string | null;
  address: string;
  username: string;
  password: string;
}) {
  const now = new Date();
  const companyId = `co-${randomUUID()}`;
  const userId = `usr-${randomUUID()}`;
  const password = hashPassword(input.password);
  const subdomain = normalized(input.subdomain).replace(/\.hydranms\.in$/, "");
  const email = normalized(input.email);
  const username = normalized(input.username);
  const expiresAt = new Date(now);
  expiresAt.setUTCDate(expiresAt.getUTCDate() - 1);
  const expiresDate = expiresAt.toISOString().slice(0, 10);
  const licenseKey = `HYDRA-START-${randomBytes(8).toString("hex").toUpperCase()}`;

  return db.transaction(async (tx) => {
    const [company] = await tx
      .insert(companies)
      .values({
        id: companyId,
        name: input.companyName.trim(),
        subdomain,
        email,
        contactNumber: input.contactNumber.trim(),
        gstNumber: input.gstNumber?.trim() || null,
        address: input.address.trim(),
        status: "pending",
      })
      .returning();
    const [user] = await tx
      .insert(portalUsers)
      .values({
        id: userId,
        companyId,
        username,
        email,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        role: "company_admin",
        status: "active",
      })
      .returning();
    await tx.insert(licenses).values({
      id: `lic-${randomUUID()}`,
      companyId,
      planId: "starter",
      key: createHash("sha256").update(licenseKey).digest("hex"),
      encryptedKey: encryptLicenseKey(licenseKey),
      keyHash: createHash("sha256").update(licenseKey).digest("hex"),
      status: "expired",
      expiresAt: expiresDate,
      issuedTo: input.companyName.trim(),
    });
    await tx.insert(alertSettings).values({
      id: `alerts-${randomUUID()}`,
      companyId,
      emailEnabled: false,
      emailAddress: email,
      telegramEnabled: false,
    });
    await tx.insert(auditLogs).values({
      id: `audit-${randomUUID()}`,
      companyId,
      actorUserId: userId,
      action: "tenant.registered",
      targetType: "company",
      targetId: companyId,
      metadata: { subdomain },
    });
    return { company, user };
  });
}

export async function createCompany(input: {
  name: string;
  subdomain: string;
  email: string;
  contactNumber: string;
  gstNumber?: string | null;
  address: string;
  status?: string;
}) {
  const companyId = `co-${randomUUID()}`;
  const subdomain = normalized(input.subdomain).replace(/\.hydranms\.in$/, "");
  const [company] = await db
    .insert(companies)
    .values({
      id: companyId,
      name: input.name.trim(),
      subdomain,
      email: normalized(input.email),
      contactNumber: input.contactNumber.trim(),
      gstNumber: input.gstNumber?.trim() || null,
      address: input.address.trim(),
      status: input.status ?? "pending",
    })
    .returning();
  const expiresAt = new Date();
  expiresAt.setUTCDate(expiresAt.getUTCDate() - 1);
  const licenseKey = `HYDRA-START-${randomBytes(8).toString("hex").toUpperCase()}`;
  const licenseKeyHash = createHash("sha256").update(licenseKey).digest("hex");
  await db.insert(licenses).values({
    id: `lic-${randomUUID()}`,
    companyId,
    planId: "starter",
    key: licenseKeyHash,
    encryptedKey: encryptLicenseKey(licenseKey),
    keyHash: licenseKeyHash,
    status: "expired",
    expiresAt: expiresAt.toISOString().slice(0, 10),
    issuedTo: company.name,
  });
  await db.insert(alertSettings).values({
    id: `alerts-${randomUUID()}`,
    companyId,
    emailEnabled: false,
    emailAddress: company.email,
    telegramEnabled: false,
  });
  return companyResponse(companyId);
}

export async function updateCompany(
  companyId: string,
  input: {
    name: string;
    subdomain: string;
    email: string;
    contactNumber: string;
    gstNumber?: string | null;
    address: string;
  },
) {
  const [company] = await db
    .update(companies)
    .set({
      name: input.name.trim(),
      subdomain: normalized(input.subdomain).replace(/\.hydranms\.in$/, ""),
      email: normalized(input.email),
      contactNumber: input.contactNumber.trim(),
      gstNumber: input.gstNumber?.trim() || null,
      address: input.address.trim(),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId))
    .returning();
  return company ? companyResponse(companyId) : null;
}

export async function updateCompanyProfile(
  companyId: string,
  input: {
    name: string;
    email: string;
    contactNumber: string;
    gstNumber?: string | null;
    address: string;
  },
) {
  const [company] = await db
    .update(companies)
    .set({
      name: input.name.trim(),
      email: normalized(input.email),
      contactNumber: input.contactNumber.trim(),
      gstNumber: input.gstNumber?.trim() || null,
      address: input.address.trim(),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId))
    .returning();
  return company ? companyResponse(companyId) : null;
}

export async function deleteCompany(companyId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deviceRows = await tx
      .select({ id: monitoredDevices.id })
      .from(monitoredDevices)
      .where(eq(monitoredDevices.companyId, companyId));
    const deviceIds = deviceRows.map((device) => device.id);

    if (deviceIds.length) {
      await tx.delete(deviceInterfaceSamples).where(inArray(deviceInterfaceSamples.deviceId, deviceIds));
      await tx.delete(ponTelemetrySamples).where(inArray(ponTelemetrySamples.deviceId, deviceIds));
      await tx.delete(deviceInterfaces).where(inArray(deviceInterfaces.deviceId, deviceIds));
      await tx.delete(ponTelemetry).where(inArray(ponTelemetry.deviceId, deviceIds));
    }
    await tx.delete(monitoredDevices).where(eq(monitoredDevices.companyId, companyId));
    await tx.delete(snmpCredentials).where(eq(snmpCredentials.companyId, companyId));
    await tx.delete(nmsAlerts).where(eq(nmsAlerts.companyId, companyId));
    await tx.delete(incidentTickets).where(eq(incidentTickets.companyId, companyId));
    await tx.delete(discoveryJobs).where(eq(discoveryJobs.companyId, companyId));
    await tx.delete(licenses).where(eq(licenses.companyId, companyId));
    await tx.delete(checkoutSessions).where(eq(checkoutSessions.companyId, companyId));
    await tx.delete(notificationDeliveries).where(eq(notificationDeliveries.companyId, companyId));
    await tx.delete(supportTickets).where(eq(supportTickets.companyId, companyId));
    await tx.delete(alertSettings).where(eq(alertSettings.companyId, companyId));
    await tx.delete(authSessions).where(eq(authSessions.companyId, companyId));
    await tx.delete(portalUsers).where(eq(portalUsers.companyId, companyId));
    await tx.delete(auditLogs).where(eq(auditLogs.companyId, companyId));
    const deleted = await tx.delete(companies).where(eq(companies.id, companyId)).returning({ id: companies.id });
    return deleted.length > 0;
  });
}

export async function createSession(user: AuthUser): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await db.insert(authSessions).values({
    id: `session-${randomUUID()}`,
    tokenHash: hashSessionToken(token),
    userId: user.id,
    companyId: user.companyId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    lastUsedAt: now,
  });
  return token;
}

export async function authContextFromToken(token: string): Promise<AuthContext | null> {
  const result = await db
    .select({
      session: authSessions,
      user: portalUsers,
    })
    .from(authSessions)
    .innerJoin(portalUsers, eq(authSessions.userId, portalUsers.id))
    .where(eq(authSessions.tokenHash, hashSessionToken(token)))
    .limit(1);
  const row = result[0];
  if (!row || row.session.revokedAt || row.session.expiresAt <= new Date() || row.user.status !== "active") {
    return null;
  }
  await db
    .update(authSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(authSessions.id, row.session.id));
  return {
    user: {
      id: row.user.id,
      companyId: row.user.companyId,
      username: row.user.username,
        displayName: row.user.displayName,
      email: row.user.email,
        avatarPath: row.user.avatarPath,
      role: row.user.role,
      status: row.user.status,
    },
    companyId: row.session.companyId,
    sessionId: row.session.id,
  };
}

export async function authContextFromSessionId(
  sessionId: string,
  expectedUserId: string,
  expectedCompanyId: string,
): Promise<AuthContext | null> {
  const result = await db
    .select({
      session: authSessions,
      user: portalUsers,
    })
    .from(authSessions)
    .innerJoin(portalUsers, eq(authSessions.userId, portalUsers.id))
    .where(eq(authSessions.id, sessionId))
    .limit(1);
  const row = result[0];
  if (
    !row ||
    row.session.userId !== expectedUserId ||
    (row.user.role !== "super_admin" &&
      (row.session.companyId !== expectedCompanyId || row.user.companyId !== expectedCompanyId)) ||
    row.session.revokedAt ||
    row.session.expiresAt <= new Date() ||
    row.user.status !== "active"
  ) {
    return null;
  }
  return {
    user: {
      id: row.user.id,
      companyId: row.user.companyId,
      username: row.user.username,
      displayName: row.user.displayName,
      email: row.user.email,
      avatarPath: row.user.avatarPath,
      role: row.user.role,
      status: row.user.status,
    },
    companyId: row.user.role === "super_admin" ? expectedCompanyId : row.session.companyId,
    sessionId: row.session.id,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)));
}

export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
}

async function companyToResponse(
  company: typeof companies.$inferSelect,
  deviceCount: number,
  license: typeof licenses.$inferSelect | null,
  plan: typeof plans.$inferSelect | null,
) {
  return {
    id: company.id,
    name: company.name,
    subdomain: `${company.subdomain}.hydranms.in`,
    email: company.email,
    contactNumber: company.contactNumber,
    gstNumber: company.gstNumber,
    address: company.address,
    status: company.status,
    devices: deviceCount,
    plan: plan?.name ?? "Starter",
    renewalDate: license?.expiresAt ?? "—",
    licenseNumber: license ? await readableLicenseKey(license) : "—",
    licenseStatus: license?.status ?? "expired",
    licenseValidity: license?.expiresAt ?? "—",
  };
}

export async function companyResponse(companyId: string) {
  const companyResult = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const company = companyResult[0];
  if (!company) return null;
  const [deviceResult, licenseResult] = await Promise.all([
    db
      .select({ count: count() })
      .from(monitoredDevices)
      .where(eq(monitoredDevices.companyId, companyId)),
    db.select().from(licenses).where(eq(licenses.companyId, companyId)).limit(1),
  ]);
  const license = licenseResult[0] ?? null;
  const planResult = license
    ? await db.select().from(plans).where(eq(plans.id, license.planId)).limit(1)
    : [];
  return companyToResponse(company, Number(deviceResult[0]?.count ?? 0), license, planResult[0] ?? null);
}

export async function listCompanyResponses() {
  const rows = await db.select().from(companies).orderBy(asc(companies.createdAt));
  const results = [];
  for (const company of rows) {
    const response = await companyResponse(company.id);
    if (response) results.push(response);
  }
  return results;
}

export async function listPlans() {
  return db.select().from(plans).orderBy(asc(plans.price));
}

export async function planById(id: string) {
  const result = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  return result[0] ?? null;
}

export async function createPlan(input: {
  id: string;
  name: string;
  price: number;
  interval: string;
  deviceLimit: number;
  features: string[];
  popular: boolean;
}) {
  const result = await db.insert(plans).values(input).returning();
  return result[0] ?? null;
}

export async function updatePlan(
  id: string,
  input: {
    name: string;
    price: number;
    interval: string;
    deviceLimit: number;
    features: string[];
    popular: boolean;
  },
) {
  const result = await db
    .update(plans)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(plans.id, id))
    .returning();
  return result[0] ?? null;
}

export async function licenseForCompany(companyId: string) {
  const result = await db
    .select({ license: licenses, plan: plans })
    .from(licenses)
    .innerJoin(plans, eq(licenses.planId, plans.id))
    .where(eq(licenses.companyId, companyId))
    .limit(1);
  return result[0] ?? null;
}

export async function updateCompanyLicense(
  companyId: string,
  input: { status: string; planId: string; expiresAt: string },
  actorUserId: string,
) {
  const existing = await licenseForCompany(companyId);
  const values = {
    planId: input.planId,
    status: input.status,
    expiresAt: input.expiresAt,
    updatedAt: new Date(),
  };
  const license = existing
    ? (await db.update(licenses).set(values).where(eq(licenses.companyId, companyId)).returning())[0]
    : (
          await (async () => {
            const licenseKey = `HYDRA-${randomBytes(8).toString("hex").toUpperCase()}`;
            const licenseKeyHash = createHash("sha256").update(licenseKey).digest("hex");
            return db
              .insert(licenses)
              .values({
                id: `lic-${randomUUID()}`,
                companyId,
                key: licenseKeyHash,
                encryptedKey: encryptLicenseKey(licenseKey),
                keyHash: licenseKeyHash,
                issuedTo: (await companyResponse(companyId))?.name ?? companyId,
                ...values,
              })
              .returning();
          })()
      )[0];
  await db.insert(auditLogs).values({
    id: `audit-${randomUUID()}`,
    companyId,
    actorUserId,
    action: "license.updated",
    targetType: "license",
    targetId: license?.id ?? null,
    metadata: values,
  });
  return license ? licenseForCompany(companyId) : null;
}

export async function listSupportTickets(companyId: string) {
  return db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.companyId, companyId))
    .orderBy(desc(supportTickets.createdAt));
}

export async function listTenantAuditLogs(companyId: string, limit = 100) {
  return db
    .select({
      id: auditLogs.id,
      companyId: auditLogs.companyId,
      actorUserId: auditLogs.actorUserId,
      actorName: portalUsers.displayName,
      actorUsername: portalUsers.username,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(portalUsers, eq(portalUsers.id, auditLogs.actorUserId))
    .where(eq(auditLogs.companyId, companyId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export async function createSupportTicket(input: {
  companyId: string;
  createdBy: string;
  subject: string;
  priority: string;
  message: string;
}) {
  const supportPin = String(randomBytes(2).readUInt16BE(0) % 9000 + 1000);
  const [ticket] = await db
    .insert(supportTickets)
    .values({
      id: `SUP-${randomUUID()}`,
      companyId: input.companyId,
      createdBy: input.createdBy,
      subject: input.subject.trim(),
      priority: input.priority,
      message: input.message.trim(),
      supportPin,
    })
    .returning();
  await db.insert(auditLogs).values({
    id: `audit-${randomUUID()}`,
    companyId: input.companyId,
    actorUserId: input.createdBy,
    action: "support_ticket.created",
    targetType: "support_ticket",
    targetId: ticket.id,
    metadata: { priority: input.priority },
  });
  return ticket;
}

export function supportTicketResponse(ticket: typeof supportTickets.$inferSelect) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    createdAt: ticket.createdAt.toISOString(),
    lastUpdated: ticket.updatedAt.toISOString(),
    supportPin: ticket.supportPin,
  };
}

export async function licenseResponse(
  value: NonNullable<Awaited<ReturnType<typeof licenseForCompany>>>,
) {
  return {
    key: await readableLicenseKey(value.license),
    status: value.license.status,
    plan: value.plan.name,
    expiresAt: value.license.expiresAt,
    deviceLimit: value.plan.deviceLimit,
    issuedTo: value.license.issuedTo,
  };
}

async function readableLicenseKey(license: typeof licenses.$inferSelect): Promise<string> {
  if (license.encryptedKey) {
    try {
      return decryptLicenseKey(license.encryptedKey);
    } catch {
      // The encrypted value may have been created with a previous server secret.
      // Reissue the displayable key below and protect it with the current secret.
    }
  }

  const key = license.key.startsWith("HYDRA-")
    ? license.key
    : `HYDRA-${randomBytes(8).toString("hex").toUpperCase()}`;
  const keyHash = createHash("sha256").update(key).digest("hex");
  const encryptedKey = encryptLicenseKey(key);
  await db
    .update(licenses)
    .set({ key: keyHash, encryptedKey, keyHash, updatedAt: new Date() })
    .where(eq(licenses.id, license.id));
  return key;
}

export type PlatformCompanyProfileInput = {
  companyName: string;
  address: string;
  gstNumber?: string | null;
  phoneNumber: string;
  email: string;
  logoPath?: string | null;
};

export async function getPlatformCompanyProfile() {
  const [profile] = await db
    .select()
    .from(platformCompanyProfile)
    .where(eq(platformCompanyProfile.id, "default"))
    .limit(1);
  if (profile) return profile;
  const [created] = await db
    .insert(platformCompanyProfile)
    .values({
      id: "default",
      companyName: "HydraNMS Technologies Pvt. Ltd.",
      address: "",
      gstNumber: null,
      phoneNumber: "",
      email: "",
      logoPath: null,
    })
    .returning();
  return created;
}

export async function updatePlatformCompanyProfile(input: PlatformCompanyProfileInput) {
  const [profile] = await db
    .insert(platformCompanyProfile)
    .values({
      id: "default",
      companyName: input.companyName.trim(),
      address: input.address.trim(),
      gstNumber: input.gstNumber?.trim() || null,
      phoneNumber: input.phoneNumber.trim(),
      email: input.email.trim().toLowerCase(),
      logoPath: input.logoPath?.trim() || null,
    })
    .onConflictDoUpdate({
      target: platformCompanyProfile.id,
      set: {
        companyName: input.companyName.trim(),
        address: input.address.trim(),
        gstNumber: input.gstNumber?.trim() || null,
        phoneNumber: input.phoneNumber.trim(),
        email: input.email.trim().toLowerCase(),
        logoPath: input.logoPath?.trim() || null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return profile;
}

export { normalized };

export async function alertSettingsForCompany(companyId: string) {
  const result = await db.select().from(alertSettings).where(eq(alertSettings.companyId, companyId)).limit(1);
  return result[0] ?? null;
}

export async function telegramBotTokenForCompany(companyId: string | null | undefined): Promise<string | null> {
  const settings = companyId ? await alertSettingsForCompany(companyId) : null;
  if (settings?.telegramBotTokenEncrypted) {
    return decryptSecret(settings.telegramBotTokenEncrypted);
  }
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

export async function ticketTelegramBotTokenForCompany(companyId: string | null | undefined): Promise<string | null> {
  const settings = companyId ? await alertSettingsForCompany(companyId) : null;
  if (settings?.ticketTelegramBotTokenEncrypted) {
    return decryptSecret(settings.ticketTelegramBotTokenEncrypted);
  }
  return null;
}

export async function updateAlertSettings(
  companyId: string,
  input: {
    emailEnabled: boolean;
    emailAddress: string | null;
    telegramEnabled: boolean;
    telegramChatId: string | null;
    telegramBotTokenEncrypted: string | null;
    ticketTelegramEnabled: boolean;
    ticketTelegramChatId: string | null;
    ticketTelegramBotTokenEncrypted: string | null;
    rxPowerLowThreshold: number | null;
    rxPowerHighThreshold: number | null;
    txPowerLowThreshold: number | null;
    txPowerHighThreshold: number | null;
  },
) {
  const [settings] = await db
    .insert(alertSettings)
    .values({ id: `alerts-${randomUUID()}`, companyId, ...input })
    .onConflictDoUpdate({
      target: alertSettings.companyId,
      set: { ...input, updatedAt: new Date() },
    })
    .returning();
  return settings;
}

export async function listIncidentTickets(companyId: string) {
  return db
    .select()
    .from(incidentTickets)
    .where(eq(incidentTickets.companyId, companyId))
    .orderBy(desc(incidentTickets.updatedAt));
}

export async function createIncidentTicket(input: {
  companyId: string;
  createdBy: string;
  title: string;
  description: string;
  priority: string;
}) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const id = await nextIncidentTicketId(tx, now);
    const [ticket] = await tx
      .insert(incidentTickets)
      .values({
        id,
        companyId: input.companyId,
        sourceType: "manual",
        sourceKey: `manual:${randomUUID()}`,
        title: input.title.trim(),
        description: input.description.trim(),
        priority: input.priority,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return ticket;
  });
}

type IncidentTicketTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextIncidentTicketId(tx: IncidentTicketTransaction, date: Date) {
  const year = Number(
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", year: "numeric" }).format(date),
  );
  const prefix = `HYD/${year}/`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`incident-ticket:${year}`}))`);
  const result = await tx.execute<{ id: string }>(
    sql`select ${incidentTickets.id} as id
        from ${incidentTickets}
        where ${incidentTickets.id} like ${`${prefix}%`}
        order by ${incidentTickets.id} desc
        limit 1`,
  );
  const previous = result.rows[0]?.id;
  const lastNumber = previous ? Number(previous.slice(prefix.length)) : 0;
  return `${prefix}${String(lastNumber + 1).padStart(4, "0")}`;
}

export async function openAutomaticIncidentTicket(input: {
  companyId: string;
  sourceKey: string;
  deviceId: string;
  ifIndex?: number;
  title: string;
  description: string;
  priority: string;
}) {
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`incident-ticket-source:${input.companyId}:${input.sourceKey}`}))`);
    const existing = await tx
      .select()
      .from(incidentTickets)
      .where(and(eq(incidentTickets.companyId, input.companyId), eq(incidentTickets.sourceKey, input.sourceKey)))
      .limit(1);
    if (existing[0]) {
      return { ticket: existing[0], opened: false };
    }
    const [ticket] = await tx
      .insert(incidentTickets)
      .values({
        id: await nextIncidentTicketId(tx, now),
        companyId: input.companyId,
        sourceType: input.ifIndex === undefined ? "device" : "port",
        sourceKey: input.sourceKey,
        deviceId: input.deviceId,
        ifIndex: input.ifIndex,
        title: input.title,
        description: input.description,
        priority: input.priority,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return { ticket, opened: true };
  });
}

export async function resolveAutomaticIncidentTicket(companyId: string, sourceKey: string) {
  const openTickets = await db
    .select()
    .from(incidentTickets)
    .where(
      and(
        eq(incidentTickets.companyId, companyId),
        or(
          eq(incidentTickets.sourceKey, sourceKey),
          like(incidentTickets.sourceKey, `${sourceKey}:%`),
        ),
        eq(incidentTickets.status, "open"),
      ),
    )
    .orderBy(desc(incidentTickets.createdAt))
    .limit(1);
  if (!openTickets[0]) return null;
  const [ticket] = await db
    .update(incidentTickets)
    .set({
      status: "resolved",
      autoResolved: true,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(incidentTickets.id, openTickets[0].id),
        eq(incidentTickets.companyId, companyId),
        eq(incidentTickets.status, "open"),
      ),
    )
    .returning();
  return ticket ?? null;
}

export async function resolveIncidentTicket(companyId: string, ticketId: string, userId: string) {
  const [ticket] = await db
    .update(incidentTickets)
    .set({
      status: "resolved",
      autoResolved: false,
      resolvedBy: userId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(incidentTickets.id, ticketId),
        eq(incidentTickets.companyId, companyId),
        eq(incidentTickets.status, "open"),
      ),
    )
    .returning();
  return ticket ?? null;
}

export function incidentTicketResponse(ticket: typeof incidentTickets.$inferSelect) {
  return {
    id: ticket.id,
    companyId: ticket.companyId,
    sourceType: ticket.sourceType,
    deviceId: ticket.deviceId,
    ifIndex: ticket.ifIndex,
    title: ticket.title,
    description: ticket.description,
    priority: ticket.priority,
    status: ticket.status,
    autoResolved: ticket.autoResolved,
    createdBy: ticket.createdBy,
    resolvedBy: ticket.resolvedBy,
    resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
  };
}

export async function createCheckoutSession(input: {
  companyId: string;
  planId: string;
  amount: number;
  currency: string;
}) {
  const [session] = await db
    .insert(checkoutSessions)
    .values({
      id: `checkout-${randomUUID()}`,
      companyId: input.companyId,
      planId: input.planId,
      amount: input.amount,
      currency: input.currency,
    })
    .returning();
  return session;
}

export async function recordPaymentWebhook(input: {
  provider: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  const [event] = await db
    .insert(paymentWebhookEvents)
    .values({
      id: `payment-event-${randomUUID()}`,
      provider: input.provider,
      eventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload,
      attempts: 0,
    })
    .onConflictDoNothing({
      target: [paymentWebhookEvents.provider, paymentWebhookEvents.eventId],
    })
    .returning();
  if (event) return event;
  const existing = await db
    .select()
    .from(paymentWebhookEvents)
    .where(
      and(
        eq(paymentWebhookEvents.provider, input.provider),
        eq(paymentWebhookEvents.eventId, input.eventId),
      ),
    )
    .limit(1);
  return existing[0] ?? null;
}

export async function claimPaymentWebhook(id: string) {
  const [event] = await db
    .update(paymentWebhookEvents)
    .set({
      status: "processing",
      attempts: sql`${paymentWebhookEvents.attempts} + 1`,
    })
    .where(
      and(
        eq(paymentWebhookEvents.id, id),
        inArray(paymentWebhookEvents.status, ["received", "failed", "rejected"]),
      ),
    )
    .returning();
  return event ?? null;
}

export async function licenseSecret(license: typeof licenses.$inferSelect): Promise<string> {
  return readableLicenseKey(license);
}

export async function queueNotification(input: {
  companyId: string | null;
  channel: string;
  eventType: string;
  recipient: string;
  subject?: string | null;
  body: string;
  idempotencyKey: string;
}) {
  const [delivery] = await db
    .insert(notificationDeliveries)
    .values({
      id: `delivery-${randomUUID()}`,
      companyId: input.companyId,
      channel: input.channel,
      eventType: input.eventType,
      recipient: input.recipient,
      subject: input.subject ?? null,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: notificationDeliveries.idempotencyKey })
    .returning();
  if (delivery) return delivery;
  const existing = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.idempotencyKey, input.idempotencyKey))
    .limit(1);
  return existing[0] ?? null;
}

export async function listPaymentWebhooks() {
  return db.select().from(paymentWebhookEvents).orderBy(desc(paymentWebhookEvents.receivedAt)).limit(100);
}

export async function companyById(companyId: string) {
  const result = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  return result[0] ?? null;
}

export async function claimNotification(id: string) {
  const [delivery] = await db
    .update(notificationDeliveries)
    .set({ status: "sending", updatedAt: new Date() })
    .where(
      and(
        eq(notificationDeliveries.id, id),
        inArray(notificationDeliveries.status, ["queued", "failed"]),
        lte(notificationDeliveries.nextAttemptAt, new Date()),
        lt(notificationDeliveries.attempts, notificationDeliveries.maxAttempts),
      ),
    )
    .returning();
  return delivery ?? null;
}

export async function updateCheckoutSession(
  id: string,
  input: { status?: string; providerSessionId?: string; checkoutUrl?: string | null },
) {
  const [session] = await db
    .update(checkoutSessions)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(checkoutSessions.id, id))
    .returning();
  return session ?? null;
}

export async function activateLicenseFromCheckout(reference: string) {
  return db.transaction(async (tx) => {
    const checkoutResult = await tx
      .select()
      .from(checkoutSessions)
      .where(
        or(
          eq(checkoutSessions.id, reference),
          eq(checkoutSessions.providerSessionId, reference),
        ),
      )
      .limit(1);
    const checkout = checkoutResult[0];
    if (!checkout) throw new Error("Checkout session not found");
    const companyResult = await tx.select().from(companies).where(eq(companies.id, checkout.companyId)).limit(1);
    const company = companyResult[0];
    const planResult = await tx.select().from(plans).where(eq(plans.id, checkout.planId)).limit(1);
    const plan = planResult[0];
    if (!company || !plan) throw new Error("Checkout tenant or plan not found");
    const existingResult = await tx.select().from(licenses).where(eq(licenses.companyId, company.id)).limit(1);
    const existing = existingResult[0];
    if (checkout.status === "paid" && existing) {
      return { company, plan, license: existing };
    }
    const expiresAt = new Date();
    expiresAt.setUTCDate(expiresAt.getUTCDate() + (plan.interval === "yearly" ? 365 : 30));
    const licenseKey = `HYDRA-${randomBytes(8).toString("hex").toUpperCase()}`;
    const licenseKeyHash = createHash("sha256").update(licenseKey).digest("hex");
    const license = existing
      ? (
          await tx
            .update(licenses)
            .set({
              planId: plan.id,
              status: "active",
              expiresAt: expiresAt.toISOString().slice(0, 10),
              updatedAt: new Date(),
            })
            .where(eq(licenses.id, existing.id))
            .returning()
        )[0]
      : (
          await tx
            .insert(licenses)
            .values({
              id: `lic-${randomUUID()}`,
              companyId: company.id,
              planId: plan.id,
              key: licenseKeyHash,
              encryptedKey: encryptLicenseKey(licenseKey),
              keyHash: licenseKeyHash,
              status: "active",
              expiresAt: expiresAt.toISOString().slice(0, 10),
              issuedTo: company.name,
            })
            .returning()
        )[0];
    if (!license) throw new Error("License activation failed");
    if (!license.encryptedKey) {
      const key = license.key.startsWith("HYDRA-")
        ? license.key
        : `HYDRA-${randomBytes(8).toString("hex").toUpperCase()}`;
      const keyHash = createHash("sha256").update(key).digest("hex");
      const encryptedKey = encryptLicenseKey(key);
      await tx
        .update(licenses)
        .set({
          key: keyHash,
          encryptedKey,
          keyHash,
        })
        .where(eq(licenses.id, license.id));
      license.encryptedKey = encryptedKey;
      license.keyHash = keyHash;
      license.key = keyHash;
    }
    await tx.update(companies).set({ status: "active", updatedAt: new Date() }).where(eq(companies.id, company.id));
    await tx
      .update(checkoutSessions)
      .set({ status: "paid", updatedAt: new Date() })
      .where(eq(checkoutSessions.id, checkout.id));
    await tx.insert(auditLogs).values({
      id: `audit-${randomUUID()}`,
      companyId: company.id,
      action: "payment.confirmed",
      targetType: "license",
      targetId: license.id,
      metadata: { checkoutId: checkout.id, provider: checkout.provider },
    });
    return { company, plan, license };
  });
}

export async function updatePaymentWebhook(
  id: string,
  input: { status: string; error?: string | null; attempts?: number; processedAt?: Date | null },
) {
  const [event] = await db
    .update(paymentWebhookEvents)
    .set(input)
    .where(eq(paymentWebhookEvents.id, id))
    .returning();
  return event ?? null;
}

export async function listNotifications(companyId?: string) {
  return db
    .select()
    .from(notificationDeliveries)
    .where(companyId ? eq(notificationDeliveries.companyId, companyId) : undefined)
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(100);
}

export type NotificationHistoryFilters = {
  companyId?: string;
  status?: string;
  channel?: string;
  eventType?: string;
  recipient?: string;
  page?: number;
  pageSize?: number;
};
export async function checkoutSessionByReference(reference: string) {
  const result = await db
    .select()
    .from(checkoutSessions)
    .where(
      or(
        eq(checkoutSessions.id, reference),
        eq(checkoutSessions.providerSessionId, reference),
      ),
    )
    .limit(1);
  return result[0] ?? null;
}

function paymentPayloadValues(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.data;
  return nested && typeof nested === "object"
    ? { ...payload, ...(nested as Record<string, unknown>) }
    : payload;
}

function paymentPayloadText(payload: Record<string, unknown>, keys: string[]): string | null {
  const values = paymentPayloadValues(payload);
  for (const key of keys) {
    const value = values[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function paymentInvoiceNumber(checkout: typeof checkoutSessions.$inferSelect): string {
  const shortId = checkout.id.replace(/^checkout-/, "").slice(0, 8).toUpperCase();
  return `HYDRA/${checkout.createdAt.getUTCFullYear()}/${shortId}`;
}

export async function listCompanyPaymentRecords(companyId: string) {
  const [checkouts, events] = await Promise.all([
    db
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.companyId, companyId))
      .orderBy(desc(checkoutSessions.createdAt), desc(checkoutSessions.id))
      .limit(25),
    db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.provider, "ablepay"))
      .orderBy(desc(paymentWebhookEvents.receivedAt))
      .limit(250),
  ]);

  return Promise.all(checkouts.map((checkout) => paymentRecordForCheckout(checkout, events)));
}

async function paymentRecordForCheckout(
  checkout: typeof checkoutSessions.$inferSelect,
  events: Array<typeof paymentWebhookEvents.$inferSelect>,
  company?: typeof companies.$inferSelect,
  suppliedPlan?: typeof plans.$inferSelect,
) {
    const event = events.find((candidate) => {
      const values = paymentPayloadValues(candidate.payload);
      const references = [
        values.checkoutId,
        values.orderId,
        values.order_id,
        values.reference,
      ].filter((value): value is string => typeof value === "string");
      return references.includes(checkout.id) || (checkout.providerSessionId ? references.includes(checkout.providerSessionId) : false);
    });
    const plan = suppliedPlan ?? await planById(checkout.planId);
    const payload = event?.payload ?? {};
    const amounts = ablePayAmounts(plan?.price ?? checkout.amount);
    return {
      id: checkout.id,
      status: checkout.status,
      provider: checkout.provider,
      amount: checkout.amount,
      subtotal: amounts.subtotal,
      gstRate: ABLEPAY_GST_RATE,
      gstAmount: amounts.gstAmount,
      currency: checkout.currency,
      planId: checkout.planId,
      planName: plan?.name ?? checkout.planId,
      planPrice: plan?.price ?? checkout.amount,
      planInterval: plan?.interval ?? "monthly",
      planDeviceLimit: plan?.deviceLimit ?? 0,
      invoiceNumber: paymentInvoiceNumber(checkout),
      gatewayReference: paymentPayloadText(payload, [
        "transaction_id",
        "transactionId",
        "payment_reference",
        "paymentReference",
        "provider_reference",
        "providerReference",
        "reference",
      ]) ?? checkout.providerSessionId,
      bankUrn: paymentPayloadText(payload, [
        "bank_urn",
        "bankUrn",
        "bank_reference",
        "bankReference",
        "bank_ref_no",
        "bank_transaction_id",
        "utr",
        "urn",
      ]),
      createdAt: checkout.createdAt.toISOString(),
      paidAt: event?.processedAt?.toISOString() ?? null,
      ...(company
        ? {
            companyId: company.id,
            companyName: company.name,
            companyEmail: company.email,
            companySubdomain: company.subdomain,
            companyGstNumber: company.gstNumber,
            companyAddress: company.address,
            companyContactNumber: company.contactNumber,
          }
        : {}),
    };
}

export async function listAdminPaymentRecords(input: {
  page: number;
  pageSize: number;
  companyId?: string;
  status?: "pending" | "paid" | "failed";
}) {
  const offset = (input.page - 1) * input.pageSize;
  const filters = [
    ...(input.companyId ? [eq(checkoutSessions.companyId, input.companyId)] : []),
    ...(input.status ? [eq(checkoutSessions.status, input.status)] : []),
  ];
  const where = filters.length ? and(...filters) : undefined;
  const [totalResult, checkoutRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(checkoutSessions)
      .innerJoin(companies, eq(checkoutSessions.companyId, companies.id))
      .where(where),
    db
      .select({ checkout: checkoutSessions, company: companies })
      .from(checkoutSessions)
      .innerJoin(companies, eq(checkoutSessions.companyId, companies.id))
      .where(where)
      .orderBy(desc(checkoutSessions.createdAt), desc(checkoutSessions.id))
      .limit(input.pageSize)
      .offset(offset),
  ]);
  const total = totalResult[0]?.value ?? 0;
  if (!checkoutRows.length) {
    return {
      items: [],
      page: input.page,
      pageSize: input.pageSize,
      total,
      hasMore: false,
    };
  }

  const checkouts = checkoutRows.map(({ checkout }) => checkout);
  const references = checkouts.flatMap((checkout) => [
    checkout.id,
    ...(checkout.providerSessionId ? [checkout.providerSessionId] : []),
  ]);
  const referenceConditions = references.flatMap((reference) =>
    ["checkoutId", "orderId", "order_id", "reference"].flatMap((key) => [
      sql`${paymentWebhookEvents.payload} @> ${JSON.stringify({ [key]: reference })}::jsonb`,
      sql`${paymentWebhookEvents.payload} @> ${JSON.stringify({ data: { [key]: reference } })}::jsonb`,
    ]),
  );
  const planIds = [...new Set(checkouts.map((checkout) => checkout.planId))];
  const [events, planRows] = await Promise.all([
    db
      .select()
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.provider, "ablepay"), or(...referenceConditions)))
      .orderBy(desc(paymentWebhookEvents.receivedAt)),
    db.select().from(plans).where(inArray(plans.id, planIds)),
  ]);
  const planByIdMap = new Map(planRows.map((plan) => [plan.id, plan]));

  return {
    items: await Promise.all(
      checkoutRows.map(({ checkout, company }) =>
        paymentRecordForCheckout(checkout, events, company, planByIdMap.get(checkout.planId)),
      ),
    ),
    page: input.page,
    pageSize: input.pageSize,
    total,
    hasMore: offset + checkoutRows.length < total,
  };
}

export async function adminDashboardSummary() {
  const [companyCount, deviceCount, billingTotal, pendingTickets, pendingContactInquiries] = await Promise.all([
    db.select({ value: count() }).from(companies),
    db.select({ value: count() }).from(monitoredDevices),
    db
      .select({ value: sql<string>`coalesce(sum(${checkoutSessions.amount}), 0)` })
      .from(checkoutSessions)
      .where(eq(checkoutSessions.status, "paid")),
    db
      .select({ value: count() })
      .from(supportTickets)
      .where(inArray(supportTickets.status, ["pending", "open", "in_progress"])),
    db
      .select({ value: count() })
      .from(contactSubmissions)
      .where(eq(contactSubmissions.handled, false)),
  ]);

  return {
    totalCompanies: companyCount[0]?.value ?? 0,
    totalBilling: Number(billingTotal[0]?.value ?? 0),
    totalDevices: deviceCount[0]?.value ?? 0,
    pendingSupportTickets: pendingTickets[0]?.value ?? 0,
    pendingContactInquiries: pendingContactInquiries[0]?.value ?? 0,
  };
}

export async function completeNotification(
  id: string,
  input: { status: "sent" | "failed"; error?: string | null; providerMessageId?: string },
) {
  const current = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)).limit(1);
  const delivery = current[0];
  if (!delivery) return null;
  const attempts = delivery.attempts + 1;
  const nextAttemptAt = new Date(Date.now() + Math.min(60 * 60_000, 2 ** attempts * 30_000));
  const [updated] = await db
    .update(notificationDeliveries)
    .set({
      status: input.status,
      attempts,
      lastError: input.error ?? null,
      providerMessageId: input.providerMessageId ?? null,
      nextAttemptAt,
      updatedAt: new Date(),
    })
    .where(eq(notificationDeliveries.id, id))
    .returning();
  return updated ?? null;
}

export async function retryNotification(id: string) {
  const [delivery] = await db
    .update(notificationDeliveries)
    .set({ status: "queued", nextAttemptAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(notificationDeliveries.id, id),
        eq(notificationDeliveries.status, "failed"),
        lt(notificationDeliveries.attempts, notificationDeliveries.maxAttempts),
      ),
    )
    .returning();
  return delivery ?? null;
}

export async function notificationById(id: string, companyId?: string) {
  const conditions = [eq(notificationDeliveries.id, id)];
  if (companyId) conditions.push(eq(notificationDeliveries.companyId, companyId));
  const result = await db
    .select()
    .from(notificationDeliveries)
    .where(and(...conditions))
    .limit(1);
  return result[0] ?? null;
}

export async function listNotificationHistory(filters: NotificationHistoryFilters = {}) {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(filters.pageSize ?? 20)));
  const where = notificationHistoryWhere(filters);
  const [totalResult, items] = await Promise.all([
    db.select({ count: count() }).from(notificationDeliveries).where(where),
    db
      .select()
      .from(notificationDeliveries)
      .where(where)
      .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);
  const total = totalResult[0]?.count ?? 0;
  return {
    items,
    page,
    pageSize,
    total,
    hasMore: page * pageSize < total,
  };
}

function notificationHistoryWhere(filters: NotificationHistoryFilters) {
  const conditions = [];
  if (filters.companyId) conditions.push(eq(notificationDeliveries.companyId, filters.companyId));
  if (filters.status) conditions.push(eq(notificationDeliveries.status, filters.status));
  if (filters.channel) conditions.push(eq(notificationDeliveries.channel, filters.channel));
  if (filters.eventType?.trim()) {
    conditions.push(ilike(notificationDeliveries.eventType, `%${filters.eventType.trim()}%`));
  }
  if (filters.recipient?.trim()) {
    conditions.push(ilike(notificationDeliveries.recipient, `%${filters.recipient.trim()}%`));
  }
  return conditions.length ? and(...conditions) : undefined;
}
