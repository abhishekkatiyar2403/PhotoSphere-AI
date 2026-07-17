"use client";

// Upload v2 — redesign handoff (README.md "Upload", PhotoSphere.dc.html
// Upload screen), living side-by-side with the classic /upload page. The
// upload machinery is carried over from src/app/upload/page.tsx unchanged:
// per-file queue with UPLOAD_CONCURRENCY workers, photosApi.uploadWithProgress
// (real XHR transport progress — the prototype's setInterval simulation is
// replaced exactly as the README instructs), then a status poll until
// done/duplicate/failed, then a thumbnail fetch. Only the markup/styling
// changes: the design's large dashed dropzone (click-to-browse + drag/drop)
// and per-file cards with progress bars that flip to a green check +
// "Tagged ✓" on completion (duplicate/failed keep their distinct states —
// real outcomes the prototype doesn't model).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, photosApi } from "@/lib/api";
import Ps2Shell from "@/components/ps2/Shell";

type PollStatus = "pending" | "processing" | "done" | "duplicate" | "failed";

type UploadItem = {
  key: string; // client-only key; queued/uploading items have no photoId yet
  file: File;
  queueStatus: "queued" | "uploading" | "polling" | "done" | "duplicate" | "failed" | "error";
  progress: number; // 0..1, upload-transport progress only
  photoId: string | null;
  pollStatus: PollStatus | null;
  labels: string[];
  duplicateOfPhotoId: string | null;
  thumbnailUrl: string | null;
  error: string | null;
};

// Same cap + interval as the classic page (see its comment for rationale).
const UPLOAD_CONCURRENCY = 3;
const POLL_INTERVAL_MS = 2000;

function makeKey(file: File, index: number) {
  return `${file.name}-${file.size}-${file.lastModified}-${index}-${Date.now()}`;
}

// Terminal display per queue status: label + color class for the card's
// right-hand status text.
function statusDisplay(item: UploadItem): { label: string; cls: string } {
  switch (item.queueStatus) {
    case "queued":
      return { label: "Queued", cls: "" };
    case "uploading":
      return { label: `${Math.round(item.progress * 100)}%`, cls: "" };
    case "polling":
      return { label: item.pollStatus === "processing" ? "Classifying…" : "Processing…", cls: "" };
    case "done":
      return { label: "Tagged ✓", cls: "ps2-status-ok" };
    case "duplicate":
      return { label: "Duplicate", cls: "ps2-status-warn" };
    case "failed":
      return { label: "Classification failed", cls: "ps2-status-err" };
    case "error":
      return { label: "Upload failed", cls: "ps2-status-err" };
  }
}

export default function UploadV2Page() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pollRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  useEffect(() => {
    authApi
      .me()
      .then((res) => setUser(res.user))
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  useEffect(() => {
    const pollMap = pollRefs.current;
    return () => {
      pollMap.forEach((interval) => clearInterval(interval));
      pollMap.clear();
    };
  }, []);

  function updateItem(key: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  function startPoll(key: string, photoId: string) {
    const interval = setInterval(async () => {
      try {
        const statusRes = await photosApi.status(photoId);
        const pollStatus = statusRes.status as PollStatus;
        updateItem(key, { pollStatus });

        if (["done", "duplicate", "failed"].includes(pollStatus)) {
          clearInterval(interval);
          pollRefs.current.delete(key);

          updateItem(key, {
            queueStatus: pollStatus as "done" | "duplicate" | "failed",
            labels: statusRes.aiLabels ?? [],
            duplicateOfPhotoId: statusRes.duplicateOfPhotoId ?? null,
          });

          if (pollStatus === "done") {
            try {
              const photo = await photosApi.get(photoId);
              updateItem(key, {
                thumbnailUrl: photo.thumbnails?.["400"] ?? photo.original?.url ?? null,
              });
            } catch {
              // Thumbnail fetch failing after a successful upload+classify
              // shouldn't flip this item's terminal status to an error.
            }
          }
        }
      } catch (pollErr) {
        clearInterval(interval);
        pollRefs.current.delete(key);
        updateItem(key, {
          queueStatus: "error",
          error: pollErr instanceof Error ? pollErr.message : "Polling failed",
        });
      }
    }, POLL_INTERVAL_MS);
    pollRefs.current.set(key, interval);
  }

  async function uploadOne(item: UploadItem) {
    updateItem(item.key, { queueStatus: "uploading", progress: 0, error: null });
    try {
      const res = await photosApi.uploadWithProgress(item.file, (fraction) =>
        updateItem(item.key, { progress: fraction }),
      );
      updateItem(item.key, {
        queueStatus: "polling",
        photoId: res.photoId,
        pollStatus: "pending" as PollStatus,
      });
      startPoll(item.key, res.photoId);
    } catch (uploadErr) {
      updateItem(item.key, {
        queueStatus: "error",
        error: uploadErr instanceof Error ? uploadErr.message : "Upload failed",
      });
    }
  }

  // Same worker-pool queue as the classic page: at most UPLOAD_CONCURRENCY
  // uploads in flight; one item failing never blocks the others.
  const runQueue = useCallback((queued: UploadItem[]) => {
    let cursor = 0;
    function nextItem(): UploadItem | undefined {
      const next = queued[cursor];
      cursor += 1;
      return next;
    }
    async function worker() {
      let item = nextItem();
      while (item) {
        await uploadOne(item);
        item = nextItem();
      }
    }
    const workerCount = Math.min(UPLOAD_CONCURRENCY, queued.length);
    for (let i = 0; i < workerCount; i += 1) {
      void worker();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    const newItems: UploadItem[] = files.map((file, index) => ({
      key: makeKey(file, index),
      file,
      queueStatus: "queued",
      progress: 0,
      photoId: null,
      pollStatus: null,
      labels: [],
      duplicateOfPhotoId: null,
      thumbnailUrl: null,
      error: null,
    }));
    setItems((prev) => [...prev, ...newItems]);
    runQueue(newItems);
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file(s) again
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  if (checking) return null;
  if (!user) return null; // redirect already in flight

  const terminalCount = items.filter((it) =>
    ["done", "duplicate", "failed", "error"].includes(it.queueStatus),
  ).length;
  const allSettled = items.length > 0 && terminalCount === items.length;

  return (
    <Ps2Shell active="upload" userName={user.name} classicHref="/upload">
      <main className="ps2-upload" data-testid="upload-v2">
        <h1 className="ps2-h1-page ps2-anim-up" style={{ marginBottom: 24 }}>
          Add to your sphere
        </h1>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          onChange={handleFileInputChange}
          data-testid="upload-file-input"
          style={{ display: "none" }}
        />

        <button
          type="button"
          className={`ps2-dropzone${dragActive ? " ps2-dropzone-active" : ""}`}
          data-testid="upload-dropzone"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <span className="ps2-dropzone-icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4m-6 6 6-6 6 6M4 20h16" /></svg>
          </span>
          <span className="ps2-dropzone-title" style={{ display: "block" }}>
            Drop photos here, or click to browse
          </span>
          <span className="ps2-dropzone-sub" style={{ display: "block" }}>
            JPEG, PNG, WebP, HEIC. AI tags everything on arrival.
          </span>
        </button>

        {items.length > 0 && (
          <div className="ps2-upload-list" data-testid="upload-list">
            <div className="ps2-upload-list-head">
              <span className="ps2-upload-headline">
                {allSettled ? "All photos processed" : `Uploading ${items.length} photo${items.length === 1 ? "" : "s"}`}
              </span>
              <span className="ps2-upload-subline">
                {terminalCount} of {items.length} done · AI tagging on arrival
              </span>
            </div>

            {items.map((item) => {
              const display = statusDisplay(item);
              const barPct =
                item.queueStatus === "queued"
                  ? 0
                  : item.queueStatus === "uploading"
                    ? item.progress * 100
                    : 100;
              return (
                <div key={item.key} className="ps2-upload-card" data-testid="upload-item">
                  <div className="ps2-upload-thumb">
                    {item.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.thumbnailUrl} alt={item.file.name} />
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
                    )}
                  </div>

                  <div className="ps2-upload-card-main">
                    <div className="ps2-upload-card-row">
                      <span className="ps2-upload-card-name">{item.file.name}</span>
                      <span className={`ps2-upload-card-status ${display.cls}`} data-testid="upload-status">
                        {display.label}
                      </span>
                    </div>
                    <div className="ps2-progress" style={{ height: 5 }}>
                      <div className="ps2-progress-fill" style={{ width: `${barPct}%` }} data-testid="upload-progress" />
                    </div>
                    {item.error && <div className="ps2-upload-card-labels ps2-status-err">{item.error}</div>}
                    {item.queueStatus === "duplicate" && item.duplicateOfPhotoId && (
                      <div className="ps2-upload-card-labels">duplicate of photo {item.duplicateOfPhotoId}</div>
                    )}
                    {item.labels.length > 0 && (
                      <div className="ps2-upload-card-labels">{item.labels.join(", ")}</div>
                    )}
                  </div>

                  {item.queueStatus === "done" && (
                    <span className="ps2-upload-check">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </Ps2Shell>
  );
}
