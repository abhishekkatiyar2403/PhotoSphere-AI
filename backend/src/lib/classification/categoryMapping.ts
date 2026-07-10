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

// Priority = the order roadmap §13 step 5 lists the rules, PLUS "Animals"
// and the added "Architecture" category moved ABOVE "Nature" (bug fix,
// Abhishek's manual-test report: real Rekognition results routinely tag a
// lion/zebra/deer photo AND a temple/building photo with generic scenery
// labels too — "Outdoors", "Landscape", "Scenery" — since those describe the
// setting, not just the subject. With Nature ranked above Animals/
// Architecture, every one of those photos collapsed into the Nature folder
// instead of the specific-subject one. Ranking the specific-object
// categories first means a temple-with-sky-background lands in
// Architecture and a lion-in-a-field lands in Animals; Nature is now the
// catch-all for photos where scenery genuinely is the only detected
// subject (pure river/lake/mountain shots with no animal/building label).
export const CATEGORY_PRIORITY = [
  "People",
  "Animals",
  "Architecture",
  "Food",
  "Vehicles",
  "Electronics",
  "Kitchen",
  "Furniture",
  "Documents",
  "Screenshots",
  "Nature",
] as const;

export type Category = (typeof CATEGORY_PRIORITY)[number];

// Roadmap §13 step 5 table, extended with real Amazon Rekognition label
// vocabulary (the mock's tiny fixture set never exercised this — Rekognition
// returns 10-15 labels per image, mixing specific-subject labels with
// generic scene/setting labels). Keys are lowercase; matching is
// case-insensitive via normalization in mapToCategory().
export const LABEL_TO_CATEGORY: Record<string, string> = {
  // People — Rekognition emits a whole vocabulary for actual portraits
  // (Person + Adult + Male + Man + ...), while a street/beach scene with an
  // incidental passer-by typically gets just the one generic "Person" label.
  // The dominance scoring in mapToCategory() leans on that difference.
  person: "People",
  face: "People",
  people: "People",
  human: "People",
  adult: "People",
  male: "People",
  female: "People",
  man: "People",
  woman: "People",
  boy: "People",
  girl: "People",
  child: "People",
  baby: "People",
  bride: "People",
  groom: "People",
  portrait: "People",
  selfie: "People",
  // Animals (checked before Nature — see CATEGORY_PRIORITY note above)
  dog: "Animals",
  cat: "Animals",
  bird: "Animals",
  animal: "Animals",
  mammal: "Animals",
  wildlife: "Animals",
  lion: "Animals",
  bear: "Animals",
  canine: "Animals",
  pet: "Animals",
  zoo: "Animals",
  deer: "Animals",
  antelope: "Animals",
  kangaroo: "Animals",
  elk: "Animals",
  zebra: "Animals",
  horse: "Animals",
  fish: "Animals",
  shark: "Animals",
  reptile: "Animals",
  insect: "Animals",
  // Architecture / landmarks / places of worship
  architecture: "Architecture",
  building: "Architecture",
  landmark: "Architecture",
  temple: "Architecture",
  shrine: "Architecture",
  pagoda: "Architecture",
  cathedral: "Architecture",
  church: "Architecture",
  monument: "Architecture",
  tower: "Architecture",
  castle: "Architecture",
  housing: "Architecture",
  city: "Architecture",
  urban: "Architecture",
  hotel: "Architecture",
  "office building": "Architecture",
  "high rise": "Architecture",
  "apartment building": "Architecture",
  condo: "Architecture",
  skyscraper: "Architecture",
  downtown: "Architecture",
  metropolis: "Architecture",
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
  vehicle: "Vehicles",
  transportation: "Vehicles",
  automobile: "Vehicles",
  boat: "Vehicles",
  ship: "Vehicles",
  airplane: "Vehicles",
  aircraft: "Vehicles",
  train: "Vehicles",
  bus: "Vehicles",
  van: "Vehicles",
  // Electronics (2026-07-10, Abhishek's product-photo test set: phones,
  // laptops, headphones all landed in Uncategorized because none of this
  // vocabulary existed in the table despite Rekognition detecting it all at
  // 1.00 confidence)
  electronics: "Electronics",
  phone: "Electronics",
  "mobile phone": "Electronics",
  "cell phone": "Electronics",
  iphone: "Electronics",
  ipod: "Electronics",
  tablet: "Electronics",
  camera: "Electronics",
  computer: "Electronics",
  laptop: "Electronics",
  pc: "Electronics",
  "computer hardware": "Electronics",
  "computer keyboard": "Electronics",
  hardware: "Electronics",
  monitor: "Electronics",
  screen: "Electronics",
  keyboard: "Electronics",
  headphones: "Electronics",
  speaker: "Electronics",
  microphone: "Electronics",
  stereo: "Electronics",
  television: "Electronics",
  tv: "Electronics",
  "electrical device": "Electronics",
  "video gaming": "Electronics",
  // Kitchen (2026-07-10, Abhishek's utensil/furniture test: both label
  // families previously fell through to the taxonomy fallback, which lumped
  // "kitchen and dining" + "furniture and furnishings" into one "Home"
  // folder. Distinct object families deserve first-class categories.)
  cutlery: "Kitchen",
  spoon: "Kitchen",
  "wooden spoon": "Kitchen",
  fork: "Kitchen",
  knife: "Kitchen",
  "kitchen utensil": "Kitchen",
  utensil: "Kitchen",
  cookware: "Kitchen",
  pot: "Kitchen",
  pan: "Kitchen",
  "cooking pan": "Kitchen",
  "cooking pot": "Kitchen",
  cooker: "Kitchen",
  "slow cooker": "Kitchen",
  steamer: "Kitchen",
  bowl: "Kitchen",
  plate: "Kitchen",
  cup: "Kitchen",
  mug: "Kitchen",
  kettle: "Kitchen",
  appliance: "Kitchen",
  kitchen: "Kitchen",
  // Furniture
  furniture: "Furniture",
  chair: "Furniture",
  armchair: "Furniture",
  couch: "Furniture",
  sofa: "Furniture",
  table: "Furniture",
  "coffee table": "Furniture",
  "dining table": "Furniture",
  tabletop: "Furniture",
  bench: "Furniture",
  bed: "Furniture",
  "bunk bed": "Furniture",
  "infant bed": "Furniture",
  crib: "Furniture",
  mattress: "Furniture",
  cushion: "Furniture",
  ottoman: "Furniture",
  desk: "Furniture",
  cabinet: "Furniture",
  shelf: "Furniture",
  bookcase: "Furniture",
  drawer: "Furniture",
  wardrobe: "Furniture",
  "home decor": "Furniture",
  "interior design": "Furniture",
  // Documents
  passport: "Documents",
  receipt: "Documents",
  document: "Documents",
  text: "Documents",
  // Screenshots
  screenshot: "Screenshots",
  app: "Screenshots",
  ui: "Screenshots",
  // Nature (catch-all setting/scenery labels — lowest priority so a more
  // specific subject label elsewhere always wins)
  tree: "Nature",
  mountain: "Nature",
  "mountain range": "Nature",
  ocean: "Nature",
  sea: "Nature",
  flower: "Nature",
  landscape: "Nature",
  nature: "Nature",
  outdoor: "Nature",
  outdoors: "Nature",
  scenery: "Nature",
  lake: "Nature",
  river: "Nature",
  water: "Nature",
  lagoon: "Nature",
  reservoir: "Nature",
  canal: "Nature",
  pond: "Nature",
  grass: "Nature",
  grassland: "Nature",
  field: "Nature",
  meadow: "Nature",
  pasture: "Nature",
  savanna: "Nature",
  woodland: "Nature",
  vegetation: "Nature",
  wilderness: "Nature",
  countryside: "Nature",
  ranch: "Nature",
  desert: "Nature",
  horizon: "Nature",
  panoramic: "Nature",
  ripple: "Nature",
  promontory: "Nature",
  beach: "Nature",
  shoreline: "Nature",
  coast: "Nature",
  sky: "Nature",
  cloud: "Nature",
  sand: "Nature",
  snow: "Nature",
  sunset: "Nature",
  sunrise: "Nature",
  hill: "Nature",
  valley: "Nature",
  forest: "Nature",
  jungle: "Nature",
  waterfall: "Nature",
  plant: "Nature",
  "palm tree": "Nature",
};

/**
 * DYNAMIC category fallback (2026-07-10): Rekognition tags every label with
 * its own fixed ~40-entry top-level taxonomy ("Iphone" -> "Technology and
 * Computing"), which the provider now passes through as
 * ClassificationResult.labelTaxonomies. When NO label matches the curated
 * table above, the dominant taxonomy category still tells us what the photo
 * is — this map renames Rekognition's wordy taxonomy names to the short
 * folder names this app uses, and anything not listed here falls through
 * with its taxonomy name used VERBATIM as a brand-new folder name (the
 * worker's findOrCreateFolder auto-creates unknown names already). Net
 * effect: a genuinely new KIND of photo mints its own category instead of
 * dying in Uncategorized.
 */
export const TAXONOMY_TO_CATEGORY: Record<string, string> = {
  "technology and computing": "Electronics",
  "food and beverage": "Food",
  "animals and pets": "Animals",
  "buildings and architecture": "Architecture",
  "nature and outdoors": "Nature",
  "plants and flowers": "Nature",
  "weather and climate": "Nature",
  "beauty and personal care": "People",
  "person description": "People",
  "vehicles and automotive": "Vehicles",
  "text and documents": "Documents",
  "sports and fitness": "Sports",
  "hobbies and interests": "Hobbies",
  "apparel and accessories": "Fashion",
  // Granularity rule (2026-07-10, utensils-and-couches-in-one-folder bug):
  // NEVER merge two taxonomy branches into one folder name. Each branch maps
  // to its own folder — a coarse shared bucket ("Home") is exactly how
  // unrelated object families end up mixed together.
  "home and indoors": "Home",
  "furniture and furnishings": "Furniture",
  "kitchen and dining": "Kitchen",
  "tools and machinery": "Tools",
  "art and entertainment": "Art",
  "toys and gaming": "Toys",
  "medical and healthcare": "Medical",
  "education and school": "Education",
  "public safety": "Public Safety",
  "religion and festivals": "Festivals",
  "travel and adventure": "Travel",
  "music and audio": "Music",
};

/**
 * Taxonomy categories too generic to ever NAME a folder — they describe
 * image properties, not subjects, and Rekognition attaches them to nearly
 * anything. Skipped entirely during the dynamic fallback.
 */
const TAXONOMY_NOISE = new Set([
  "colors and visual compositions",
  "patterns and shapes",
  "symbols and flags",
  "actions",
  "expressions and emotions",
  "everyday objects",
]);

/**
 * A label participates in category scoring only when its OWN confidence
 * clears this bar (when per-label confidences are available — the
 * Rekognition provider supplies them; the mock doesn't, and its labels fall
 * back to the overall result confidence). Kills the "one stray 55% 'Shark'
 * label sends a river photo to Animals" class of misfile: DetectLabels is
 * asked for everything ≥50%, and its 50-75% tail is exactly where the
 * hallucinated-object labels live.
 */
export const MIN_LABEL_CONFIDENCE = 0.75;

// Dominance-scoring weights (see mapToCategory). Nature's vocabulary is
// setting/backdrop language — Rekognition attaches 5-10 of those labels to
// ANY outdoor photo regardless of subject — so a Nature label carries half
// the weight of a specific-subject label. A zebra shot still tags ~9 scenery
// labels vs ~5 animal labels; 5×2 > 9×1 keeps it in Animals, while a pure
// river/valley shot (a dozen Nature labels, no subject labels) stays Nature.
const SPECIFIC_SUBJECT_WEIGHT = 2;
const SCENERY_WEIGHT = 1;

function categoryWeight(category: string): number {
  return category === "Nature" ? SCENERY_WEIGHT : SPECIFIC_SUBJECT_WEIGHT;
}

export interface CategoryScore {
  category: string;
  score: number;
}

/**
 * Scores every category DOMINANCE-style (not first-match-wins): every
 * mappable label above MIN_LABEL_CONFIDENCE votes for its category with (its
 * confidence × its category's weight). Returns every category with a
 * nonzero score, highest first — CATEGORY_PRIORITY order is the stable-sort
 * tiebreak for equal scores (the array is built in that order, and
 * Array#sort is stable). Empty when result.confidence is below
 * CONFIDENCE_THRESHOLD, or when no label maps to any category.
 *
 * Exposed (not just mapToCategory's top pick) so the worker can re-rank when
 * the top pick, "People", turns out on closer (face-geometry) inspection not
 * to actually be about a person — see faces.ts's null-return contract.
 */
export function rankCategories(result: ClassificationResult): CategoryScore[] {
  if (result.confidence < CONFIDENCE_THRESHOLD) {
    return [];
  }

  const scores = new Map<string, number>();
  for (let i = 0; i < result.labels.length; i++) {
    const labelConfidence = result.labelConfidences?.[i] ?? result.confidence;
    if (labelConfidence < MIN_LABEL_CONFIDENCE) continue;

    const category = LABEL_TO_CATEGORY[result.labels[i].trim().toLowerCase()];
    if (!category) continue;

    scores.set(category, (scores.get(category) ?? 0) + labelConfidence * categoryWeight(category));
  }

  const curated = CATEGORY_PRIORITY.map((category) => ({ category, score: scores.get(category) ?? 0 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (curated.length > 0) return curated;

  // Dynamic fallback: nothing in the curated table matched, but Rekognition's
  // own taxonomy still knows what these labels ARE (see TAXONOMY_TO_CATEGORY).
  // Score every non-noise taxonomy category by its labels' summed confidence
  // and return the ranking — the top pick becomes a (possibly brand-new)
  // folder. Only ever reached with the real provider (the mock carries no
  // labelTaxonomies), so mock/test behavior is untouched.
  const taxonomyScores = new Map<string, number>();
  for (let i = 0; i < result.labels.length; i++) {
    const labelConfidence = result.labelConfidences?.[i] ?? result.confidence;
    if (labelConfidence < MIN_LABEL_CONFIDENCE) continue;

    for (const taxonomy of result.labelTaxonomies?.[i] ?? []) {
      const key = taxonomy.trim().toLowerCase();
      if (TAXONOMY_NOISE.has(key)) continue;
      const category = TAXONOMY_TO_CATEGORY[key] ?? taxonomy.trim();
      taxonomyScores.set(category, (taxonomyScores.get(category) ?? 0) + labelConfidence);
    }
  }

  return [...taxonomyScores.entries()]
    .map(([category, score]) => ({ category, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Maps a classification result to a folder/category name — the single top
 * pick from rankCategories(), or UNCATEGORIZED if nothing matched. See
 * rankCategories for the scoring rationale (this is a thin convenience
 * wrapper; most callers want this, the worker's People-rejection path wants
 * the full ranking).
 */
export function mapToCategory(result: ClassificationResult): string {
  return rankCategories(result)[0]?.category ?? UNCATEGORIZED;
}
