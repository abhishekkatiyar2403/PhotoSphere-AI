import type { ClassificationResult } from "./index";

/**
 * Pure label -> PhotoSphere category mapping (roadmap §13 step 5), per
 * specs/ai-classification.md §2. Deliberately a SIBLING of the provider in
 * ./index.ts, never part of it — swapping the mock for a real Google Vision
 * client later is a one-file change to index.ts and must not touch this
 * module. No dependencies beyond the ClassificationResult type.
 */

export const CONFIDENCE_THRESHOLD = 0.6;

export const UNCATEGORIZED = "Uncategorized";

// Priority = the order roadmap §13 step 5 lists the rules. A multi-label
// result spanning several categories lands in the highest-priority one
// (the rest stay as raw aiLabels — no secondary-tags table this pass).
export const CATEGORY_PRIORITY = [
  "People",
  "Nature",
  "Animals",
  "Food",
  "Vehicles",
  "Documents",
  "Screenshots",
] as const;

export type Category = (typeof CATEGORY_PRIORITY)[number];

// Roadmap §13 step 5 table verbatim, plus three Nature aliases so the
// existing mock's fixture labels (Landscape/Nature/Outdoor) exercise the
// mapping end-to-end (spec Open Question 2's default). Keys are lowercase;
// matching is case-insensitive via normalization in mapToCategory().
export const LABEL_TO_CATEGORY: Record<string, string> = {
  // People
  person: "People",
  face: "People",
  people: "People",
  // Nature
  tree: "Nature",
  mountain: "Nature",
  ocean: "Nature",
  flower: "Nature",
  landscape: "Nature", // alias (Open Question 2)
  nature: "Nature", // alias (Open Question 2)
  outdoor: "Nature", // alias (Open Question 2)
  // Animals
  dog: "Animals",
  cat: "Animals",
  bird: "Animals",
  animal: "Animals",
  // Food
  food: "Food",
  meal: "Food",
  dish: "Food",
  restaurant: "Food",
  // Vehicles
  car: "Vehicles",
  truck: "Vehicles",
  motorcycle: "Vehicles",
  bicycle: "Vehicles",
  // Documents
  passport: "Documents",
  receipt: "Documents",
  document: "Documents",
  text: "Documents",
  // Screenshots
  screenshot: "Screenshots",
  app: "Screenshots",
  ui: "Screenshots",
};

/**
 * Maps a classification result to a folder/category name.
 *
 * - confidence < CONFIDENCE_THRESHOLD (strictly less than — exactly 0.60 IS
 *   categorized) -> UNCATEGORIZED regardless of labels.
 * - no label maps to any category -> UNCATEGORIZED.
 * - otherwise, of all categories matched by any label, returns the
 *   highest-priority one per CATEGORY_PRIORITY.
 */
export function mapToCategory(result: ClassificationResult): string {
  if (result.confidence < CONFIDENCE_THRESHOLD) {
    return UNCATEGORIZED;
  }

  const matched = new Set<string>();
  for (const label of result.labels) {
    const category = LABEL_TO_CATEGORY[label.trim().toLowerCase()];
    if (category) {
      matched.add(category);
    }
  }

  for (const category of CATEGORY_PRIORITY) {
    if (matched.has(category)) {
      return category;
    }
  }

  return UNCATEGORIZED;
}
