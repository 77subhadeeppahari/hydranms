import { logger } from "./logger";
import {
  alertSettingsForCompany,
  claimNotification,
  completeNotification,
  licenseSecret,
  listNotifications,
  queueNotification,
  ticketTelegramBotTokenForCompany,
  telegramBotTokenForCompany,
} from "./portal-store";
import { sendEmail, sendTelegram } from "./providers";

export async function queueLicenseEmail(input: {
  companyId: string;
  companyEmail: string;
  companyName: string;
  planName: string;
  license: Parameters<typeof licenseSecret>[0];
}) {
  const key = await licenseSecret(input.license);
  return queueNotification({
    companyId: input.companyId,
    channel: "email",
    eventType: "license.activated",
    recipient: input.companyEmail,
    subject: "Your HydraNMS license is active",
    body: [
      `Hello ${input.companyName},`,
      "",
      `Your ${input.planName} HydraNMS license is active.`,
      `License key: ${key}`,
      "",
      "Keep this key private. Your portal can now be used by your operations team.",
    ].join("\n"),
    idempotencyKey: `license.activated:${input.license.id}`,
  });
}

export async function queueCompanyAlert(input: {
  companyId: string;
  eventType:
    | "device.down"
    | "device.recovered"
    | "threshold.breached"
    | "port.up"
    | "port.down"
    | "sfp.removed"
    | "sfp.rx.changed"
    | "sfp.tx.changed";
  title: string;
  message: string;
  alertId: string;
}) {
  const settings = await alertSettingsForCompany(input.companyId);
  if (!settings) return [];
  const queued = [];
  if (settings.emailEnabled && settings.emailAddress) {
    const delivery = await queueNotification({
      companyId: input.companyId,
      channel: "email",
      eventType: input.eventType,
      recipient: settings.emailAddress,
      subject: `[HydraNMS] ${input.title}`,
      body: `${input.title}\n\n${input.message}`,
      idempotencyKey: `${input.eventType}:email:${input.alertId}`,
    });
    if (delivery) queued.push(delivery);
  }
  if (settings.telegramEnabled && settings.telegramChatId) {
    const delivery = await queueNotification({
      companyId: input.companyId,
      channel: "telegram",
      eventType: input.eventType,
      recipient: settings.telegramChatId,
      body: `HydraNMS alert: ${input.title}\n${input.message}`,
      idempotencyKey: `${input.eventType}:telegram:${input.alertId}`,
    });
    if (delivery) queued.push(delivery);
  }
  return queued;
}

export async function queueCompanyTicketAlert(input: {
  companyId: string;
  eventType: "ticket.opened" | "ticket.resolved";
  title: string;
  message: string;
  ticketId: string;
  deviceName?: string;
  deviceIp?: string;
  deviceLocation?: string;
  portDetails?: string;
  timestamp?: Date;
}) {
  const settings = await alertSettingsForCompany(input.companyId);
  if (!settings?.ticketTelegramEnabled || !settings.ticketTelegramChatId) return null;
  const timestamp = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(input.timestamp ?? new Date());
  const body = [
    "HydraNMS INCIDENT TICKET",
    `Ticket: ${input.ticketId}`,
    `Status: ${input.eventType === "ticket.opened" ? "OPENED" : "RESOLVED"}`,
    `Device: ${input.deviceName ?? "Not specified"}`,
    `IP: ${input.deviceIp ?? "Not specified"}`,
    `Location: ${input.deviceLocation ?? "Not specified"}`,
    `Port: ${input.portDetails ?? "Not specified"}`,
    `Time: ${timestamp}`,
    `Details: ${input.message}`,
  ].join("\n");
  return queueNotification({
    companyId: input.companyId,
    channel: "ticket_telegram",
    eventType: input.eventType,
    recipient: settings.ticketTelegramChatId,
    body: `${input.title}\n${body}`,
    idempotencyKey: `${input.eventType}:ticket-telegram:${input.ticketId}`,
  });
}

export async function deliverNotification(id: string) {
  const delivery = await claimNotification(id);
  if (!delivery) return null;
  try {
    const result =
      delivery.channel === "email"
        ? await sendEmail({
            to: delivery.recipient,
            subject: delivery.subject ?? "HydraNMS notification",
            body: delivery.body,
          })
        : delivery.channel === "telegram"
          ? await sendTelegram({
              chatId: delivery.recipient,
              text: delivery.body,
              token: await telegramBotTokenForCompany(delivery.companyId),
            })
          : delivery.channel === "ticket_telegram"
            ? await sendTelegram({
                chatId: delivery.recipient,
                text: delivery.body,
                token: await ticketTelegramBotTokenForCompany(delivery.companyId),
              })
          : (() => {
              throw new Error(`Unsupported notification channel: ${delivery.channel}`);
            })();
    return completeNotification(id, {
      status: "sent",
      providerMessageId: result.providerMessageId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification provider failed";
    logger.error({ err: error, deliveryId: id, channel: delivery.channel }, "Notification delivery failed");
    return completeNotification(id, { status: "failed", error: message });
  }
}

export async function processQueuedNotifications() {
  const pending = await listNotifications();
  await Promise.all(
    pending
      .filter((delivery) => delivery.status === "queued" || delivery.status === "failed")
      .map((delivery) => deliverNotification(delivery.id)),
  );
}