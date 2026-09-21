import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

type EncryptedEnvelope = {
  iv: string;
  tag: string;
  ciphertext: string;
};

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to encrypt SNMP credentials");
  }
  return createHash("sha256").update(secret).digest();
}

export function encryptSnmpCredentials(payload: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const envelope: EncryptedEnvelope = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

export function decryptSnmpCredentials<T extends Record<string, unknown>>(
  encrypted: string,
): T {
  const envelope = JSON.parse(encrypted) as EncryptedEnvelope;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as T;
}

export function encryptSecret(value: string): string {
  return encryptSnmpCredentials({ value });
}

export function decryptSecret(encrypted: string): string {
  const payload = decryptSnmpCredentials<{ value?: unknown }>(encrypted);
  if (typeof payload.value !== "string" || !payload.value) {
    throw new Error("Encrypted secret is invalid");
  }
  return payload.value;
}