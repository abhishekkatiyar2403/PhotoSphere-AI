import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import accessRequestsRouter from "./routes/accessRequests";
import auditRouter from "./routes/audit";
import authRouter from "./routes/auth";
import collectionsRouter from "./routes/collections";
import dashboardRouter from "./routes/dashboard";
import foldersRouter from "./routes/folders";
import guestRouter from "./routes/guest";
import guestsRouter from "./routes/guests";
import invitesRouter from "./routes/invites";
import photosRouter from "./routes/photos";
import searchRouter from "./routes/search";
import trashRouter from "./routes/trash";

export function createApp() {
  const app = express();

  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";

  // Security headers (specs/audit-and-polish.md P1, roadmap Week 11). Helmet's
  // safe defaults (X-Content-Type-Options: nosniff, X-Frame-Options: DENY /
  // frame-ancestors, Referrer-Policy, HSTS, no X-Powered-By, etc.).
  //
  // CSP posture (AP10): a strict CSP breaks the Next dev server (inline
  // bootstrap scripts + HMR) and can block cross-origin API/image loads. Since
  // there is no prod deploy this pass, CSP is DISABLED under
  // NODE_ENV=development (the practical local effect: safe non-CSP headers,
  // frontend unbroken) and a sensible CSP is wired for prod so it's ready when
  // a real deploy happens. crossOriginResourcePolicy is relaxed to allow the
  // separate-origin frontend to consume this API's responses.
  const isDev = process.env.NODE_ENV === "development";
  app.use(
    helmet({
      contentSecurityPolicy: isDev
        ? false
        : {
            directives: {
              ...helmet.contentSecurityPolicy.getDefaultDirectives(),
              // Pre-signed image URLs come from MinIO/S3 on a different origin.
              "img-src": ["'self'", "data:", "https:", "blob:"],
              "connect-src": ["'self'", frontendOrigin],
            },
          },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

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
  // Owner activity log (specs/audit-and-polish.md §A5). Single top-level GET,
  // no route-order hazard. Append-only / list-only (no PATCH/DELETE/:id).
  app.use("/api/audit", auditRouter);
  // Basic search (specs/folder-mgmt-download-search.md PART P6). Owner-scoped
  // single top-level GET, no :id shadowing hazard. No audit (S7).
  app.use("/api/search", searchRouter);
  // Trash surface (specs/trash-system.md): list + permanent-purge-one +
  // empty-trash. Owner-only; DELETE /api/photos|folders/:id are SOFT deletes
  // now, this router owns the irreversible operations.
  app.use("/api/trash", trashRouter);

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
