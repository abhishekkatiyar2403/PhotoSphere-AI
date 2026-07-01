"use client";

// Deliberately unstyled: a file input, a result box, and a poll loop.
// Exists purely so Tester can verify the full upload pipeline round-trip
// through the UI (not just curl/Postman) - per specs/upload-pipeline.md,
// the polished upload UI is Week 7-8 scope and out of bounds for this pass.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, photosApi } from "@/lib/api";

type PollStatus = "pending" | "processing" | "done" | "duplicate" | "failed";

export default function UploadPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [status, setStatus] = useState<PollStatus | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [duplicateOfPhotoId, setDuplicateOfPhotoId] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    authApi
      .me()
      .catch(() => router.replace("/login"))
      .finally(() => setChecking(false));
  }, [router]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function handleUpload() {
    if (!file) return;
    setError(null);
    setUploading(true);
    setStatus(null);
    setThumbnailUrl(null);
    setLabels([]);
    setDuplicateOfPhotoId(null);

    try {
      const res = await photosApi.upload(file);
      setPhotoId(res.photoId);
      setStatus("pending");

      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await photosApi.status(res.photoId);
          setStatus(statusRes.status);

          if (["done", "duplicate", "failed"].includes(statusRes.status)) {
            if (pollRef.current) clearInterval(pollRef.current);
            setLabels(statusRes.aiLabels ?? []);
            setDuplicateOfPhotoId(statusRes.duplicateOfPhotoId ?? null);

            if (statusRes.status === "done") {
              const photo = await photosApi.get(res.photoId);
              setThumbnailUrl(photo.thumbnails?.["400"] ?? photo.original?.url ?? null);
            }
          }
        } catch (pollErr) {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(pollErr instanceof Error ? pollErr.message : "Polling failed");
        }
      }, 2000);
    } catch (uploadErr) {
      setError(uploadErr instanceof Error ? uploadErr.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  if (checking) return null;

  return (
    <main style={{ padding: 24 }}>
      <h1>Upload a photo (test page)</h1>
      <p>Minimal round-trip proof only - polished upload UI is Week 7-8 scope.</p>

      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <button onClick={handleUpload} disabled={!file || uploading} style={{ marginLeft: 8 }}>
        {uploading ? "Uploading..." : "Upload"}
      </button>

      <div
        data-testid="upload-result"
        style={{ marginTop: 24, border: "1px solid #ccc", padding: 16, maxWidth: 480 }}
      >
        {error && <p style={{ color: "red" }}>{error}</p>}
        {photoId && (
          <>
            <p>Photo ID: {photoId}</p>
            <p data-testid="upload-status">Status: {status}</p>
            {status === "duplicate" && <p>Duplicate of photo: {duplicateOfPhotoId}</p>}
            {labels.length > 0 && <p>Labels: {labels.join(", ")}</p>}
            {thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbnailUrl} alt="thumbnail preview" style={{ maxWidth: 300 }} />
            )}
          </>
        )}
      </div>
    </main>
  );
}
