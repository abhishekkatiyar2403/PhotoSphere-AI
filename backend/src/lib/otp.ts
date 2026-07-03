import crypto from "node:crypto";

/**
 * OTP helpers for the guest-access approval gate (specs/guest-access-otp.md
 * §4, roadmap §12 "OTP Security Details"). The 6-digit code is generated with
 * a CSPRNG, only ever stored as a SHA-256 hash (plaintext never persisted to
 * the DB), and verified with a constant-time compare so a wrong code can't be
 * discriminated by timing. Numbers are roadmap-fixed (decision G1): 6 digits,
 * SHA-256, 5-min TTL (enforced by the caller), single-use, 3 wrong attempts.
 */

/** 6-digit numeric code as a string (leading digits preserved by the range). */
export function generateOtp(): string {
  // 100000..999999 inclusive — always exactly 6 digits, no zero-padding needed.
  return String(crypto.randomInt(100000, 1000000));
}

export function hashOtp(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/**
 * Constant-time comparison of a submitted plaintext OTP against a stored hash.
 * Hashes both sides to equal-length hex digests before comparing so
 * `crypto.timingSafeEqual` (which throws on length mismatch) is always safe,
 * and no early-exit reveals how many leading characters matched.
 */
export function verifyOtp(submittedCode: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const submittedHash = hashOtp(submittedCode);
  const a = Buffer.from(submittedHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
