"use client";

// Multi-file upload page. Originally a deliberately unstyled single-file
// proof-of-concept ("polished upload UI is Week 7-8 scope") - that framing is
// now stale: multi-file selection/drop is a real product need surfaced via
// direct user feedback (users expect to select/drop several photos at once).
// This still calls the SAME single-file backend endpoint
// (photosApi.uploadWithProgress -> POST /api/photos/upload, multipart "file"
// field) once per selected file - the backend's one-file-per-request
// contract (multer .single("file")) is unchanged; this file only adds a
// per-file queue + concurrency cap on the client.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authApi, photosApi } from "@/lib/api";

type PollStatus = "pending" | "processing" | "done" | "duplicate" | "failed";

// Per-file upload item - mirrors the shape of state /organize's PhotoCard
// tracks per photo (id, status, labels, duplicate-of, thumbnail, error), just
// modeled as one entry in a list instead of one page-level set of fields, so
// each file's progress/status/result is fully independent of every other
// file's.
type UploadItem = {
  // A client-only key so React can key the list before a server photoId
  // exists (queued/uploading items have no photoId yet).
  key: string;
  file: File;
  queueStatus: "queued" | "uploading" | "polling" | "done" | "duplicate" | "failed" | "error";
  progress: number; // 0..1, upload-transport progress only (see handleUpload)
  photoId: string | null;
  pollStatus: PollStatus | null;
  labels: string[];
  duplicateOfPhotoId: string | null;
  thumbnailUrl: string | null;
  error: string | null;
};

// Small concurrency cap rather than fully sequential: uploads are I/O-bound
// (network + multer buffering), so running a few in parallel keeps a batch
// of photos moving noticeably faster than one-at-a-time while still staying
// well short of firing dozens of simultaneous multipart requests at the
// backend. 3 was chosen as a reasonable, unscientific cap - low enough to be
// gentle on the rate limiter and the single-file backend route, high enough
// to matter for a typical "select 5-20 photos" batch.
const UPLOAD_CONCURRENCY = 3;
const POLL_INTERVAL_MS = 2000;

function makeKey(file: File, index: number) {
  return `${file.name}-${file.size}-${file.lastModified}-${index}-${Date.now()}`;
}

export default function UploadPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const pollRefs = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  useEffect(() => {
    authApi
      .me()
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

  // Runs the queued items through uploadOne with a small concurrency cap -
  // each worker pulls the next still-queued item off the shared list until
  // none remain, so at most UPLOAD_CONCURRENCY uploads are in flight at once
  // regardless of how many files were added in one batch. One item failing
  // (network error, 4xx, etc.) only marks that item "error" and lets its
  // worker move on - it never blocks or hides the other items' progress.
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

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  if (checking) return null;

  return (
    <main>
      <div className="organize-topbar">
        <h1>
          <Link href="/dashboard" className="organize-topbar-logo-link" data-testid="upload-dashboard-link">
            PhotoSphere AI
          </Link>{" "}
          — Upload
        </h1>
        <div className="dashboard-topbar-right">
          <Link href="/organize" className="dashboard-guests-link" data-testid="upload-organize-link">
            Organize
          </Link>
          <Link href="/browse" className="dashboard-guests-link" data-testid="upload-browse-link">
            Browse
          </Link>
          <Link href="/search" className="dashboard-guests-link" data-testid="upload-search-link">
            Search
          </Link>
          <Link href="/guests" className="dashboard-guests-link" data-testid="upload-guests-link">
            Guests
          </Link>
          <Link href="/activity" className="dashboard-guests-link" data-testid="upload-activity-link">
            Activity
          </Link>
        </div>
      </div>

      <div style={{ padding: 24 }}>
        <p>Select or drop one or more photos to upload. Each file uploads and classifies independently.</p>

        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          onChange={handleFileInputChange}
          data-testid="upload-file-input"
        />

        <div
          data-testid="upload-dropzone"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            marginTop: 24,
            border: dragActive ? "2px dashed #2563eb" : "1px solid #ccc",
            background: dragActive ? "#eff6ff" : "transparent",
            padding: 16,
            maxWidth: 640,
          }}
        >
          <p style={{ margin: 0, color: "#666" }}>
            Drag and drop image files here, or use the file picker above.
          </p>
        </div>

        {items.length > 0 && (
          <div style={{ marginTop: 24, maxWidth: 640 }} data-testid="upload-list">
            {items.map((item) => (
              <div
                key={item.key}
                data-testid="upload-item"
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 4,
                  padding: 12,
                  marginBottom: 12,
                }}
              >
                <p style={{ margin: 0, fontWeight: 600 }}>{item.file.name}</p>

                {(item.queueStatus === "queued" || item.queueStatus === "uploading") && (
                  <div style={{ marginTop: 8 }}>
                    <progress
                      data-testid="upload-progress"
                      value={item.progress}
                      max={1}
                      style={{ width: "100%" }}
                    />
                    <span style={{ marginLeft: 8 }}>
                      {item.queueStatus === "queued" ? "Queued" : `${Math.round(item.progress * 100)}%`}
                    </span>
                  </div>
                )}

                {item.error && <p style={{ color: "red" }}>{item.error}</p>}

                {item.photoId && (
                  <>
                    <p style={{ margin: "8px 0 0" }}>Photo ID: {item.photoId}</p>
                    <p data-testid="upload-status" style={{ margin: 0 }}>
                      Status: {item.pollStatus}
                    </p>
                    {item.pollStatus === "duplicate" && (
                      <p style={{ margin: 0 }}>Duplicate of photo: {item.duplicateOfPhotoId}</p>
                    )}
                    {item.labels.length > 0 && <p style={{ margin: 0 }}>Labels: {item.labels.join(", ")}</p>}
                    {item.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbnailUrl}
                        alt="thumbnail preview"
                        style={{ maxWidth: 200, marginTop: 8 }}
                      />
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
