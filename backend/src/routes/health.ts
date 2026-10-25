import { Router } from "express";

/**
 * Trivial example route, present only to prove the backend shape works end
 * to end (routing, JSON responses). This is also the boot/health-check
 * smoke test's target per the Test Gate's shape — real
 * Managed Apps will add actual business-logic routes alongside it.
 */
export const healthRouter = Router();

healthRouter.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// The statements API's contract names the open health path /health; the
// starter's /api/health stays for the frontend. Neither is behind the API key.
healthRouter.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
