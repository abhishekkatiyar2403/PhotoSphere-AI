import type { NextFunction, Request, Response } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { getSessionUser, SESSION_COOKIE_NAME } from "../lib/session";

// Augment Express's Request with the authenticated user, attached by this
// middleware after validating the opaque session token against Postgres
// (never a JWT signature check - opaque tokens are checked server-side
// on every request so revocation is instant and durable).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
      };
    }
  }
}

export const requireAuth = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
  const user = await getSessionUser(rawToken);

  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  req.user = { id: user.id, email: user.email, name: user.name };
  next();
});
