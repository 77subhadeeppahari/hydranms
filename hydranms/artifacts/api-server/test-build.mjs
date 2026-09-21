import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { mkdir, rm, symlink } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);
const artifactDir = path.dirname(fileURLToPath(import.meta.url));

await rm("./dist-test", { recursive: true, force: true });
await mkdir("./dist-test/node_modules", { recursive: true });
await symlink(
  path.resolve(artifactDir, "../../lib/db/node_modules/pg"),
  "./dist-test/node_modules/pg",
);

await build({
  entryPoints: [
    "./src/security.test.ts",
    "./src/payment-flow.test.ts",
    "./src/ablepay-provider.test.ts",
    "./src/snmp-poller.test.ts",
    "./src/device-details.test.ts",
    "./src/nms-alert-rules.test.ts",
    "./src/network-ping.test.ts",
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "./dist-test",
  outExtension: { ".js": ".mjs" },
  alias: {
    "@workspace/api-zod": path.resolve(artifactDir, "../../lib/api-zod/src/index.ts"),
    "@workspace/db": path.resolve(artifactDir, "../../lib/db/src/index.ts"),
    "@workspace/db/schema": path.resolve(artifactDir, "../../lib/db/src/schema/index.ts"),
  },
  external: [
    "express",
    "cors",
    "cookie-parser",
    "pino",
    "pino-http",
    "pino-pretty",
    "drizzle-orm",
    "pg",
    "net-snmp",
    "@google-cloud/*",
    "google-auth-library",
  ],
  sourcemap: "inline",
  logLevel: "info",
});