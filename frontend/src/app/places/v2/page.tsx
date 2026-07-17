"use client";

// Places v2 — redesign handoff (PhotoSphere.dc.html "PLACES" screen): the
// design shows photos pinned to a map, clustered by where they were taken.
// PhotoSphere's backend does not extract or store GPS/location data from
// photos today (no lat/lng column, no places endpoint — see
// BACKEND_INTEGRATION.md's model list, which has no Place entity either), so
// this page intentionally does NOT fabricate pins from real photo data. It
// shows the same map chrome as the design with an honest empty state
// instead. Once EXIF GPS extraction + a places/clustering endpoint exist,
// swap the placeholder body for the real pin layout the design specifies.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, ApiError } from "@/lib/api";
import Ps2Shell from "@/components/ps2/Shell";

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export default function PlacesV2Page() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);

  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch((err) => {
        if (isAuthError(err)) router.replace("/login");
      })
      .finally(() => setChecking(false));
  }, [router]);

  if (checking) return null;
  if (!user) return null;

  return (
    <Ps2Shell active="places" userName={user.name} classicHref="/dashboard">
      <main className="ps2-places" data-testid="places-v2">
        <h1 className="ps2-h1" style={{ fontSize: 36 }}>Places</h1>
        <div className="ps2-places-sub">Your photos, pinned where they happened.</div>
        <div className="ps2-places-map">
          <div className="ps2-places-map-grid" aria-hidden="true" />
          <div className="ps2-places-empty">
            <div className="ps2-places-empty-title">Location data isn&apos;t available yet.</div>
            <div className="ps2-places-empty-body">
              PhotoSphere doesn&apos;t extract GPS from your photos yet, so there&apos;s nothing to
              pin to a map. This is a UI-only preview of the Places screen — ask about adding EXIF
              location extraction if you&apos;d like this built out.
            </div>
          </div>
        </div>
      </main>
    </Ps2Shell>
  );
}
