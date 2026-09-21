import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const companies = pgTable(
  "companies",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    subdomain: text("subdomain").notNull(),
    email: text("email").notNull(),
    contactNumber: text("contact_number").notNull(),
    gstNumber: text("gst_number"),
    address: text("address").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("companies_subdomain_unique").on(table.subdomain)],
);

export const portalUsers = pgTable(
  "portal_users",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id"),
    username: text("username").notNull(),
    displayName: text("display_name").notNull().default(""),
    email: text("email").notNull(),
    avatarPath: text("avatar_path"),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    role: text("role").notNull().default("company_admin"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("portal_users_username_unique").on(table.username),
    unique("portal_users_email_unique").on(table.email),
    index("portal_users_company_index").on(table.companyId),
  ],
);

export const platformCompanyProfile = pgTable("platform_company_profile", {
  id: text("id").primaryKey(),
  companyName: text("company_name").notNull(),
  address: text("address").notNull(),
  gstNumber: text("gst_number"),
  phoneNumber: text("phone_number").notNull(),
  email: text("email").notNull(),
  logoPath: text("logo_path"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const contactSubmissions = pgTable(
  "contact_submissions",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    company: text("company").notNull().default(""),
    message: text("message").notNull(),
    ipHash: text("ip_hash").notNull(),
    handled: boolean("handled").notNull().default(false),
    internalNote: text("internal_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("contact_submissions_ip_created_index").on(table.ipHash, table.createdAt),
    index("contact_submissions_created_index").on(table.createdAt),
  ],
);

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  price: integer("price").notNull(),
  interval: text("interval").notNull(),
  deviceLimit: integer("device_limit").notNull(),
  features: text("features").array().notNull(),
  popular: boolean("popular").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const licenses = pgTable(
  "licenses",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    planId: text("plan_id").notNull(),
    key: text("key").notNull(),
    encryptedKey: text("encrypted_key"),
    keyHash: text("key_hash"),
    status: text("status").notNull().default("expired"),
    expiresAt: date("expires_at", { mode: "string" }).notNull(),
    issuedTo: text("issued_to").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("licenses_key_unique").on(table.key),
    unique("licenses_company_unique").on(table.companyId),
    index("licenses_company_index").on(table.companyId),
  ],
);

export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    planId: text("plan_id").notNull(),
    provider: text("provider").notNull().default("ablepay"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull().default("pending"),
    amount: real("amount").notNull(),
    currency: text("currency").notNull().default("INR"),
    checkoutUrl: text("checkout_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("checkout_sessions_provider_session_unique").on(table.provider, table.providerSessionId),
    index("checkout_sessions_company_index").on(table.companyId, table.createdAt),
  ],
);

export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").notNull().default("received"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    unique("payment_webhook_events_provider_event_unique").on(table.provider, table.eventId),
    index("payment_webhook_events_status_index").on(table.status, table.receivedAt),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id"),
    channel: text("channel").notNull(),
    eventType: text("event_type").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
    lastError: text("last_error"),
    providerMessageId: text("provider_message_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("notification_deliveries_idempotency_unique").on(table.idempotencyKey),
    index("notification_deliveries_status_index").on(table.status, table.nextAttemptAt),
    index("notification_deliveries_company_index").on(table.companyId, table.createdAt),
  ],
);

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    createdBy: text("created_by"),
    subject: text("subject").notNull(),
    status: text("status").notNull().default("open"),
    priority: text("priority").notNull(),
    message: text("message").notNull(),
    supportPin: text("support_pin").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("support_tickets_company_index").on(table.companyId, table.createdAt),
  ],
);

export const incidentTickets = pgTable(
  "incident_tickets",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    sourceType: text("source_type").notNull().default("manual"),
    sourceKey: text("source_key").notNull(),
    deviceId: text("device_id"),
    ifIndex: integer("if_index"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("open"),
    autoResolved: boolean("auto_resolved").notNull().default(false),
    createdBy: text("created_by"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("incident_tickets_company_source_unique").on(table.companyId, table.sourceKey),
    index("incident_tickets_company_status_index").on(table.companyId, table.status, table.updatedAt),
  ],
);

export const alertSettings = pgTable(
  "alert_settings",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    emailEnabled: boolean("email_enabled").notNull().default(false),
    emailAddress: text("email_address"),
    telegramEnabled: boolean("telegram_enabled").notNull().default(false),
    telegramChatId: text("telegram_chat_id"),
    telegramBotTokenEncrypted: text("telegram_bot_token_encrypted"),
    ticketTelegramEnabled: boolean("ticket_telegram_enabled").notNull().default(false),
    ticketTelegramChatId: text("ticket_telegram_chat_id"),
    ticketTelegramBotTokenEncrypted: text("ticket_telegram_bot_token_encrypted"),
    rxPowerLowThreshold: real("rx_power_low_threshold"),
    rxPowerHighThreshold: real("rx_power_high_threshold"),
    txPowerLowThreshold: real("tx_power_low_threshold"),
    txPowerHighThreshold: real("tx_power_high_threshold"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("alert_settings_company_unique").on(table.companyId)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id").notNull(),
    companyId: text("company_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("auth_sessions_token_hash_unique").on(table.tokenHash),
    index("auth_sessions_user_index").on(table.userId),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id"),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_logs_company_index").on(table.companyId, table.createdAt),
    index("audit_logs_actor_index").on(table.actorUserId, table.createdAt),
  ],
);

export const insertCompanySchema = createInsertSchema(companies);
export const insertPortalUserSchema = createInsertSchema(portalUsers);
export const insertPlanSchema = createInsertSchema(plans);
export const insertLicenseSchema = createInsertSchema(licenses);
export const insertCheckoutSessionSchema = createInsertSchema(checkoutSessions);
export const insertPaymentWebhookEventSchema = createInsertSchema(paymentWebhookEvents);
export const insertNotificationDeliverySchema = createInsertSchema(notificationDeliveries);
export const insertSupportTicketSchema = createInsertSchema(supportTickets);
export const insertIncidentTicketSchema = createInsertSchema(incidentTickets);
export const insertAlertSettingsSchema = createInsertSchema(alertSettings);
export const insertAuthSessionSchema = createInsertSchema(authSessions);
export const insertAuditLogSchema = createInsertSchema(auditLogs);

export type Company = typeof companies.$inferSelect;
export type PortalUser = typeof portalUsers.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type License = typeof licenses.$inferSelect;
export type CheckoutSession = typeof checkoutSessions.$inferSelect;
export type PaymentWebhookEvent = typeof paymentWebhookEvents.$inferSelect;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type SupportTicket = typeof supportTickets.$inferSelect;
export type IncidentTicket = typeof incidentTickets.$inferSelect;
export type AlertSettings = typeof alertSettings.$inferSelect;
export type AuthSession = typeof authSessions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;