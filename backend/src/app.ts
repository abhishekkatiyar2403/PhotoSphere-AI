import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
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
import uploadRouter from "./routes/upload";
import { prisma } from "./lib/prisma";
import { redisConnection } from "./lib/queue";
import { getWorkerHeartbeatAgeMs, HEARTBEAT_STALE_AFTER_MS } from "./lib/workerHeartbeat";
import { logger } from "./lib/logger";

export function createApp() {
  const app = express();

  // Trust exactly one hop of proxy (Railway's own edge proxy in production).
  // Without this, req.ip resolves to the PROXY's address for every request
  // behind it — every IP-keyed rate limiter (login, invite requests) collapses
  // into one shared global bucket (one abusive client can lock out login for
  // every user at once), and every audit-log/access-request IP record is
  // wrong. Off in dev — there is no proxy in front of localhost.
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
  // Additive, dev-only: the mobile-wrapper testing setup (Capacitor's WebView
  // pointed at this Mac's LAN IP, per frontend/capacitor.config.ts) hits this
  // API from a DIFFERENT origin (the LAN IP, not localhost) than the browser
  // dev server does. Rather than swap FRONTEND_ORIGIN and break Mac-browser
  // testing, accept BOTH origins. Unset (undefined) changes nothing.
  const mobileDevOrigin = process.env.MOBILE_DEV_ORIGIN;
  // Additional origins as a comma-separated list — e.g. a Vercel preview
  // deployment URL alongside the stable production domain. Unset changes
  // nothing (the two variables above already cover the common cases).
  const extraOrigins = (process.env.EXTRA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim());
  const allowedOrigins = [frontendOrigin, mobileDevOrigin, ...extraOrigins].filter(
    (o): o is string => typeof o === "string" && o.length > 0,
  );

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
      origin: allowedOrigins,
      credentials: true,
    }),
  );
  // specs/production-upload-batch.md: a real 500-1000-file initiate/complete
  // payload (per-file descriptors + presigned-part metadata) comfortably
  // exceeds Express's 100kb default JSON body limit — raised globally
  // (cheap, no other route in this app sends anywhere near this much JSON)
  // rather than only for the upload router, to keep this one setting in one
  // obvious place.
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());

  // Global fallback rate limiter (2026-07-13 backend audit #13) — a generous
  // backstop for any endpoint NOT already covered by a dedicated bucket
  // (auth/upload/reclassify/invite/guest all have their own, tighter,
  // purpose-specific limiters below). Keyed by IP; relies on the trust-proxy
  // setting above being correct in production. Production-only — local dev
  // has no need for it, and the test suite must never risk tripping it.
  if (process.env.NODE_ENV === "production") {
    app.use(
      rateLimit({
        windowMs: 60 * 1000,
        limit: 300,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many requests. Please try again later." },
      }),
    );
  }

  // CSRF/Origin guard (production only). Cookies are SameSite=None in prod
  // (required — Vercel frontend + Railway backend are different domains), and
  // SameSite=None cookies are still sent on a plain cross-site form POST with
  // no CORS preflight, so a state-changing endpoint with no meaningful body
  // (logout, photo/folder restore, empty-trash) is otherwise forgeable from
  // any malicious page while a user is logged in. Full CSRF tokens are
  // overkill for an API-only backend with a known, small set of legitimate
  // frontend origins — validating Origin (falling back to Referer, since some
  // browsers omit Origin on same-origin GETs but always send it cross-site on
  // state-changing requests) against the SAME allow-list already used for CORS
  // is the standard lightweight equivalent. GETs are exempt (no state change).
  //
  // The comparison is EXACT origin membership, never a prefix test: a prefix
  // match (origin.startsWith(allowed)) would accept an attacker-registered
  // `https://app.example.com.evil.com` against an allowed `https://app.example.com`.
  // The raw header is normalized to its scheme://host[:port] origin first so
  // both an Origin header (already an origin) and a Referer (a full URL with a
  // path) compare correctly against the allow-list.
  if (process.env.NODE_ENV === "production") {
    app.use((req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
        return next();
      }
      const raw = req.headers.origin ?? req.headers.referer;
      let requestOrigin: string | null = null;
      if (raw) {
        try {
          requestOrigin = new URL(raw).origin; // scheme://host[:port], no path
        } catch {
          requestOrigin = null; // malformed header → reject below
        }
      }
      if (!requestOrigin || !allowedOrigins.includes(requestOrigin)) {
        return res.status(403).json({ error: "Forbidden — invalid or missing Origin" });
      }
      next();
    });
  }

  // Real liveness/readiness check (2026-07-13 backend audit #14 — the old
  // version returned 200 unconditionally, checking nothing, which makes
  // Railway's own health-check-based restart behavior meaningless). Checks:
  //  - database: a real SELECT 1 round-trip.
  //  - redis: a real PING on the same connection the job queue depends on.
  //  - worker: reads its last heartbeat (lib/workerHeartbeat.ts) — informational
  //    only, does NOT flip this endpoint's own status/HTTP code, since a
  //    healthy API and a stalled worker are genuinely different failure
  //    domains (the API can keep serving reads/uploads even if classification
  //    is backed up) and conflating them would make this endpoint useless for
  //    "should I restart the API process?" decisions.
  app.get("/health", async (_req, res) => {
    const [databaseOk, redisOk, workerHeartbeatAgeMs] = await Promise.all([
      prisma
        .$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      redisConnection
        .ping()
        .then(() => true)
        .catch(() => false),
      getWorkerHeartbeatAgeMs(redisConnection).catch(() => null),
    ]);

    const healthy = databaseOk && redisOk;
    const workerStatus =
      workerHeartbeatAgeMs === null
        ? "unknown"
        : workerHeartbeatAgeMs <= HEARTBEAT_STALE_AFTER_MS
          ? "ok"
          : "stale";

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      checks: {
        database: databaseOk ? "ok" : "error",
        redis: redisOk ? "ok" : "error",
        worker: { status: workerStatus, lastSeenMsAgo: workerHeartbeatAgeMs },
      },
    });
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
  // specs/production-upload-batch.md — presigned multipart batch upload,
  // additive alongside the existing single-file POST /api/photos/upload
  // (photosRouter above, untouched).
  app.use("/api/upload", uploadRouter);

  // Catch-all 404 — without this, an unknown route falls through to
  // Express's default HTML 404 page, breaking the { error } JSON shape every
  // real endpoint in this app uses.
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Global error handler - catches anything forwarded via next(err),
  // including async route rejections (see lib/asyncHandler.ts), so a
  // downstream outage (e.g. Postgres unreachable) returns a clean 500
  // instead of crashing the process.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "unhandled error");
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
