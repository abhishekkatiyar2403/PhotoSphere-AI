import crypto from "node:crypto";
import sharp from "sharp";
import { RekognitionClient, DetectLabelsCommand } from "@aws-sdk/client-rekognition";

/**
 * Swappable classification interface (spec Open Question 3). The mock
 * implementation below deterministically derives a label set from the
 * file's bytes so identical uploads classify identically (useful for the
 * dedup tests) without any real image content analysis. Callers (the
 * worker) only depend on this module's `classify()` export, never a
 * concrete provider.
 *
 * A real provider (Amazon Rekognition) is included below, but activates
 * ONLY when explicitly configured via CLASSIFICATION_PROVIDER=rekognition
 * (see provider selection at the bottom of this file) — unconfigured, the
 * mock stays active and this module makes no network call, ever, matching
 * the original CLAUDE.md ground rule now that Abhishek has explicitly
 * wired in real credentials.
 */

export interface ClassificationResult {
  labels: string[];
  confidence: number;
  /**
   * Per-label confidence (0-1), parallel to `labels`, populated by the
   * Rekognition provider (DetectLabels returns one confidence PER label).
   * Optional — the mock and older stored results don't carry it, and
   * categoryMapping falls back to the single overall `confidence` for every
   * label when absent. Added for the dominance-scoring fix: a weak stray
   * label ("Shark" at 55% on a river photo) must not carry the same weight
   * as a 99% "River" label when deciding the folder.
   */
  labelConfidences?: number[];
  /**
   * Rekognition's OWN taxonomy metadata per label, parallel to `labels`
   * (each label belongs to zero or more of Rekognition's ~40 fixed
   * top-level categories, e.g. "Iphone" -> ["Technology and Computing"]).
   * Optional, same convention as labelConfidences. This is the raw material
   * for DYNAMIC category creation (2026-07-10): when none of a photo's
   * labels match our curated table, the dominant taxonomy category still
   * tells us what kind of photo it is — so a folder can be auto-created for
   * it instead of dumping the photo in Uncategorized. Previously this data
   * was thrown away at the provider boundary.
   */
  labelTaxonomies?: string[][];
}

export interface ClassificationProvider {
  classify(imageBuffer: Buffer): Promise<ClassificationResult>;
}

const REKOGNITION_MAX_DIMENSION = 1600;
const REKOGNITION_JPEG_QUALITY = 82;

/**
 * Downscales + re-encodes an image buffer before sending it to ANY
 * Rekognition API — DetectLabels here, and DetectFaces/SearchFacesByImage/
 * IndexFaces in faces.ts, all of which share AWS's hard 5MB Image.Bytes
 * limit (2026-07-12 parameter audit, "the biggest reliability gap in the
 * audit"). Full-resolution phone photos routinely exceed it: a 12MP iPhone
 * JPEG is 3-6MB; HEIC decoded via the worker's decodeToJpeg (quality 90)
 * commonly lands 4-10MB; 48-108MP Android JPEGs are 8-15MB. Every photo
 * over the limit throws ImageTooLargeException — UNCAUGHT in classify()
 * (the whole job fails, photo stuck unclassified) and silently degraded to
 * the flat "People" folder in faces.ts's face-refinement path (caught
 * there, but real per-person/Group sorting never happens). On a modern-
 * phone library this can affect a meaningful fraction of photos — none of
 * the mapping/vocabulary tuning in categoryMapping.ts matters for a photo
 * that never reaches classification at all.
 *
 * Resizing the longest side to 1600px at JPEG quality 82 brings virtually
 * every real photo under ~500KB with no measurable accuracy loss —
 * DetectLabels/DetectFaces both operate on far smaller internal
 * representations already, so this doesn't trade accuracy for reliability,
 * it just removes a self-inflicted failure mode. Best-effort: any resize
 * failure sends the ORIGINAL buffer rather than failing classification
 * outright — Rekognition's own error (if any) is still the honest failure
 * mode, just never a self-inflicted one.
 */
export async function prepareForRekognition(imageBuffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(imageBuffer)
      .rotate() // respect EXIF orientation before resizing
      .resize(REKOGNITION_MAX_DIMENSION, REKOGNITION_MAX_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: REKOGNITION_JPEG_QUALITY })
      .toBuffer();
  } catch {
    return imageBuffer;
  }
}

// Extended per specs/ai-classification.md §3 so the category-mapping table
// is exercisable end-to-end: People (multi-category priority vs Nature),
// Food, Documents, Nature aliases, Animals, Vehicles, and one deliberately
// unmappable set (-> Uncategorized). One committed image fixture per set
// lives in backend/test/fixtures/ (see its README for the mapping).
const MOCK_LABEL_SETS: string[][] = [
  ["Person", "Outdoor"], // -> People (People > Nature priority)
  ["Food", "Meal"], // -> Food
  ["Document", "Text"], // -> Documents
  ["Landscape", "Nature"], // -> Nature (Open Question 2 aliases)
  ["Dog", "Animal"], // -> Animals
  ["Car", "Truck"], // -> Vehicles
  ["Abstract", "Pattern"], // -> unmappable -> Uncategorized
];

// Exposed so tests/Tester can verify the dedup gate actually short-circuits
// before classification, per the spec's acceptance criteria ("verifiable
// via a call counter/spy on the mock").
export let mockClassifyCallCount = 0;
export function resetMockClassifyCallCount(): void {
  mockClassifyCallCount = 0;
}

class MockClassificationProvider implements ClassificationProvider {
  async classify(imageBuffer: Buffer): Promise<ClassificationResult> {
    mockClassifyCallCount += 1;

    // Deterministic hash of the file bytes -> stable index into the fixed
    // label-set list. No real Vision API call, no real image analysis.
    const hash = crypto.createHash("sha256").update(imageBuffer).digest();
    const index = hash[0] % MOCK_LABEL_SETS.length;
    const confidence = 0.75 + (hash[1] % 20) / 100; // deterministic 0.75-0.94 range

    return {
      labels: MOCK_LABEL_SETS[index],
      confidence: Number(confidence.toFixed(2)),
    };
  }
}

/**
 * Real classification via Amazon Rekognition's DetectLabels API. Sends the
 * image bytes directly in the request (no S3 reference needed — works the
 * same whether storage is local MinIO or real S3) and asks for up to 30
 * labels at >=50% confidence, letting categoryMapping.ts's own
 * CONFIDENCE_THRESHOLD (60%) do the real "is this good enough" gating.
 * MaxLabels raised 15 → 30 (2026-07-12 parameter audit) → 100 (2026-07-18):
 * Rekognition bills per IMAGE, not per label, so this is free extra
 * evidence — and although labels come back sorted by confidence descending
 * (so a cap sheds the weakest labels first), a genuinely busy scene can
 * carry MORE than 30 labels above categoryMapping's 75% voting floor, at
 * which point a 30-label cap silently starves the curated dominance scoring
 * and the dynamic taxonomy fallback of real, above-the-floor signal. 100
 * removes truncation as a factor entirely; MinConfidence stays at 50 (NOT
 * raised to match the 75% floor) on purpose — the 50-75% tail never votes,
 * but it IS surfaced per-label on photo cards (Abhishek's 2026-07-11
 * request) and must keep flowing through.
 *
 * `result.confidence` is the TOP label's confidence (Rekognition returns a
 * confidence per label, not one overall score) — this is what
 * categoryMapping compares against its threshold. `result.labels` carries
 * every detected label name so categoryMapping can match against any of
 * them, same as the mock's multi-label sets.
 */
class RekognitionClassificationProvider implements ClassificationProvider {
  private readonly client: RekognitionClient;

  constructor(region: string) {
    this.client = new RekognitionClient({ region });
  }

  async classify(imageBuffer: Buffer): Promise<ClassificationResult> {
    const prepared = await prepareForRekognition(imageBuffer);
    const res = await this.client.send(
      new DetectLabelsCommand({
        Image: { Bytes: prepared },
        MaxLabels: 100,
        MinConfidence: 50,
      }),
    );

    const labels = (res.Labels ?? []).filter((l) => (l.Name ?? "").length > 0);
    if (labels.length === 0) {
      return { labels: [], confidence: 0 };
    }

    // Rekognition already returns labels sorted by confidence descending,
    // but don't rely on that ordering silently — take the max explicitly.
    const topConfidence = Math.max(...labels.map((l) => l.Confidence ?? 0));

    return {
      labels: labels.map((l) => l.Name!),
      confidence: Number((topConfidence / 100).toFixed(2)), // Rekognition is 0-100, we're 0-1
      // Kept parallel to `labels` (same filter applied above) so
      // categoryMapping can weigh each label by its OWN confidence.
      labelConfidences: labels.map((l) => Number(((l.Confidence ?? 0) / 100).toFixed(2))),
      // Rekognition's own top-level taxonomy per label — fuels the dynamic
      // category fallback in categoryMapping.ts (see ClassificationResult).
      labelTaxonomies: labels.map(
        (l) => (l.Categories ?? []).map((c) => c.Name ?? "").filter((n) => n.length > 0),
      ),
    };
  }
}

// Explicit opt-in, not inferred from AWS credentials being present — the
// same AWS account/keys are also used for S3 storage (lib/storage.ts), and
// having S3 configured shouldn't silently flip classification over to a
// real, billed API call too.
//
// Deliberately a SEPARATE region variable from S3's AWS_REGION — Rekognition
// and S3 are independent services and the S3 bucket's region has no bearing
// on which region should serve Rekognition calls (and not every Rekognition
// feature is available in every region, so pin this independently rather
// than implicitly inheriting whatever region the bucket happens to live in).
// Running under Vitest ALWAYS forces the mock, regardless of
// CLASSIFICATION_PROVIDER — the whole backend test suite (including the
// dedicated offline/no-network guard test) depends on deterministic,
// zero-cost, zero-network classification. Without this override, having
// CLASSIFICATION_PROVIDER=rekognition in a shared .env (needed for real
// local/dev testing) would silently make the test suite fire real, billed
// API calls and break every hardcoded-label assertion.
//
// Deliberately checks `process.env.VITEST` (a marker Vitest always sets
// itself, unconditionally) rather than NODE_ENV — the shared .env file also
// sets NODE_ENV=development for local dev convenience, and Vite/Vitest's own
// .env loading applies that value in a way that clobbers vitest's own
// NODE_ENV=test default, making NODE_ENV alone an unreliable test signal
// here (confirmed empirically: the NODE_ENV-based guard silently failed to
// engage and the full suite fired real Rekognition calls).
const isTestRun = Boolean(process.env.VITEST);
const provider: ClassificationProvider =
  process.env.CLASSIFICATION_PROVIDER === "rekognition" && !isTestRun
    ? new RekognitionClassificationProvider(process.env.REKOGNITION_REGION ?? "us-east-1")
    : new MockClassificationProvider();

export async function classify(imageBuffer: Buffer): Promise<ClassificationResult> {
  return provider.classify(imageBuffer);
}

/**
 * Validates a Photo.aiDetection JSON blob (Prisma's JsonValue) back into a
 * ClassificationResult. Deliberately strict about the two load-bearing
 * fields (labels must be a string array, confidence a number) and lenient
 * about the optional parallel arrays — a malformed/legacy blob (or a photo
 * classified before this column existed) simply misses the cache rather
 * than crashing a job or an API request. Shared by the worker's reclassify
 * cache-hit path and by lib/photoCard.ts's per-label confidence exposure
 * (2026-07-11, Abhishek's request to see each label's own confidence in the
 * network response).
 */
export function parseCachedDetection(value: unknown): ClassificationResult | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const blob = value as Record<string, unknown>;
  if (!Array.isArray(blob.labels) || !blob.labels.every((l) => typeof l === "string")) return null;
  if (typeof blob.confidence !== "number") return null;
  return {
    labels: blob.labels,
    confidence: blob.confidence,
    labelConfidences: Array.isArray(blob.labelConfidences)
      ? (blob.labelConfidences as number[])
      : undefined,
    labelTaxonomies: Array.isArray(blob.labelTaxonomies)
      ? (blob.labelTaxonomies as string[][])
      : undefined,
  };
}
