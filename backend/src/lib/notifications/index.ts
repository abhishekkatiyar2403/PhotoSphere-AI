/**
 * Swappable notification interface (specs/guest-access-otp.md §4, Hard
 * constraint 1). Callers depend only on this module's `sendOwnerOtp()`
 * export, never a concrete provider.
 *
 * Two providers: the original in-memory mock (default — no real network
 * call, ever, unless explicitly configured), and a real Resend-backed one,
 * used ONLY when RESEND_API_KEY is set (production deploy, explicitly
 * configured by Abhishek — see .env.example / Railway env vars). Nothing
 * else in the app needs to know which is active.
 *
 * The mock records the last delivery per requestId in an in-memory map and
 * exposes the plaintext code ONLY under NOTIFICATIONS_EXPOSE_OTP === "true"
 * or NODE_ENV === "test", so the Tester Agent can complete the flow
 * end-to-end. getExposedOtp() always returns null when the real provider is
 * active — there's nothing to expose once mail is actually being sent.
 */

import dns from "node:dns";
import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../logger";

export interface OwnerOtpMessage {
  ownerEmail: string;
  ownerName: string;
  guestEmail: string;
  code: string;
  requestId: string;
}

// 2026-07-13 backend audit #9: the guest never used to get emailed their own
// invite link — the owner had to copy/share it manually. keyEmail is what
// the mock keys its in-memory delivery record by (so multiple invites to the
// same guest email are each individually inspectable in tests).
export interface GuestInviteMessage {
  guestEmail: string;
  ownerName: string;
  inviteUrl: string;
}

// 2026-07-13 backend audit #8: password reset.
export interface PasswordResetMessage {
  toEmail: string;
  resetUrl: string;
}

export interface NotificationProvider {
  sendOwnerOtp(message: OwnerOtpMessage): Promise<void>;
  sendGuestInvite(message: GuestInviteMessage): Promise<void>;
  sendPasswordReset(message: PasswordResetMessage): Promise<void>;
}

// Only ever expose the plaintext OTP to the test-visibility surface when
// explicitly opted in (Tester's env) — never in dev/prod.
function otpExposureEnabled(): boolean {
  return process.env.NOTIFICATIONS_EXPOSE_OTP === "true" || process.env.NODE_ENV === "test";
}

interface RecordedDelivery {
  requestId: string;
  ownerEmail: string;
  guestEmail: string;
  code: string; // held in-memory only; surfaced via getExposedOtp() under the test flag
  sentAt: number;
}

class MockNotificationProvider implements NotificationProvider {
  private readonly deliveries = new Map<string, RecordedDelivery>();
  // Keyed by guestEmail / toEmail — last delivery only (a real inbox would
  // show every send, but "the most recent link is the one that matters" is
  // the only thing tests/dev ever need to inspect).
  private readonly guestInviteDeliveries = new Map<string, GuestInviteMessage>();
  private readonly passwordResetDeliveries = new Map<string, PasswordResetMessage>();

  async sendOwnerOtp(message: OwnerOtpMessage): Promise<void> {
    // Deliberately synchronous + in-memory. No I/O, no network. If real
    // delivery is ever swapped in and proves slow, THAT provider can move
    // the send into a BullMQ job — the interface keeps it a contained change.
    this.deliveries.set(message.requestId, {
      requestId: message.requestId,
      ownerEmail: message.ownerEmail,
      guestEmail: message.guestEmail,
      code: message.code,
      sentAt: Date.now(),
    });

    // Never log the plaintext code. A non-sensitive breadcrumb is fine.
    logger.info(
      { requestId: message.requestId, ownerEmail: message.ownerEmail, guestEmail: message.guestEmail },
      "OTP for access request 'delivered' to owner (plaintext withheld)",
    );
  }

  async sendGuestInvite(message: GuestInviteMessage): Promise<void> {
    this.guestInviteDeliveries.set(message.guestEmail, message);
    logger.info({ guestEmail: message.guestEmail }, "guest invite email 'delivered'");
  }

  async sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    this.passwordResetDeliveries.set(message.toEmail, message);
    // The reset URL carries a live, single-use credential — never log it,
    // same discipline as never logging the plaintext OTP above.
    logger.info({ toEmail: message.toEmail }, "password reset email 'delivered' (link withheld)");
  }

  /** Test/dev-only: the plaintext OTP for a request, or null. Gated. */
  getExposedOtp(requestId: string): string | null {
    if (!otpExposureEnabled()) return null;
    return this.deliveries.get(requestId)?.code ?? null;
  }

  /** Whether a delivery was recorded for this request (safe in any mode). */
  wasDelivered(requestId: string): boolean {
    return this.deliveries.has(requestId);
  }

  /** Test/dev-only: the invite URL last sent to this guest email, or null. Gated. */
  getExposedGuestInviteUrl(guestEmail: string): string | null {
    if (!otpExposureEnabled()) return null;
    return this.guestInviteDeliveries.get(guestEmail)?.inviteUrl ?? null;
  }

  /** Test/dev-only: the reset URL last sent to this email, or null. Gated. */
  getExposedPasswordResetUrl(email: string): string | null {
    if (!otpExposureEnabled()) return null;
    return this.passwordResetDeliveries.get(email)?.resetUrl ?? null;
  }
}

/**
 * Real email delivery via Resend's HTTP API (https://resend.com) — plain
 * `fetch`, no SDK dependency added, since it's a single simple POST. Active
 * only when RESEND_API_KEY is set. `RESEND_FROM_EMAIL` must be an address on
 * a domain verified in the Resend dashboard (Resend's shared sandbox sender
 * only delivers to the account owner's own inbox — fine for solo testing,
 * not for real guests/owners).
 */
class ResendNotificationProvider implements NotificationProvider {
  private readonly apiKey: string;
  private readonly fromEmail: string;

  constructor(apiKey: string, fromEmail: string) {
    this.apiKey = apiKey;
    this.fromEmail = fromEmail;
  }

  private async send(
    to: string,
    subject: string,
    text: string,
    logContext: Record<string, unknown>,
  ): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: this.fromEmail, to, subject, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ status: res.status, body, ...logContext }, "Resend send failed");
      throw new Error(`Resend send failed with status ${res.status}`);
    }
  }

  async sendOwnerOtp(message: OwnerOtpMessage): Promise<void> {
    await this.send(
      message.ownerEmail,
      `PhotoSphere AI — approve ${message.guestEmail}'s access request`,
      `${message.guestEmail} is requesting access to folders you shared with them.\n\nApproval code: ${message.code}\n(expires in 5 minutes)\n\nEnter this code on your Guests page to approve, or ignore this email to leave the request pending until it expires.`,
      { requestId: message.requestId },
    );
  }

  async sendGuestInvite(message: GuestInviteMessage): Promise<void> {
    await this.send(
      message.guestEmail,
      `${message.ownerName} shared photos with you on PhotoSphere AI`,
      `${message.ownerName} has shared some photo folders with you.\n\nOpen this link to request access: ${message.inviteUrl}\n\nThe owner will need to approve your request before you can view anything.`,
      { guestEmail: message.guestEmail },
    );
  }

  async sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    await this.send(
      message.toEmail,
      "Reset your PhotoSphere AI password",
      `We received a request to reset your PhotoSphere AI password.\n\nReset it here: ${message.resetUrl}\n(this link expires in 1 hour)\n\nIf you didn't request this, you can safely ignore this email — your password won't be changed.`,
      { toEmail: message.toEmail },
    );
  }
}

/**
 * Real email delivery via Gmail's own SMTP server, authenticated as a real
 * mailbox (nodemailer + an App Password — never the account's real
 * password). Unlike Resend, this needs no domain verification: Gmail lets an
 * authenticated mailbox send to ANY recipient, which is exactly what Resend's
 * shared sandbox sender (onboarding@resend.dev) can't do. Active only when
 * GMAIL_USER + GMAIL_APP_PASSWORD are both set.
 */
class GmailNotificationProvider implements NotificationProvider {
  private readonly transporter: Transporter;
  private readonly fromEmail: string;

  constructor(user: string, appPassword: string) {
    this.fromEmail = user;
    // Some networks (confirmed on this deploy) route smtp.gmail.com's IPv6
    // address to an unreachable address while IPv4 works fine — Node 18+
    // prefers IPv6 by default, which silently breaks the connection with
    // EHOSTUNREACH. dns.setDefaultResultOrder is process-global (Node has no
    // per-connection DNS-order option), so this only fires when Gmail is
    // actually the configured provider — never as an unconditional
    // module-load side effect for deploys that don't use Gmail at all.
    dns.setDefaultResultOrder("ipv4first");
    this.transporter = nodemailer.createTransport({
      service: "gmail",
      // Google displays App Passwords as "abcd efgh ijkl mnop" (with
      // spaces) for readability, but the actual credential is the 16
      // characters with no spaces — strip them so a copy-pasted value
      // (spaces and all) still authenticates.
      auth: { user, pass: appPassword.replace(/\s+/g, "") },
    });
  }

  private async send(
    to: string,
    subject: string,
    text: string,
    logContext: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.transporter.sendMail({ from: this.fromEmail, to, subject, text });
    } catch (err) {
      logger.error({ err, ...logContext }, "Gmail SMTP send failed");
      throw err;
    }
  }

  async sendOwnerOtp(message: OwnerOtpMessage): Promise<void> {
    await this.send(
      message.ownerEmail,
      `PhotoSphere AI — approve ${message.guestEmail}'s access request`,
      `${message.guestEmail} is requesting access to folders you shared with them.\n\nApproval code: ${message.code}\n(expires in 5 minutes)\n\nEnter this code on your Guests page to approve, or ignore this email to leave the request pending until it expires.`,
      { requestId: message.requestId },
    );
  }

  async sendGuestInvite(message: GuestInviteMessage): Promise<void> {
    await this.send(
      message.guestEmail,
      `${message.ownerName} shared photos with you on PhotoSphere AI`,
      `${message.ownerName} has shared some photo folders with you.\n\nOpen this link to request access: ${message.inviteUrl}\n\nThe owner will need to approve your request before you can view anything.`,
      { guestEmail: message.guestEmail },
    );
  }

  async sendPasswordReset(message: PasswordResetMessage): Promise<void> {
    await this.send(
      message.toEmail,
      "Reset your PhotoSphere AI password",
      `We received a request to reset your PhotoSphere AI password.\n\nReset it here: ${message.resetUrl}\n(this link expires in 1 hour)\n\nIf you didn't request this, you can safely ignore this email — your password won't be changed.`,
      { toEmail: message.toEmail },
    );
  }
}

// Running under Vitest ALWAYS forces the mock, regardless of which real
// provider's env vars are set — the shared .env that carries real
// credentials for local dev also gets loaded by the test suite, and the OTP
// flow tests depend on deterministic, zero-cost, zero-network delivery (plus
// getExposedOtp(), which only ever works against the mock). Same
// pattern/reasoning as lib/classification/index.ts and lib/storage.ts.
//
// Gmail takes priority over Resend when both are configured — deliberate:
// Gmail sends to any recipient out of the box, while the Resend sandbox
// sender is restricted to the account owner's own inbox, so Gmail is
// strictly more useful for local/dev use until a real domain is verified in
// Resend.
const provider: NotificationProvider = process.env.VITEST
  ? new MockNotificationProvider()
  : process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
    ? new GmailNotificationProvider(process.env.GMAIL_USER, process.env.GMAIL_APP_PASSWORD)
    : process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL
      ? new ResendNotificationProvider(process.env.RESEND_API_KEY, process.env.RESEND_FROM_EMAIL)
      : new MockNotificationProvider();

export async function sendOwnerOtp(message: OwnerOtpMessage): Promise<void> {
  return provider.sendOwnerOtp(message);
}

/**
 * Test/dev-only accessor for the plaintext OTP (gated on the exposure flag,
 * AND only ever populated by the mock provider — always null when Resend is
 * active). Used by GET /api/invites/requests/:requestId/otp (test-only
 * surface) so Tester can read the code without DB access. NOT wired for real
 * users.
 */
export function getExposedOtp(requestId: string): string | null {
  if (!(provider instanceof MockNotificationProvider)) return null;
  return provider.getExposedOtp(requestId);
}

export function wasOtpDelivered(requestId: string): boolean {
  if (!(provider instanceof MockNotificationProvider)) return true; // Resend already threw on failure above
  return provider.wasDelivered(requestId);
}

export async function sendGuestInviteEmail(message: GuestInviteMessage): Promise<void> {
  return provider.sendGuestInvite(message);
}

/** Test/dev-only accessor for the invite URL last sent to a guest email. */
export function getExposedGuestInviteUrl(guestEmail: string): string | null {
  if (!(provider instanceof MockNotificationProvider)) return null;
  return provider.getExposedGuestInviteUrl(guestEmail);
}

export async function sendPasswordResetEmail(message: PasswordResetMessage): Promise<void> {
  return provider.sendPasswordReset(message);
}

/** Test/dev-only accessor for the reset URL last sent to an email address. */
export function getExposedPasswordResetUrl(email: string): string | null {
  if (!(provider instanceof MockNotificationProvider)) return null;
  return provider.getExposedPasswordResetUrl(email);
}
