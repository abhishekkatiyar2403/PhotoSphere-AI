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

  async sendOwnerOtp(message: OwnerOtpMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.fromEmail,
        to: message.ownerEmail,
        subject: `PhotoSphere AI — approve ${message.guestEmail}'s access request`,
        text: `${message.guestEmail} is requesting access to folders you shared with them.\n\nApproval code: ${message.code}\n(expires in 5 minutes)\n\nEnter this code on your Guests page to approve, or ignore this email to leave the request pending until it expires.`,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.error(`[notifications:resend] send failed (${res.status}) for request ${message.requestId}: ${body}`);
      throw new Error(`Resend send failed with status ${res.status}`);
    }
  }
}

// Running under Vitest ALWAYS forces the mock, regardless of RESEND_API_KEY
// — the shared .env that carries real Resend credentials for local dev also
// gets loaded by the test suite, and the OTP flow tests depend on
// deterministic, zero-cost, zero-network delivery (plus getExposedOtp(),
// which only ever works against the mock). Same pattern/reasoning as
// lib/classification/index.ts and lib/storage.ts.
const provider: NotificationProvider =
  process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL && !process.env.VITEST
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
