import { Router, type Request, type RequestHandler, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { sendError } from "../errors";
import type { StatementsService } from "./service";
import type { RunRecord } from "./store";

const PERSON_MAX = 200;
const QUESTION_MAX = 500;

function isBlankOrTooLong(value: unknown, max: number): boolean {
  return typeof value !== "string" || value.trim().length === 0 || value.length > max;
}

/**
 * The only place the API key is read. It is never logged or returned: a
 * missing key fails closed (every request is unauthorized).
 */
function authorized(req: Request): boolean {
  const expected = process.env.STATEMENTS_API_KEY;
  if (!expected) return false;
  const header = req.get("authorization") ?? "";
  const [scheme, token, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) return false;
  const supplied = Buffer.from(token);
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

/** The public shape of a run; provider payloads never appear here. */
function presentRun(run: RunRecord) {
  return {
    id: run.id,
    status: run.status,
    person_query: run.personQuery,
    question: run.question,
    person: run.person,
    candidates: run.candidates,
    counts: { sources: 0, statements: 0 },
    warnings: [],
    error_category: run.errorCategory,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

export function statementsRouter(getService: () => StatementsService): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (!authorized(req)) {
      sendError(res, 401, "unauthorized", "A valid API key is required.");
      return;
    }
    next();
  });

  router.post("/v1/research-runs", (req, res) => {
    const body = (req.body ?? {}) as { person?: unknown; question?: unknown };
    if (isBlankOrTooLong(body.person, PERSON_MAX)) {
      sendError(
        res,
        422,
        "invalid_request",
        `"person" must be a non-blank string of at most ${PERSON_MAX} characters.`,
      );
      return;
    }
    if (isBlankOrTooLong(body.question, QUESTION_MAX)) {
      sendError(
        res,
        422,
        "invalid_request",
        `"question" must be a non-blank string of at most ${QUESTION_MAX} characters.`,
      );
      return;
    }

    const run = getService().createRun(body.person as string, body.question as string);
    res.status(202).json({ id: run.id, status: run.status, status_url: `/v1/research-runs/${run.id}` });
  });

  router.get("/v1/research-runs/:id", (req, res) => {
    const run = getService().getRun(req.params.id);
    if (!run) {
      sendError(res, 404, "not_found", "No research run with that id.");
      return;
    }
    res.json(presentRun(run));
  });

  router.post("/v1/research-runs/:id/person", (req, res) => {
    const body = (req.body ?? {}) as { wikipedia_page_id?: unknown };
    if (typeof body.wikipedia_page_id !== "number" || !Number.isInteger(body.wikipedia_page_id)) {
      sendError(res, 422, "invalid_request", `"wikipedia_page_id" must be an integer.`);
      return;
    }

    const result = getService().selectCandidate(req.params.id, body.wikipedia_page_id);
    if (result.ok) {
      res.json(presentRun(result.run));
      return;
    }
    if (result.reason === "not_found") {
      sendError(res, 404, "not_found", "No research run with that id.");
      return;
    }
    if (result.reason === "invalid_page") {
      sendError(res, 422, "invalid_request", "That page id is not one of the candidates.");
      return;
    }
    sendError(res, 409, "invalid_state", "This run is not waiting for disambiguation.");
  });

  return router;
}

/** Mounts the API only for /v1 paths; the flag is checked once, here. */
export function mountStatements(
  isEnabled: (res: Response) => Promise<boolean>,
  getService: () => StatementsService,
): RequestHandler {
  const router = statementsRouter(getService);
  return (req, res, next) => {
    if (!req.path.startsWith("/v1/")) {
      next();
      return;
    }
    void isEnabled(res).then((on) => (on ? router(req, res, next) : next()));
  };
}
