/**
 * Swappable notification interface (specs/guest-access-otp.md §4, Hard
 * constraint 1). Exactly mirrors the classification module's one-file-swap
 * pattern (lib/classification/index.ts): callers depend only on this module's
 * `sendOwnerOtp()` export, never a concrete provider, so wiring in a real
 * email/SMS provider later is a one-file change here and nothing else.
 *
 * NO real network call happens here, EVER — no Twilio / SendGrid / SES /
 * Resend, no cloud credentials, no JWT — until Abhishek explicitly wires in a
 * real provider (CLAUDE.md ground rule). The OTP goes to the OWNER, who
 * approves; the guest never types it (roadmap §12 Layer 5).
 *
 * The mock records the last delivery per requestId in an in-memory map and
 * exposes the plaintext code ONLY under NOTIFICATIONS_EXPOSE_OTP === "true"
 * or NODE_ENV === "test", so the Tester Agent can complete the flow
 * end-to-end. In any other mode the plaintext is never returned or logged.
 */

export interface OwnerOtpMessage {
  ownerEmail: string;
  ownerName: string;
  guestEmail: string;
  code: string;
  requestId: string;
}

export interface NotificationProvider {
  sendOwnerOtp(message: OwnerOtpMessage): Promise<void>;
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
    // eslint-disable-next-line no-console
    console.log(
      `[notifications:mock] OTP for access request ${message.requestId} "delivered" to owner ${message.ownerEmail} (guest: ${message.guestEmail}). Plaintext withheld.`,
    );
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
}

const provider = new MockNotificationProvider();

export async function sendOwnerOtp(message: OwnerOtpMessage): Promise<void> {
  return provider.sendOwnerOtp(message);
}

/**
 * Test/dev-only accessor for the plaintext OTP (gated on the exposure flag).
 * Returns null in dev/prod so a stray call can never leak a live code. Used
 * by GET /api/invites/requests/:requestId/otp (test-only surface) so Tester
 * can read the code without DB access. NOT wired for real users.
 */
export function getExposedOtp(requestId: string): string | null {
  return provider.getExposedOtp(requestId);
}

export function wasOtpDelivered(requestId: string): boolean {
  return provider.wasDelivered(requestId);
}
