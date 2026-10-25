import type { Response } from "express";

/**
 * Every API error uses one shape, `{"error": {"code", "message"}}`, with a
 * stable machine-readable code so callers never parse prose.
 */
export type ErrorCode = "unauthorized" | "invalid_request" | "not_found" | "invalid_state";

export function errorBody(code: ErrorCode, message: string): { error: { code: ErrorCode; message: string } } {
  return { error: { code, message } };
}

export function sendError(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json(errorBody(code, message));
}
