import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type AblePayCheckoutInput = {
  orderId: string;
  amount: number;
  currency: string;
  planId: string;
  companyId: string;
  customerEmail: string;
  redirectUrl: string;
};

export const ABLEPAY_GST_RATE = 18;

export function ablePayAmounts(planAmount: number): {
  subtotal: number;
  gstAmount: number;
  totalAmount: number;
} {
  const subtotal = Math.round(planAmount * 100) / 100;
  const gstAmount = Math.round(subtotal * (ABLEPAY_GST_RATE / 100) * 100) / 100;
  return {
    subtotal,
    gstAmount,
    totalAmount: Math.round((subtotal + gstAmount) * 100) / 100,
  };
}

export type AblePayWebhook = {
  eventId: string;
  eventType: string;
  status: string;
  checkoutId: string;
  companyId?: string;
  planId?: string;
  amount?: number;
  currency?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function ablePayEndpoint(): string {
  const endpoint = requiredEnv("ABLEPAY_API_URL").replace(/\/$/, "");
  return endpoint.endsWith("/v2/paymentrequest") ? endpoint : `${endpoint}/v2/paymentrequest`;
}

export function ablePayMinimumAmount(): number {
  const configured = process.env.ABLEPAY_MIN_AMOUNT?.trim();
  if (!configured) return 100;
  const minimum = Number(configured);
  if (!Number.isFinite(minimum) || minimum <= 0) {
    throw new Error("ABLEPAY_MIN_AMOUNT must be a positive number");
  }
  return minimum;
}

export function validateAblePayAmount(amount: number): void {
  const minimum = ablePayMinimumAmount();
  if (!Number.isFinite(amount) || amount < minimum) {
    throw new Error(`AblePay requires a minimum transaction amount of ₹${minimum.toFixed(2)}. Increase this plan price before starting checkout.`);
  }
}

function stringValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(",");
  if (value === null || value === undefined) return "";
  return String(value);
}

export function ablePayHash(parameters: Record<string, unknown>, salt = requiredEnv("ABLEPAY_SALT")): string {
  const hashData = Object.keys(parameters)
    .sort()
    .reduce((value, key) => {
      const parameter = stringValue(parameters[key]).trim();
      return parameter ? `${value}|${parameter}` : value;
    }, salt);
  return createHash("sha512").update(hashData).digest("hex").toUpperCase();
}

async function readProviderResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = { message: body };
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String(parsed.message)
        : `Provider returned HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Provider returned an invalid response");
  return parsed as Record<string, unknown>;
}

export async function createAblePayCheckout(input: AblePayCheckoutInput) {
  ablePayEndpoint();
  requiredEnv("ABLEPAY_API_KEY");
  requiredEnv("ABLEPAY_SALT");
  const providerSessionId = `HYDRA-${randomBytes(10).toString("hex")}`;
  if (providerSessionId.length > 30) throw new Error("AblePay order ID exceeded the provider limit");
  return { providerSessionId, checkoutUrl: input.redirectUrl };
}

export function buildAblePayPaymentFields(input: {
  orderId: string;
  amount: number;
  currency: string;
  planId: string;
  companyId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  address: string;
  returnUrl: string;
  failureUrl: string;
  cancelUrl: string;
}) {
  validateAblePayAmount(input.amount);
  const fields: Record<string, string> = {
    api_key: requiredEnv("ABLEPAY_API_KEY"),
    order_id: input.orderId,
    mode: (process.env.ABLEPAY_MODE?.trim() || "TEST").toUpperCase(),
    amount: input.amount.toFixed(2),
    currency: input.currency,
    description: `HydraNMS ${input.planId} network monitoring subscription`,
    name: input.customerName,
    email: input.customerEmail,
    phone: input.customerPhone,
    address_line_1: input.address,
    city: process.env.ABLEPAY_DEFAULT_CITY?.trim() || "Mumbai",
    state: process.env.ABLEPAY_DEFAULT_STATE?.trim() || "Maharashtra",
    country: process.env.ABLEPAY_DEFAULT_COUNTRY?.trim() || "IN",
    zip_code: process.env.ABLEPAY_DEFAULT_ZIP_CODE?.trim() || "400001",
    timeout_duration: process.env.ABLEPAY_TIMEOUT_SECONDS?.trim() || "900",
    udf1: input.companyId,
    udf2: input.planId,
    return_url: input.returnUrl,
    return_url_failure: input.failureUrl,
    return_url_cancel: input.cancelUrl,
    payment_options: "cc,nb,upi",
  };
  fields.hash = ablePayHash(fields);
  return { action: ablePayEndpoint(), fields };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

export function renderAblePayPaymentForm(input: { action: string; fields: Record<string, string> }): string {
  const controls = Object.entries(input.fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Redirecting to AblePay</title></head><body><p>Redirecting to the secure AblePay payment page…</p><form method="post" action="${escapeHtml(input.action)}">${controls}</form><script>document.forms[0].submit()</script></body></html>`;
}

export function verifyAblePayResponse(payload: Record<string, unknown>): boolean {
  const supplied = stringValue(payload.hash).trim();
  if (!supplied) return true;
  const withoutHash = { ...payload };
  delete withoutHash.hash;
  const calculated = ablePayHash(withoutHash);
  const expectedBuffer = Buffer.from(calculated, "utf8");
  const suppliedBuffer = Buffer.from(supplied, "utf8");
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

export function verifyAblePaySignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = process.env.ABLEPAY_WEBHOOK_SECRET?.trim();
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const supplied = signature.replace(/^sha256=/, "").trim();
  const expectedBuffer = Buffer.from(expected, "utf8");
  const suppliedBuffer = Buffer.from(supplied, "utf8");
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function parseAblePayWebhook(payload: unknown): AblePayWebhook {
  const root = record(payload);
  const data = record(root.data);
  const source = Object.keys(data).length ? data : root;
  const eventId = String(root.id ?? root.eventId ?? source.eventId ?? "");
  const eventType = String(root.type ?? root.eventType ?? "payment.updated");
  const status = String(source.status ?? source.paymentStatus ?? root.status ?? "").toLowerCase();
  const checkoutId = String(
    source.checkoutId ?? source.orderId ?? source.reference ?? root.checkoutId ?? root.orderId ?? "",
  );
  if (!eventId || !checkoutId || !status) throw new Error("AblePay webhook is missing eventId, checkoutId, or status");
  return {
    eventId,
    eventType,
    status,
    checkoutId,
    companyId: typeof source.companyId === "string" ? source.companyId : undefined,
    planId: typeof source.planId === "string" ? source.planId : undefined,
    amount: typeof source.amount === "number" ? source.amount : undefined,
    currency: typeof source.currency === "string" ? source.currency : undefined,
  };
}

export type EmailMessage = {
  to: string;
  subject: string;
  body: string;
};

export async function sendEmail(message: EmailMessage): Promise<{ providerMessageId?: string }> {
  const provider = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  const from = requiredEnv("EMAIL_FROM");
  if (provider === "resend") {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.body }),
    });
    const payload = await readProviderResponse(response);
    return { providerMessageId: typeof payload.id === "string" ? payload.id : undefined };
  }
  if (provider === "sendgrid") {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${requiredEnv("SENDGRID_API_KEY")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: from },
        subject: message.subject,
        content: [{ type: "text/plain", value: message.body }],
      }),
    });
    await readProviderResponse(response);
    return {};
  }
  throw new Error("EMAIL_PROVIDER must be configured as resend or sendgrid");
}

export async function sendTelegram(message: {
  chatId: string;
  text: string;
  token?: string | null;
}): Promise<{ providerMessageId?: string }> {
  const token = message.token?.trim() || requiredEnv("TELEGRAM_BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: message.chatId, text: message.text }),
  });
  const payload = await readTelegramResponse(response);
  const result = record(payload.result);
  return { providerMessageId: typeof result.message_id === "number" ? String(result.message_id) : undefined };
}

export type TelegramBotInfo = {
  id: number;
  username: string | null;
  firstName: string;
};

async function readTelegramResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`Telegram returned an invalid response (HTTP ${response.status})`);
  }
  const parsed = record(payload);
  if (!response.ok || parsed.ok !== true) {
    const description = typeof parsed.description === "string" ? parsed.description : `HTTP ${response.status}`;
    throw new Error(`Telegram API: ${description}`);
  }
  return parsed;
}

export async function getTelegramBotInfo(tokenOverride?: string | null): Promise<TelegramBotInfo> {
  const token = tokenOverride?.trim() || requiredEnv("TELEGRAM_BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const payload = await readTelegramResponse(response);
  const result = record(payload.result);
  if (typeof result.id !== "number" || typeof result.first_name !== "string") {
    throw new Error("Telegram returned incomplete bot information");
  }
  return {
    id: result.id,
    username: typeof result.username === "string" ? result.username : null,
    firstName: result.first_name,
  };
}