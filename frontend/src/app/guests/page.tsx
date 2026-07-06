"use client";

// Guests page (specs/guest-access-otp.md, design/wireframes/guest-management.svg
// - U2 Option C: single prioritized feed). Pending OTP-approval requests
// float to the top under an attention banner (email, IP/device, "requested
// N min ago", inline 6-digit OTP entry, Approve/Deny, attempts/expiry
// hint) - GET /api/access-requests?status=pending, then
// POST /api/access-requests/:id/approve|deny. Below that in the same
// stream: the guest roster (GET /api/guests) with status pills and one-tap
// Revoke (DELETE /api/guests/:id). "+ Share new folders" reaches /share.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AccessRequestItem,
  accessRequestsApi,
  ApiError,
  authApi,
  GuestListItem,
  guestsApi,
} from "@/lib/api";

// Owner-session-loss detector. Use this ONLY on calls where a 401 genuinely
// means the OWNER's session is gone (the initial authApi.me() gate, the
// list() calls in load(), and revoke). Do NOT use it on the approve/deny
// endpoints: there a 401 is a business response ("Invalid code" for a wrong
// OTP), not an auth failure - bouncing the owner to /login on a mistyped
// digit is BUG-1. Approve/deny surface every error inline instead.
function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

export default function GuestsPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  const [pending, setPending] = useState<AccessRequestItem[]>([]);
  const [guests, setGuests] = useState<GuestListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-request OTP input + action state, keyed by access_request id.
  const [otpInputs, setOtpInputs] = useState<Record<string, string>>({});
  const [actionState, setActionState] = useState<Record<string, { busy: boolean; error: string | null }>>({});
  const [revokeState, setRevokeState] = useState<Record<string, { busy: boolean; error: string | null }>>({});

  // ---- Auth gate (same pattern as /organize, /browse, /dashboard, /share) ----
  useEffect(() => {
    authApi
      .me()
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [pendingRes, guestsRes] = await Promise.all([
        accessRequestsApi.list("pending"),
        guestsApi.list(),
      ]);
      setPending(pendingRes.requests);
      setGuests(guestsRes.guests);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setLoadError(err instanceof Error ? err.message : "Failed to load guests");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (checking) return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [checking, load]);

  async function handleApprove(requestId: string) {
    const otp = (otpInputs[requestId] ?? "").trim();
    if (!/^\d{6}$/.test(otp)) {
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: "Enter the 6-digit code" } }));
      return;
    }
    setActionState((prev) => ({ ...prev, [requestId]: { busy: true, error: null } }));
    try {
      await accessRequestsApi.approve(requestId, otp);
      setPending((prev) => prev.filter((r) => r.id !== requestId));
      await load();
    } catch (err) {
      // DELIBERATELY no isAuthError()->/login here (BUG-1). The approve
      // endpoint's errors are all business responses about the OTP, NOT the
      // owner's own session:
      //   401 "Invalid code"      -> wrong OTP; show inline, owner retries.
      //   403 "request denied"    -> 3rd wrong attempt auto-denied the request.
      //   403 "expired" / "OTP expired" -> the code timed out.
      // Every case stays on the page with an inline message. On a 403 the
      // request is now terminal (auto-denied/expired), so refresh the list to
      // drop it out of the pending stream.
      const message = err instanceof Error ? err.message : "Approval failed";
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: message } }));
      if (err instanceof ApiError && err.status === 403) {
        await load();
      }
    }
  }

  async function handleDeny(requestId: string) {
    setActionState((prev) => ({ ...prev, [requestId]: { busy: true, error: null } }));
    try {
      await accessRequestsApi.deny(requestId);
      setPending((prev) => prev.filter((r) => r.id !== requestId));
      await load();
    } catch (err) {
      // Same as approve: deny is an operation on the request, not an
      // owner-session gate. Its errors (403/409 on an already-resolved
      // request) surface inline; we never treat them as "owner logged out".
      const message = err instanceof Error ? err.message : "Deny failed";
      setActionState((prev) => ({ ...prev, [requestId]: { busy: false, error: message } }));
    }
  }

  async function handleRevoke(guestId: string) {
    setRevokeState((prev) => ({ ...prev, [guestId]: { busy: true, error: null } }));
    try {
      await guestsApi.revoke(guestId);
      await load();
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      const message = err instanceof Error ? err.message : "Revoke failed";
      setRevokeState((prev) => ({ ...prev, [guestId]: { busy: false, error: message } }));
    }
  }

  if (checking) return null;

  return (
    <main className="guests-shell">
      <div className="organize-topbar">
        <h1>PhotoSphere AI — Guests</h1>
        <div className="dashboard-topbar-right">
          <Link href="/activity" className="dashboard-guests-link" data-testid="guests-activity-link">
            Activity
          </Link>
        </div>
      </div>

      <div className="guests-content">
        <div className="guests-head">
          <h2>Guest activity</h2>
          <Link href="/share" className="guests-new-share-link" data-testid="guests-new-share-link">
            + Share new folders
          </Link>
        </div>

        {loading && <p className="organize-empty">Loading…</p>}
        {loadError && <p className="share-error">{loadError}</p>}

        {!loading && !loadError && (
          <>
            {pending.length > 0 && (
              <>
                <div className="guests-attention-banner" data-testid="guests-attention-banner">
                  {pending.length} request{pending.length === 1 ? "" : "s"} need your approval — enter the code you
                  received to let each guest in.
                </div>

                {pending.map((request) => {
                  const otp = otpInputs[request.id] ?? "";
                  const state = actionState[request.id] ?? { busy: false, error: null };
                  const folderNames = guests.find((g) => g.id === request.guest.id)?.folders.map((f) => f.name) ?? [];
                  return (
                    <div key={request.id} className="guests-pending-card" data-testid={`guests-pending-card-${request.id}`}>
                      <div className="guests-pending-head">
                        <span className="email">{request.guest.email}</span>
                      </div>
                      <div className="guests-pending-meta">
                        {folderNames.length > 0 ? `wants ${folderNames.join(", ")} · ` : ""}
                        {request.ipAddress ? `IP ${request.ipAddress} · ` : ""}
                        {request.deviceInfo?.userAgent ? `${request.deviceInfo.userAgent} · ` : ""}
                        {timeAgo(request.createdAt)}
                      </div>

                      <div className="guests-pending-actions">
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          placeholder="6-digit code"
                          className="guests-otp-input"
                          value={otp}
                          onChange={(e) =>
                            setOtpInputs((prev) => ({ ...prev, [request.id]: e.target.value.replace(/\D/g, "") }))
                          }
                          data-testid={`guests-otp-input-${request.id}`}
                        />
                        <button
                          type="button"
                          className="guests-approve-btn"
                          disabled={state.busy}
                          onClick={() => handleApprove(request.id)}
                          data-testid={`guests-approve-button-${request.id}`}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="guests-deny-btn"
                          disabled={state.busy}
                          onClick={() => handleDeny(request.id)}
                          data-testid={`guests-deny-button-${request.id}`}
                        >
                          Deny
                        </button>
                      </div>

                      {state.error && <p className="guests-pending-error">{state.error}</p>}
                    </div>
                  );
                })}
              </>
            )}

            <h3 className="guests-roster-head">Active &amp; past guests</h3>

            {guests.length === 0 ? (
              <p className="guests-empty">No guests yet — create a share to invite one.</p>
            ) : (
              guests.map((guest) => {
                const revoke = revokeState[guest.id] ?? { busy: false, error: null };
                const canRevoke = guest.status !== "revoked";
                return (
                  <div key={guest.id} className={`guests-roster-row${guest.status === "revoked" ? " revoked" : ""}`} data-testid={`guests-roster-row-${guest.id}`}>
                    <span className="email">{guest.email}</span>
                    <span className="meta">
                      {guest.folders.map((f) => f.name).join(", ") || "no folders"}
                      {guest.permissionLevel ? ` · ${guest.permissionLevel}` : ""}
                      {guest.lastAccessAt ? ` · last seen ${timeAgo(guest.lastAccessAt)}` : ""}
                    </span>
                    <span className={`guests-status-pill ${guest.status}`}>{guest.status}</span>
                    {canRevoke && (
                      <button
                        type="button"
                        className="guests-revoke-btn"
                        disabled={revoke.busy}
                        onClick={() => handleRevoke(guest.id)}
                        data-testid={`guests-revoke-button-${guest.id}`}
                      >
                        Revoke
                      </button>
                    )}
                    {revoke.error && <p className="guests-pending-error">{revoke.error}</p>}
                  </div>
                );
              })
            )}
          </>
        )}
      </div>
    </main>
  );
}
