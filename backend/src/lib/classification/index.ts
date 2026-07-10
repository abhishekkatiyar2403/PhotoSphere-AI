import crypto from "node:crypto";
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
 * same whether storage is local MinIO or real S3) and asks for up to 15
 * labels at >=50% confidence, letting categoryMapping.ts's own
 * CONFIDENCE_THRESHOLD (60%) do the real "is this good enough" gating.
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
    const res = await this.client.send(
      new DetectLabelsCommand({
        Image: { Bytes: imageBuffer },
        MaxLabels: 15,
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
