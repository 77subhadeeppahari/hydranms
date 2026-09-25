import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { Request } from "express";
import test from "node:test";
import {
  claimLocalUpload,
  cleanupLocalObjects,
  deleteLocalObject,
  readLocalObject,
  reserveLocalUpload,
  saveLocalUpload,
} from "./lib/local-file-storage";

test("local uploads are user-bound, single-use, validated, and cleanable", async () => {
  const previousDriver = process.env.UPLOAD_STORAGE_DRIVER;
  const previousDirectory = process.env.UPLOADS_LOCAL_DIR;
  const directory = await mkdtemp(path.join(os.tmpdir(), "hydranms-local-uploads-"));
  const objectId = "9b6a17fd-2109-45d6-bbef-c5778da67b11";
  const objectPath = `/objects/uploads/${objectId}`;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  process.env.UPLOAD_STORAGE_DRIVER = "local";
  process.env.UPLOADS_LOCAL_DIR = directory;

  try {
    reserveLocalUpload({
      objectId,
      userId: "user-1",
      size: png.length,
      contentType: "image/png",
    });

    assert.equal(
      claimLocalUpload({
        objectId,
        userId: "user-2",
        contentType: "image/png",
        contentLength: png.length,
      }),
      null,
    );

    const claimed = claimLocalUpload({
      objectId,
      userId: "user-1",
      contentType: "image/png",
      contentLength: png.length,
    });
    assert.deepEqual(claimed, { size: png.length, contentType: "image/png" });
    assert.equal(
      claimLocalUpload({
        objectId,
        userId: "user-1",
        contentType: "image/png",
        contentLength: png.length,
      }),
      null,
    );

    await saveLocalUpload(
      objectId,
      Readable.from([png]) as unknown as Request,
      claimed!,
    );
    const stored = await readLocalObject(objectPath);
    assert.ok(stored);
    assert.equal(stored.contentType, "image/png");
    assert.deepEqual(await readFile(stored.filePath), png);

    assert.equal(await cleanupLocalObjects(Date.now() + 1_000, new Set([objectPath])), 0);
    assert.deepEqual(await readLocalObject(objectPath), stored);
    assert.equal(await cleanupLocalObjects(Date.now() + 1_000, new Set()), 1);
    assert.equal(await readLocalObject(objectPath), null);

    reserveLocalUpload({
      objectId,
      userId: "user-1",
      size: png.length,
      contentType: "image/png",
    });
    const secondClaim = claimLocalUpload({
      objectId,
      userId: "user-1",
      contentType: "image/png",
      contentLength: png.length,
    });
    assert.ok(secondClaim);
    await saveLocalUpload(objectId, Readable.from([png]) as unknown as Request, secondClaim);
    await deleteLocalObject(objectPath);
    assert.equal(await readLocalObject(objectPath), null);
  } finally {
    if (previousDriver === undefined) delete process.env.UPLOAD_STORAGE_DRIVER;
    else process.env.UPLOAD_STORAGE_DRIVER = previousDriver;
    if (previousDirectory === undefined) delete process.env.UPLOADS_LOCAL_DIR;
    else process.env.UPLOADS_LOCAL_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});