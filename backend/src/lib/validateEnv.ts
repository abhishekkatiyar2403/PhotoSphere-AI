/**
 * Fail-fast environment validation, run once at the very top of server.ts
 * and worker.ts. Without this, a missing/misconfigured env var (e.g. a typo
 * in AWS_ACCESS_KEY_ID) doesn't fail the deploy — it surfaces later as a
 * confusing runtime S3/Rekognition error deep in worker code, on the first
 * real request that happens to touch that provider. Exits with a clear,
 * complete list of every missing var (not just the first one hit) so a
 * misconfigured deploy is obvious from the boot log alone.
 *
 * Deliberately branches by which REAL providers are actually enabled (same
 * opt-in env vars each provider module already reads) — a dev/test setup
 * running the mock providers should never be forced to supply real cloud
 * credentials it doesn't use.
 */

import { logger } from "./logger";

const REQUIRED_ALWAYS = ["DATABASE_URL", "REDIS_URL"];

export function validateEnv(): void {
  // Never gate local dev/test on this — the mock providers (storage,
  // classification, notifications) are the deliberate zero-credential
  // default, and the test suite must never require real cloud creds.
  if (process.env.NODE_ENV !== "production") return;

  const missing: string[] = [];

  for (const key of REQUIRED_ALWAYS) {
    if (!process.env[key]) missing.push(key);
  }

  // Real S3 (lib/storage.ts's own opt-in: AWS_S3_BUCKET set).
  if (process.env.AWS_S3_BUCKET) {
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      if (!process.env[key]) missing.push(key);
    }
  }

  // Real Rekognition (lib/classification/index.ts's own opt-in).
  if (process.env.CLASSIFICATION_PROVIDER === "rekognition") {
    for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      if (!process.env[key]) missing.push(key);
    }
  }

  // CloudFront read-path (lib/storage.ts's own opt-in).
  if (process.env.CLOUDFRONT_DOMAIN) {
    for (const key of ["CLOUDFRONT_KEY_PAIR_ID", "CLOUDFRONT_PRIVATE_KEY"]) {
      if (!process.env[key]) missing.push(key);
    }
  }

  // Real Resend email (lib/notifications/index.ts's own opt-in).
  if (process.env.RESEND_API_KEY || process.env.RESEND_FROM_EMAIL) {
    for (const key of ["RESEND_API_KEY", "RESEND_FROM_EMAIL"]) {
      if (!process.env[key]) missing.push(key);
    }
  }

  if (missing.length > 0) {
    logger.error({ missing: [...new Set(missing)] }, "FATAL: missing required environment variable(s) in production");
    process.exit(1);
  }
}
