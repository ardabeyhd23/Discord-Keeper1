import express, { type Express } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const shopWebDir = path.resolve(serverDir, "../public/shop");
app.use("/shop-assets", express.static(path.resolve(serverDir, "../public", "shop-assets")));
app.use(express.static(shopWebDir));

app.use("/api", router);

// FR Family Shop web arayüzü aynı Render bot servisi üzerinden yayınlanır.
// Böylece ayrı bir web servisi veya VITE_API_BASE_URL zorunlu değildir.
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/shop-assets")) {
    return next();
  }
  res.sendFile(path.join(shopWebDir, "index.html"), (err) => {
    if (err) next(err);
  });
});

export default app;
