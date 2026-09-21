import app from "./app";
import { logger } from "./lib/logger";
import { startPoller } from "./lib/nms-worker";
import { processQueuedNotifications } from "./lib/notification-service";
import { ensurePortalData, startContactSubmissionCleanup } from "./lib/portal-store";
import { startProfilePictureCleanup } from "./routes/nms";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function startServer() {
  await ensurePortalData();
  void processQueuedNotifications();
  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    startPoller();
    startProfilePictureCleanup();
    startContactSubmissionCleanup();
    const notificationTimer = setInterval(() => void processQueuedNotifications(), 30_000);
    notificationTimer.unref();
  });
}

startServer().catch((err) => {
  logger.error({ err }, "Unable to initialize portal data");
  process.exit(1);
});
