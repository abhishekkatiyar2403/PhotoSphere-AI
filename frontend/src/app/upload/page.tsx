"use client";

// specs/production-upload-batch.md — batch upload page. REWORKED from the
// old "loop the single-file POST /api/photos/upload endpoint N times" flow
// (still true of /upload/v2, untouched) to the new presigned-multipart batch
// path: ONE POST /api/upload/initiate for the whole selection (any file
// count, even 1 — Open Question #8, no dual-wiring), Uppy uploading every
// part directly to MinIO/S3 (see lib/uploadBatch.ts), then chunked
// POST /api/upload/complete calls turning each assembled file into a
// normally-processing Photo row. The existing photosApi.status polling for
// classification progress is UNCHANGED — it still runs per returned
// photoId, exactly as before, once /complete hands one back.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  authApi,
  isBatchLimitExceeded,
  photosApi,
  uploadApi,
  type CompleteUploadResult,
  type UploadFileDescriptor,
} from "@/lib/api";
import { createUppyForSession, CompletionBatcher, sha256OfFile } from "@/lib/uploadBatch";
import UiV2Banner from "@/components/UiV2Banner";

type PollStatus = "pending" | "processing" | "done" | "duplicate" | "failed";

type UploadItem = {
  clientId: string; // also the batch-lifecycle correlation id (initiate/complete/Uppy file id)
  file: File;
  queueStatus:
    | "queued"
    | "hashing"
    | "uploading"
    | "completing"
    | "polling"
    | "done"
    | "duplicate"
    | "failed"
    | "error";
  progress: number; // 0..1, part-upload transport progress only
  photoId: string | null;
  pollStatus: PollStatus | null;
  labels: string[];
  duplicateOfPhotoId: string | null;
  thumbnailUrl: string | null;
  error: string | null;
};

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
const POLL_INTERVAL_MS = 2000;

function makeClientId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

  function updateItem(clientId: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((it) => (it.clientId === clientId ? { ...it, ...patch } : it)));
  }

  function startPoll(clientId: string, photoId: string) {
    const interval = setInterval(async () => {
      try {
        const statusRes = await photosApi.status(photoId);
        const pollStatus = statusRes.status as PollStatus;
        updateItem(clientId, { pollStatus });

        if (["done", "duplicate", "failed"].includes(pollStatus)) {
          clearInterval(interval);
          pollRefs.current.delete(clientId);

          updateItem(clientId, {
            queueStatus: pollStatus as "done" | "duplicate" | "failed",
            labels: statusRes.aiLabels ?? [],
            duplicateOfPhotoId: statusRes.duplicateOfPhotoId ?? null,
          });

          if (pollStatus === "done") {
            try {
              const photo = await photosApi.get(photoId);
              updateItem(clientId, {
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
        pollRefs.current.delete(clientId);
        updateItem(clientId, {
          queueStatus: "error",
          error: pollErr instanceof Error ? pollErr.message : "Polling failed",
        });
      }
    }, POLL_INTERVAL_MS);
    pollRefs.current.set(clientId, interval);
  }

  function handleCompletionResult(result: CompleteUploadResult) {
    if ("photoId" in result) {
      updateItem(result.clientId, { queueStatus: "polling", photoId: result.photoId, pollStatus: "pending" });
      startPoll(result.clientId, result.photoId);
    } else {
      updateItem(result.clientId, { queueStatus: "failed", error: humanizeFailureReason(result.reason) });
    }
  }

  // Runs one whole selection (any number of files, even 1 — Open Question #8:
  // one code path, never falls back to the old single-file endpoint) through
  // the batch flow: hash -> initiate (one call for the whole batch) ->
  // Uppy part-uploads -> chunked completes -> per-photo polling.
  const runBatch = useCallback(async (newItems: UploadItem[]) => {
    for (const it of newItems) updateItem(it.clientId, { queueStatus: "hashing" });

    let descriptors: UploadFileDescriptor[];
    try {
      descriptors = await Promise.all(
        newItems.map(async (it) => ({
          clientId: it.clientId,
          filename: it.file.name,
          sizeBytes: it.file.size,
          mimeType: it.file.type as UploadFileDescriptor["mimeType"],
          sha256: await sha256OfFile(it.file),
        })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not read one or more files";
      for (const it of newItems) updateItem(it.clientId, { queueStatus: "error", error: message });
      return;
    }

    let initiateRes;
    try {
      initiateRes = await uploadApi.initiate(descriptors);
    } catch (err) {
      // specs/plan-tiered-upload.md: /initiate's plan-aware batch cap has a
      // distinct `error: "batch_limit_exceeded"` shape (not the generic Zod-
      // validation-failure shape) specifically so this can be special-cased
      // with a named plan/limit message instead of a generic "upload
      // failed" fallthrough.
      const message = isBatchLimitExceeded(err)
        ? `Your ${err.body.plan} plan allows batches of up to ${err.body.limit} photos — ${err.body.requested} were selected. Split into smaller batches, or switch plans in Settings.`
        : err instanceof Error
          ? err.message
          : "Could not start the upload batch";
      for (const it of newItems) updateItem(it.clientId, { queueStatus: "error", error: message });
      return;
    }

    // Duplicates: skipped entirely, no bytes uploaded for them at all — a
    // strictly better outcome than the old per-file flow's "upload, THEN the
    // worker catches it as a duplicate."
    for (const dup of initiateRes.duplicates) {
      updateItem(dup.clientId, { queueStatus: "duplicate", duplicateOfPhotoId: dup.existingPhotoId });
    }

    const toUpload = newItems.filter((it) => initiateRes!.files.some((f) => f.clientId === it.clientId));
    if (toUpload.length === 0) return;

    for (const it of toUpload) updateItem(it.clientId, { queueStatus: "uploading", progress: 0 });

    const batcher = new CompletionBatcher(initiateRes.sessionId, handleCompletionResult);
    const uppy = createUppyForSession(initiateRes, batcher);

    uppy.on("upload-progress", (file, progress) => {
      if (!file || progress.bytesTotal == null || progress.bytesTotal === 0) return;
      updateItem(file.meta.clientId as string, { progress: progress.bytesUploaded / progress.bytesTotal });
    });
    uppy.on("upload-error", (file, error) => {
      if (!file) return;
      updateItem(file.meta.clientId as string, {
        queueStatus: "error",
        error: error instanceof Error ? error.message : "Upload failed",
      });
    });

    for (const it of toUpload) {
      uppy.addFile({
        id: it.clientId,
        name: it.file.name,
        type: it.file.type,
        data: it.file,
        meta: { clientId: it.clientId },
      });
    }

    try {
      await uppy.upload();
    } finally {
      // Final call per spec — flush anything still queued once every file in
      // this batch has finished (or failed) its part-upload phase.
      await batcher.flush();
      batcher.destroy();
      uppy.destroy();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((f) => ALLOWED_MIME_TYPES.has(f.type));
    if (files.length === 0) return;
    const newItems: UploadItem[] = files.map((file) => ({
      clientId: makeClientId(),
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
    void runBatch(newItems);
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

  const uploadedCount = items.filter((it) => it.photoId !== null).length;
  const duplicateCount = items.filter((it) => it.queueStatus === "duplicate").length;
  const failedCount = items.filter((it) => it.queueStatus === "failed" || it.queueStatus === "error").length;

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
          <UiV2Banner href="/upload/v2" />
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
          <Link href="/trash" className="dashboard-guests-link" data-testid="upload-trash-link">
            Trash
          </Link>
          <Link href="/settings" className="dashboard-guests-link" data-testid="upload-settings-link">
            Settings
          </Link>
        </div>
      </div>

      <div style={{ padding: 24 }}>
        <p>
          Select or drop one or more photos to upload — hundreds at once, uploaded directly to storage. Each
          file uploads and classifies independently.
        </p>

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
          <p data-testid="upload-batch-summary" style={{ marginTop: 16, color: "#444" }}>
            {uploadedCount} of {items.length} uploaded
            {duplicateCount > 0 ? `, ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} skipped` : ""}
            {failedCount > 0 ? `, ${failedCount} failed` : ""}
          </p>
        )}

        {items.length > 0 && (
          <div style={{ marginTop: 12, maxWidth: 640 }} data-testid="upload-list">
            {items.map((item) => (
              <div
                key={item.clientId}
                data-testid="upload-item"
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 4,
                  padding: 12,
                  marginBottom: 12,
                }}
              >
                <p style={{ margin: 0, fontWeight: 600 }}>{item.file.name}</p>

                {(item.queueStatus === "queued" ||
                  item.queueStatus === "hashing" ||
                  item.queueStatus === "uploading") && (
                  <div style={{ marginTop: 8 }}>
                    <progress
                      data-testid="upload-progress"
                      value={item.progress}
                      max={1}
                      style={{ width: "100%" }}
                    />
                    <span style={{ marginLeft: 8 }}>
                      {item.queueStatus === "queued"
                        ? "Queued"
                        : item.queueStatus === "hashing"
                          ? "Preparing…"
                          : `${Math.round(item.progress * 100)}%`}
                    </span>
                  </div>
                )}

                {item.queueStatus === "duplicate" && (
                  <p style={{ margin: 0 }}>Already in your library — duplicate of photo: {item.duplicateOfPhotoId}</p>
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

function humanizeFailureReason(reason: string): string {
  switch (reason) {
    case "invalid_file_type":
      return "Unsupported or unrecognized file type";
    case "assembly_failed":
      return "Upload could not be assembled — please retry this file";
    case "not_found_or_already_processed":
      return "This file's upload session entry was not found";
    default:
      return "Upload failed";
  }
}
