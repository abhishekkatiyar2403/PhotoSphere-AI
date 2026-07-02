import crypto from "node:crypto";

/**
 * Swappable classification interface (spec Open Question 3). The mock
 * implementation below deterministically derives a label set from the
 * file's bytes so identical uploads classify identically (useful for the
 * dedup tests) without any real image content analysis. Swapping in a real
 * Google Vision client later is a one-file change - callers (the worker)
 * only depend on this module's `classify()` export, never a concrete
 * provider.
 *
 * No real network call happens here, ever, until Abhishek explicitly wires
 * in real Vision API credentials (CLAUDE.md ground rule).
 */

export interface ClassificationResult {
  labels: string[];
  confidence: number;
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

const provider: ClassificationProvider = new MockClassificationProvider();

export async function classify(imageBuffer: Buffer): Promise<ClassificationResult> {
  return provider.classify(imageBuffer);
}
