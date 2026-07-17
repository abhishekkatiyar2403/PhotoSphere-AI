"use client";

// Settings page (specs/plan-tiered-upload.md's dev-only plan switcher).
// Wireframe pick: agents/STATUS.md "PICKED 2026-07-14 (Abhishek): a merge of
// A + B" — Option A's instant-apply 3-way segmented control (no separate
// "Apply plan" button, click = immediate switch) PLUS Option B's information
// density (each segment shows its batch-limit/storage/priority numbers
// inline, not a bare tier name). See design/wireframes/settings.svg for the
// picked layout record.
//
// This is a TESTING-ONLY control, not a real billing/upgrade flow: no
// pricing, no "Upgrade now" styling, explicit "(testing only — no billing)"
// copy per the spec's own copy discipline.
//
// The tier numbers below are hardcoded display copy, not fetched — they
// mirror backend/src/lib/plans.ts's BATCH_LIMITS/STORAGE_LIMITS_BYTES/
// PRIORITY_BY_PLAN exactly (free 50/5GB/Low, pro 500/100GB/Normal, studio
// 1500/500GB/High). Adding a dedicated endpoint just to fetch 9 static
// numbers wasn't worth it for a dev-only control; if those constants ever
// change, this file's TIER_INFO must be updated to match.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, authApi, PlanTier } from "@/lib/api";

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

const TIER_INFO: { plan: PlanTier; name: string; batch: string; storage: string; priority: string }[] = [
  { plan: "free", name: "Free", batch: "50/batch", storage: "5GB", priority: "Low" },
  { plan: "pro", name: "Pro", batch: "500/batch", storage: "100GB", priority: "Normal" },
  { plan: "studio", name: "Studio", batch: "1500/batch", storage: "500GB", priority: "High" },
];

export default function SettingsPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);
  const [plan, setPlan] = useState<PlanTier | null>(null);
  const [switching, setSwitching] = useState<PlanTier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justSwitchedTo, setJustSwitchedTo] = useState<PlanTier | null>(null);

  // ---- Auth gate, same pattern as /dashboard, /organize, /guests, /activity.
  // authApi.me() also carries the currently-active plan, used to highlight
  // the right segment on load. ----
  useEffect(() => {
    authApi
      .me()
      .then((res) => {
        setUser(res.user);
        setPlan(res.user.plan);
      })
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  async function handleLogout() {
    await authApi.logout();
    router.replace("/login");
  }

  async function handleSwitch(target: PlanTier) {
    if (target === plan || switching) return; // no-op on the already-active tier; no double-fire mid-request
    setSwitching(target);
    setError(null);
    setJustSwitchedTo(null);
    try {
      const res = await authApi.updatePlan(target);
      setPlan(res.user.plan);
      setJustSwitchedTo(res.user.plan);
      // Success indicator is transient, matching this app's other inline
      // confirmations (e.g. the guest-permission-level dropdown).
      setTimeout(() => setJustSwitchedTo(null), 3000);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to switch plan");
    } finally {
      setSwitching(null);
    }
  }

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  return (
    <main className="settings-page">
      <div className="organize-topbar">
        <h1>
          <Link href="/dashboard" className="organize-topbar-logo-link" data-testid="settings-dashboard-link">
            PhotoSphere AI
          </Link>{" "}
          — Settings
        </h1>
        <div className="dashboard-topbar-right">
          <Link href="/upload" className="dashboard-guests-link" data-testid="settings-upload-link">
            Upload
          </Link>
          <Link href="/organize" className="dashboard-guests-link" data-testid="settings-organize-link">
            Organize
          </Link>
          <Link href="/browse" className="dashboard-guests-link" data-testid="settings-browse-link">
            Browse
          </Link>
          <Link href="/search" className="dashboard-guests-link" data-testid="settings-search-link">
            Search
          </Link>
          <Link href="/guests" className="dashboard-guests-link" data-testid="settings-guests-link">
            Guests
          </Link>
          <Link href="/activity" className="dashboard-guests-link" data-testid="settings-activity-link">
            Activity
          </Link>
          <Link href="/trash" className="dashboard-guests-link" data-testid="settings-trash-link">
            Trash
          </Link>
          <Link
            href="/settings"
            className="dashboard-guests-link settings-nav-active"
            aria-current="page"
            data-testid="settings-settings-link"
          >
            Settings
          </Link>
          <span>{user.name}</span>
          <button type="button" className="dashboard-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>

      <div className="settings-content">
        <h2 className="settings-title">Settings</h2>

        <div className="settings-card" data-testid="settings-plan-card">
          <h3 className="settings-card-title">Plan (testing only — no billing)</h3>
          <p className="settings-card-sub">
            Switches your batch-upload cap, storage quota, and processing priority for testing purposes only.
            Switching applies immediately.
          </p>

          <div className="settings-segmented" role="group" aria-label="Plan tier">
            {TIER_INFO.map((tier) => {
              const isActive = plan === tier.plan;
              const isSwitching = switching === tier.plan;
              return (
                <button
                  key={tier.plan}
                  type="button"
                  className={`settings-segment${isActive ? " settings-segment-active" : ""}`}
                  aria-pressed={isActive}
                  disabled={switching !== null}
                  data-testid={`settings-segment-${tier.plan}`}
                  onClick={() => handleSwitch(tier.plan)}
                >
                  <span className="settings-segment-name">
                    {tier.name}
                    {isSwitching ? " — switching…" : ""}
                  </span>
                  <span className="settings-segment-stats">
                    {tier.batch} &middot; {tier.storage} &middot; {tier.priority}
                  </span>
                </button>
              );
            })}
          </div>

          {justSwitchedTo && !error && (
            <p className="settings-success" data-testid="settings-success">
              Switched to {TIER_INFO.find((t) => t.plan === justSwitchedTo)?.name ?? justSwitchedTo}.
            </p>
          )}

          {error && (
            <p className="share-error" data-testid="settings-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
