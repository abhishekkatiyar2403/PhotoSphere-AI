import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async Express route/middleware handler so rejected promises are
 * forwarded to next(err) instead of crashing the process. Express 4 (used
 * here) does not catch async rejections automatically.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
