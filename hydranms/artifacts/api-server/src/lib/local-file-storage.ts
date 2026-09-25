import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request } from "express";

const MAX_UPLOAD_BYTES = 5_000_000;
const UPLOAD_TICKET_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_UPLOADS = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type PendingUpload = {
  userId: string;
  size: number;
  contentType: string;
  expiresAt: number;
};

export type ClaimedLocalUpload = Pick<PendingUpload, "size" | "contentType">;

export type LocalStoredObject = {
  filePath: string;
  contentType: string;
  size: number;
};

export class LocalUploadError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "LocalUploadError";
  }
}

const pendingUploads = new Map<string, PendingUpload>();

export function usesLocalUploadStorage(): boolean {
  const driver = process.env.UPLOAD_STORAGE_DRIVER?.trim().toLowerCase() || "replit";
  if (driver !== "local" && driver !== "replit") {
    throw new Error("UPLOAD_STORAGE_DRIVER must be either 'local' or 'replit'");
  }
  return driver === "local";
}

function localUploadDirectory(): string {
  const directory = process.env.UPLOADS_LOCAL_DIR?.trim();
  if (!directory) {
    throw new Error("UPLOADS_LOCAL_DIR is required when UPLOAD_STORAGE_DRIVER=local");
  }
  if (!path.isAbsolute(directory)) {
    throw new Error("UPLOADS_LOCAL_DIR must be an absolute path");
  }
  return path.resolve(directory);
}

function assertObjectId(objectId: string): void {
  if (!UUID_PATTERN.test(objectId)) throw new Error("Invalid local object ID");
}

function normalizeContentType(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function pruneExpiredTickets(now = Date.now()): void {
  for (const [objectId, upload] of pendingUploads) {
    if (upload.expiresAt <= now) pendingUploads.delete(objectId);
  }
}

export function reserveLocalUpload(input: {
  objectId: string;
  userId: string;
  size: number;
  contentType: string;
}): void {
  assertObjectId(input.objectId);
  localUploadDirectory();
  const contentType = normalizeContentType(input.contentType);
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new LocalUploadError("Only PNG, JPEG, and WebP images are supported", 415);
  }
  if (!Number.isInteger(input.size) || input.size < 1 || input.size > MAX_UPLOAD_BYTES) {
    throw new LocalUploadError("Image size must be between 1 byte and 5 MB", 413);
  }

  pruneExpiredTickets();
  if (pendingUploads.size >= MAX_PENDING_UPLOADS) {
    throw new LocalUploadError("Too many pending uploads; try again shortly", 503);
  }
  pendingUploads.set(input.objectId, {
    userId: input.userId,
    size: input.size,
    contentType,
    expiresAt: Date.now() + UPLOAD_TICKET_TTL_MS,
  });
}

export function claimLocalUpload(input: {
  objectId: string;
  userId: string;
  contentType: string;
  contentLength?: number;
}): ClaimedLocalUpload | null {
  if (!UUID_PATTERN.test(input.objectId)) return null;
  pruneExpiredTickets();
  const upload = pendingUploads.get(input.objectId);
  if (!upload || upload.userId !== input.userId) return null;
  if (normalizeContentType(input.contentType) !== upload.contentType) return null;
  if (
    input.contentLength !== undefined &&
    (!Number.isSafeInteger(input.contentLength) || input.contentLength !== upload.size)
  ) {
    return null;
  }
  pendingUploads.delete(input.objectId);
  return { size: upload.size, contentType: upload.contentType };
}

function imageSignatureMatches(contentType: string, signature: Buffer): boolean {
  if (contentType === "image/png") {
    return signature.length >= 8 && signature.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  if (contentType === "image/jpeg") {
    return signature.length >= 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  }
  return contentType === "image/webp" &&
    signature.length >= 12 &&
    signature.toString("ascii", 0, 4) === "RIFF" &&
    signature.toString("ascii", 8, 12) === "WEBP";
}

export async function saveLocalUpload(
  objectId: string,
  request: Request,
  upload: ClaimedLocalUpload,
): Promise<void> {
  assertObjectId(objectId);
  const directory = localUploadDirectory();
  await mkdir(directory, { recursive: true, mode: 0o750 });

  const filePath = path.join(directory, `${objectId}.blob`);
  const metadataPath = path.join(directory, `${objectId}.json`);
  const tempFilePath = path.join(directory, `.${objectId}.part`);
  const tempMetadataPath = path.join(directory, `.${objectId}.json.part`);
  let totalBytes = 0;
  let signatureBytes = Buffer.alloc(0);
  let objectMoved = false;

  try {
    const counter = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.length;
        if (totalBytes > MAX_UPLOAD_BYTES || totalBytes > upload.size) {
          callback(new LocalUploadError("Image exceeds the permitted upload size", 413));
          return;
        }
        if (signatureBytes.length < 12) {
          signatureBytes = Buffer.concat([
            signatureBytes,
            bytes.subarray(0, 12 - signatureBytes.length),
          ]);
        }
        callback(null, bytes);
      },
    });

    await pipeline(
      request,
      counter,
      createWriteStream(tempFilePath, { flags: "wx", mode: 0o600 }),
    );
    if (totalBytes !== upload.size) {
      throw new LocalUploadError("Uploaded image size does not match the requested size", 400);
    }
    if (!imageSignatureMatches(upload.contentType, signatureBytes)) {
      throw new LocalUploadError("Image content does not match its declared file type", 415);
    }

    const metadata = JSON.stringify({
      contentType: upload.contentType,
      size: totalBytes,
      createdAt: new Date().toISOString(),
    });
    await writeFile(tempMetadataPath, metadata, { flag: "wx", mode: 0o600 });
    await rename(tempFilePath, filePath);
    objectMoved = true;
    await rename(tempMetadataPath, metadataPath);
  } catch (error) {
    await Promise.all([
      rm(tempFilePath, { force: true }),
      rm(tempMetadataPath, { force: true }),
      ...(objectMoved ? [rm(filePath, { force: true }), rm(metadataPath, { force: true })] : []),
    ]);
    throw error;
  }
}

export async function readLocalObject(objectPath: string): Promise<LocalStoredObject | null> {
  const objectId = objectIdFromPath(objectPath);
  if (!objectId) return null;
  const directory = localUploadDirectory();
  const filePath = path.join(directory, `${objectId}.blob`);
  const metadataPath = path.join(directory, `${objectId}.json`);

  try {
    const [metadataText, fileStats] = await Promise.all([
      readFile(metadataPath, "utf8"),
      stat(filePath),
    ]);
    const metadata = JSON.parse(metadataText) as { contentType?: unknown; size?: unknown };
    const contentType = typeof metadata.contentType === "string"
      ? normalizeContentType(metadata.contentType)
      : "";
    if (!ALLOWED_CONTENT_TYPES.has(contentType) || !fileStats.isFile()) {
      throw new Error("Local object metadata is invalid");
    }
    if (
      !Number.isSafeInteger(metadata.size) ||
      metadata.size !== fileStats.size ||
      fileStats.size > MAX_UPLOAD_BYTES
    ) {
      throw new Error("Local object size metadata is invalid");
    }
    return { filePath, contentType, size: fileStats.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function objectIdFromPath(objectPath: string): string | null {
  const match = /^\/objects\/uploads\/([0-9a-f-]+)$/i.exec(objectPath);
  if (!match || !UUID_PATTERN.test(match[1])) return null;
  return match[1];
}

export async function deleteLocalObject(objectPath: string): Promise<void> {
  const objectId = objectIdFromPath(objectPath);
  if (!objectId) return;
  const directory = localUploadDirectory();
  await Promise.all([
    rm(path.join(directory, `${objectId}.blob`), { force: true }),
    rm(path.join(directory, `${objectId}.json`), { force: true }),
  ]);
}

export async function cleanupLocalObjects(
  cutoff: number,
  referencedPaths: Set<string>,
): Promise<number> {
  const directory = localUploadDirectory();
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const entries = await readdir(directory, { withFileTypes: true });
  let deleted = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".blob")) continue;
    const objectId = entry.name.slice(0, -".blob".length);
    if (!UUID_PATTERN.test(objectId)) continue;
    const objectPath = `/objects/uploads/${objectId}`;
    if (referencedPaths.has(objectPath)) continue;

    const filePath = path.join(directory, entry.name);
    try {
      const metadataPath = path.join(directory, `${objectId}.json`);
      const [metadataText, fileStats] = await Promise.all([
        readFile(metadataPath, "utf8").catch(() => ""),
        stat(filePath),
      ]);
      let createdAt = fileStats.mtimeMs;
      if (metadataText) {
        try {
          const metadata = JSON.parse(metadataText) as { createdAt?: unknown };
          if (typeof metadata.createdAt === "string") {
            const parsed = Date.parse(metadata.createdAt);
            if (Number.isFinite(parsed)) createdAt = parsed;
          }
        } catch {
          // Use the file modification time for malformed sidecar metadata.
        }
      }
      if (createdAt > cutoff) continue;
      await deleteLocalObject(objectPath);
      deleted += 1;
    } catch {
      // Leave files in place for the next cleanup sweep if they cannot be inspected.
    }
  }
  return deleted;
}