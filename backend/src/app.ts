import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import accessRequestsRouter from "./routes/accessRequests";
import authRouter from "./routes/auth";
import collectionsRouter from "./routes/collections";
import dashboardRouter from "./routes/dashboard";
import foldersRouter from "./routes/folders";
import guestRouter from "./routes/guest";
import guestsRouter from "./routes/guests";
import invitesRouter from "./routes/invites";
import photosRouter from "./routes/photos";

export function createApp() {
  const app = express();

  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
  app.use(
    cors({
      origin: frontendOrigin,
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/photos", photosRouter);
  app.use("/api/collections", collectionsRouter);
  app.use("/api/folders", foldersRouter);
  app.use("/api/dashboard", dashboardRouter);
  // Guest Access + OTP (specs/guest-access-otp.md §7). Router-internal order
  // in /api/invites is handled inside routes/invites.ts (literal
  // requests/:requestId/* registered before :token/request).
  app.use("/api/guests", guestsRouter);
  app.use("/api/access-requests", accessRequestsRouter);
  app.use("/api/invites", invitesRouter);
  app.use("/api/guest", guestRouter);

  // Global error handler - catches anything forwarded via next(err),
  // including async route rejections (see lib/asyncHandler.ts), so a
  // downstream outage (e.g. Postgres unreachable) returns a clean 500
  // instead of crashing the process.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error("[backend] unhandled error:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
