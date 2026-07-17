import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mapToCategory } from "../lib/classification/categoryMapping";
import type { ClassificationResult } from "../lib/classification";

/**
 * Golden-set regression harness (2026-07-11, senior-review follow-up).
 *
 * Every mapping bug fixed so far (Bugs.md #13, #15, #16 mapping half, #17,
 * #18) was verified with a throwaway script and then... thrown away —
 * nothing stopped the NEXT vocabulary tweak from silently re-breaking the
 * zebra photo or re-lumping cutlery into Electronics. This suite runs the
 * full mapping (dominance scoring, per-label confidence floor, category
 * weights, taxonomy fallback) over test/fixtures/classification-golden.json
 * — real Rekognition label sets from Abhishek's actual photos, each pinned
 * to the folder it must land in — with zero API calls and zero image bytes.
 *
 * THE RULE: when a classification bug is fixed, its real detection goes
 * into the golden file in the same change. A red test here means a real,
 * previously-shipped fix has regressed — never skip it, never delete a
 * case to make it pass.
 *
 * (Pure mapping only — face-based People refinement is geometry, not
 * labels, and is exercised by the live smoke tests instead.)
 */

interface GoldenCase {
  name: string;
  labels: string[];
  confidence: number;
  labelConfidences?: number[];
  labelTaxonomies?: string[][];
  expected: string;
}

const goldenPath = path.resolve(__dirname, "../../test/fixtures/classification-golden.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as { cases: GoldenCase[] };

describe("classification golden set (every previously-fixed mapping bug, pinned)", () => {
  it("has a meaningful number of cases (the file exists and parsed)", () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(25);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const result: ClassificationResult = {
      labels: c.labels,
      confidence: c.confidence,
      labelConfidences: c.labelConfidences,
      labelTaxonomies: c.labelTaxonomies,
    };
    expect(mapToCategory(result)).toBe(c.expected);
  });
});
