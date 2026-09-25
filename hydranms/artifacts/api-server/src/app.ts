import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { oltWebProxyMiddleware } from "./lib/olt-web-proxy";
import { handleOltProxyRequest } from "./lib/olt-proxy";

const app: Express = express();
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Handle the isolated wildcard OLT host before parsers consume streamed proxy bodies.
app.use(oltWebProxyMiddleware);
app.use((req, res, next) => {
  void handleOltProxyRequest(req, res).then((handled) => {
    if (!handled) next();
  }).catch(next);
});
app.use(cors());
app.use(cookieParser());
app.use(
  express.json({
    verify(req, _res, buffer) {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
