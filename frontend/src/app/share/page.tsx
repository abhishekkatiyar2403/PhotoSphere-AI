"use client";

// Share page (specs/guest-access-otp.md, design/wireframes/share-panel.svg -
// U1 Option B: dedicated /share route, two-column). Left column: folder
// multi-select (checkboxes) + Select-all + a running "N folders * M photos
// selected" tally. Right column: guest email, permission level, expiry,
// "Generate invite link" -> POST /api/guests, then the raw invite link with
// Copy. Auth-gated the same way /dashboard, /organize, /browse are.
//
// Folder source: same pattern /organize and /dashboard already use -
// collectionsApi.list() -> the default collection's id -> foldersApi.list().
// This is an owner-authed page; it does NOT need the Unfiled bucket (Unfiled
// photos have no folderId and can't be shared - folder_permissions are keyed
// on a real folder id per the spec's G3 decision), so unfiledPhotosApi is
// deliberately not used here.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ApiError,
  authApi,
  collectionsApi,
  CreateGuestResponse,
  Folder,
  foldersApi,
  guestsApi,
  PermissionLevel,
} from "@/lib/api";

function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

const PERMISSION_OPTIONS: { value: PermissionLevel; label: string }[] = [
  { value: "view", label: "View only — browse thumbnails, no download" },
  { value: "download", label: "Download — view + download each photo" },
  { value: "download_all", label: "Download all — same as download this pass" },
];

const EXPIRY_OPTIONS = [
  { value: "7", label: "In 7 days" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "", label: "Never" },
];

export default function SharePage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  const [folders, setFolders] = useState<Folder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [foldersError, setFoldersError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [guestEmail, setGuestEmail] = useState("");
  const [permissionLevel, setPermissionLevel] = useState<PermissionLevel>("download");
  const [expiresInDays, setExpiresInDays] = useState("7");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateGuestResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // ---- Auth gate (same pattern as /organize, /browse, /dashboard, /upload) ----
  useEffect(() => {
    authApi
      .me()
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  // ---- Load the owner's folders on mount (multi-fetch-on-mount, stale-guard) ----
  useEffect(() => {
    if (checking) return;
    let cancelled = false;

    (async () => {
      setFoldersLoading(true);
      setFoldersError(null);
      try {
        const collectionsRes = await collectionsApi.list();
        if (cancelled) return;
        const defaultCollection =
          collectionsRes.collections.find((c) => c.isDefault) ?? collectionsRes.collections[0] ?? null;
        if (!defaultCollection) {
          setFolders([]);
          return;
        }
        const foldersRes = await foldersApi.list(defaultCollection.id);
        if (cancelled) return;
        setFolders(foldersRes.folders);
      } catch (err) {
        if (cancelled) return;
        if (isAuthError(err)) {
          router.replace("/login");
          return;
        }
        setFoldersError(err instanceof Error ? err.message : "Failed to load folders");
      } finally {
        if (!cancelled) setFoldersLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checking, router]);

  function toggleFolder(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === folders.length ? new Set() : new Set(folders.map((f) => f.id))));
  }

  const selectedFolders = folders.filter((f) => selectedIds.has(f.id));
  const tallyPhotoCount = selectedFolders.reduce((sum, f) => sum + f.photoCount, 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedIds.size === 0) {
      setSubmitError("Select at least one folder to share.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    setCopied(false);
    try {
      const res = await guestsApi.create({
        guestEmail,
        folderIds: [...selectedIds],
        permissionLevel,
        expiresInDays: expiresInDays ? Number(expiresInDays) : undefined,
      });
      setResult(res);
    } catch (err) {
      if (isAuthError(err)) {
        router.replace("/login");
        return;
      }
      setSubmitError(err instanceof Error ? err.message : "Failed to create share");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. non-secure context) - the link is
      // still visible and selectable in the input, no hard failure needed.
    }
  }

  if (checking) return null;

  return (
    <main className="share-shell">
      <div className="organize-topbar">
        <h1>
          <Link href="/dashboard" className="organize-topbar-logo-link" data-testid="share-dashboard-link">
            PhotoSphere AI
          </Link>{" "}
          — Share
        </h1>
        <div className="dashboard-topbar-right">
          <Link href="/upload" className="dashboard-guests-link" data-testid="share-upload-link">
            Upload
          </Link>
          <Link href="/organize" className="dashboard-guests-link" data-testid="share-organize-link">
            Organize
          </Link>
          <Link href="/browse" className="dashboard-guests-link" data-testid="share-browse-link">
            Browse
          </Link>
          <Link href="/search" className="dashboard-guests-link" data-testid="share-search-link">
            Search
          </Link>
          <Link href="/guests" className="dashboard-guests-link" data-testid="share-guests-link">
            Guests
          </Link>
          <Link href="/activity" className="dashboard-guests-link" data-testid="share-activity-link">
            Activity
          </Link>
          <Link href="/trash" className="dashboard-guests-link" data-testid="share-trash-link">
            Trash
          </Link>
        </div>
      </div>

      <div className="share-content">
        <div className="share-heading">
          <h2>Create a share</h2>
          <p>Pick folders, set access, generate a link to send your client.</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="share-columns">
            <div className="share-panel">
              <div className="share-panel-head">
                <h3>Folders to share</h3>
                {folders.length > 0 && (
                  <button type="button" className="share-select-all" onClick={toggleSelectAll}>
                    {selectedIds.size === folders.length ? "Deselect all" : "Select all"}
                  </button>
                )}
              </div>

              {foldersLoading && <p className="organize-empty">Loading folders…</p>}
              {foldersError && <p className="share-error">{foldersError}</p>}
              {!foldersLoading && !foldersError && folders.length === 0 && (
                <p className="organize-empty">No folders yet — organize some photos first.</p>
              )}

              {!foldersLoading && folders.length > 0 && (
                <ul className="share-folder-list" data-testid="share-folder-list">
                  {folders.map((folder) => {
                    const selected = selectedIds.has(folder.id);
                    return (
                      <li key={folder.id}>
                        <label className={`share-folder-row${selected ? " selected" : ""}`}>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleFolder(folder.id)}
                            data-testid={`share-folder-checkbox-${folder.name}`}
                          />
                          <span className="name">{folder.name}</span>
                          <span className="count">{folder.photoCount}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="share-tally" data-testid="share-tally">
                {selectedFolders.length} folder{selectedFolders.length === 1 ? "" : "s"} · {tallyPhotoCount} photo
                {tallyPhotoCount === 1 ? "" : "s"} selected
              </div>
            </div>

            <div className="share-panel">
              <div className="share-field">
                <label htmlFor="guest-email">Guest email</label>
                <input
                  id="guest-email"
                  type="email"
                  required
                  placeholder="client@example.com"
                  value={guestEmail}
                  onChange={(e) => setGuestEmail(e.target.value)}
                  data-testid="share-guest-email"
                />
              </div>

              <div className="share-field">
                <label htmlFor="permission-level">Permission level</label>
                <select
                  id="permission-level"
                  value={permissionLevel}
                  onChange={(e) => setPermissionLevel(e.target.value as PermissionLevel)}
                  data-testid="share-permission-level"
                >
                  {PERMISSION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="share-field">
                <label htmlFor="expires-in">Link expires</label>
                <select
                  id="expires-in"
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                  data-testid="share-expiry"
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option key={opt.label} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {submitError && <p className="share-error">{submitError}</p>}

              <button
                type="submit"
                className="share-submit"
                disabled={submitting || selectedIds.size === 0 || !guestEmail}
                data-testid="share-submit"
              >
                {submitting ? "Generating…" : "Generate invite link"}
              </button>

              {result && (
                <div className="share-result" data-testid="share-result">
                  <h4>Shareable link</h4>
                  <div className="share-result-row">
                    <input type="text" readOnly value={result.inviteUrl} data-testid="share-invite-url" />
                    <button type="button" onClick={handleCopy} data-testid="share-copy-button">
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
