import path from "node:path";
import express, { type Express } from "express";
import { logger } from "./logger";
import { healthRouter } from "./routes/health";
import { isFeatureEnabled, previewMiddleware } from "./feature-flags";
import { getStatementsService } from "./statements";
import { mountStatements } from "./statements/routes";
import type { StatementsService } from "./statements/service";

// The built frontend lives at ../../frontend/dist relative to this file's
// compiled location (dist/app.js -> backend/dist -> backend/.. -> frontend/dist).
// The Dockerfile's final stage preserves this same backend/ + frontend/
// sibling layout under /app, so the relative path holds in the container too.
const DEFAULT_FRONTEND_DIST = path.resolve(__dirname, "../../frontend/dist");
const FRONTEND_DIST = process.env.FRONTEND_DIST_PATH
  ? path.resolve(process.env.FRONTEND_DIST_PATH)
  : DEFAULT_FRONTEND_DIST;

export function createApp(options: { statementsService?: StatementsService } = {}): Express {
  const app = express();

  // Fly terminates TLS in front of the app; trusting one proxy hop makes
  // req.secure reflect the original request (for the preview cookie).
  app.set("trust proxy", 1);

  app.use(express.json());
  app.use(previewMiddleware());

  // One structured JSON log line per request.
  app.use((req, res, next) => {
    res.on("finish", () => {
      logger.info("request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
      });
    });
    next();
  });

  // Health checks (Fly's included) answer before anything else is mounted.
  app.use(healthRouter);

  // The statements API is one change behind one flag, checked here, once.
  const injected = options.statementsService;
  const statementsService: () => StatementsService = injected ? () => injected : getStatementsService;
  app.use(mountStatements((res) => isFeatureEnabled(res, "issue-158"), statementsService));

  // One container: the backend serves the built frontend's static assets
  // itself — no separate frontend server.
  app.use(express.static(FRONTEND_DIST));

  // SPA fallback: any unmatched GET that isn't an API route falls through
  // to index.html so client-side routing survives a hard refresh/deep link.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(FRONTEND_DIST, "index.html"), (err) => {
      if (err) {
        next(err);
      }
    });
  });

  return app;
}
