import type { ClassificationResult } from "./index";

/**
 * Pure label -> PhotoSphere category mapping (roadmap §13 step 5), per
 * specs/ai-classification.md §2. Deliberately a SIBLING of the provider in
 * ./index.ts, never part of it — swapping the mock for a real Google Vision
 * client later is a one-file change to index.ts and must not touch this
 * module. No dependencies beyond the ClassificationResult type.
 *
 * TUNED 2026-07-12 for the 95-99% real-library accuracy target, following a
 * four-agent audit (parameter sweep, Rekognition-vocabulary review, a
 * real-DB evaluation against Abhishek's own cached detections, and 23
 * hand-traced adversarial scenarios). See Bugs.md and this file's own
 * comments for the specific failure each change fixes.
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
//
// "Sports" / "Art" / "Festivals" added 2026-07-12 (adversarial audit S16,
// S18, and the vocab audit's "Sports is unreachable by construction"
// finding): all three are CURATED categories now (see LABEL_TO_CATEGORY
// below), and rankCategories only scores curated categories that appear in
// THIS array — any curated label mapped to a name missing here is silently
// dropped. Positioned by specificity, same rule as the rest of the list.
export const CATEGORY_PRIORITY = [
  "People",
  "Animals",
  "Architecture",
  "Food",
  "Sports",
  "Vehicles",
  "Electronics",
  "Kitchen",
  "Furniture",
  "Art",
  "Festivals",
  "Documents",
  "Screenshots",
  "Nature",
] as const;

export type Category = (typeof CATEGORY_PRIORITY)[number];

// Roadmap §13 step 5 table, extended with real Amazon Rekognition label
// vocabulary (the mock's tiny fixture set never exercised this — Rekognition
// returns labels sorted by confidence, and MaxLabels is now 30, see
// index.ts). Keys are lowercase; matching is case-insensitive via
// normalization in rankCategories().
//
// TWO SCORING MECHANISMS THIS TABLE RELIES ON (see rankCategories below):
// 1. BACKDROP_LABELS — a label that describes the SETTING rather than the
//    subject (city, text, restaurant...) still maps to its category here,
//    but always scores at SCENERY_WEIGHT (1) instead of SPECIFIC_SUBJECT_
//    WEIGHT (2), so it can support a real subject label without ever being
//    enough on its own to swing a photo.
// 2. TABLEWARE_LABELS — plate/bowl/cup/cutlery/etc. score at full weight
//    normally (a bare product photo of dishware genuinely IS Kitchen), but
//    drop to SCENERY_WEIGHT whenever a Food-category label ALSO fires in
//    the same photo — because on an actual plated-meal photo, tableware is
//    scenery around the food, not the subject (2026-07-11 audit finding:
//    "Food hijacked by the Kitchen tableware vocab" — a typical dinner shot
//    tags Plate/Bowl/Cutlery/Fork alongside Food/Meal/Dish, and at EQUAL
//    weight the wider tableware vocabulary always outvoted the 4-word Food
//    category it was sitting right next to).
export const LABEL_TO_CATEGORY: Record<string, string> = {
  // People — Rekognition emits a whole vocabulary for actual portraits
  // (Person + Adult + Male + Man + ...), while a street/beach scene with an
  // incidental passer-by typically gets just the one generic "Person" label.
  // The dominance scoring in rankCategories() leans on that difference.
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
  newborn: "People",
  bride: "People",
  groom: "People",
  portrait: "People",
  selfie: "People",
  // People — event/social contexts (2026-07-12 vocab audit): these are
  // strong signals a photo is ABOUT people even when Rekognition's generic
  // Person/Adult attributes are weak or absent (e.g. a wedding photo shot
  // from behind, a crowd where individual attributes aren't confident).
  // Safe to route to People because face refinement (faces.ts) then decides
  // Group vs per-person vs plain People from the actual geometry — this
  // table only needs to get the CATEGORY right, not the sub-folder.
  wedding: "People",
  "wedding gown": "People",
  party: "People",
  crowd: "People",
  audience: "People",
  dancing: "People",
  "dance pose": "People",
  family: "People",
  smile: "People",
  laughing: "People",
  kissing: "People",
  hugging: "People",
  graduation: "People",
  concert: "People",
  musician: "People",
  performer: "People",
  // Animals — see ANIMAL_SYNONYM_CLUSTERS / GENERIC_ANIMAL_LABELS below:
  // Rekognition tags one dog with Dog+Canine+Animal+Mammal+Pet all at once,
  // and without clustering those 5 near-synonyms outvote a genuine 3-4-word
  // People match on the same photo (adversarial scenario S21, "person
  // holding their dog" -> misfiled Animals). The table keeps every entry —
  // clustering happens in the scoring loop, not here.
  dog: "Animals",
  cat: "Animals",
  feline: "Animals",
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
  puppy: "Animals",
  kitten: "Animals",
  rodent: "Animals",
  rabbit: "Animals",
  hamster: "Animals",
  squirrel: "Animals",
  monkey: "Animals",
  elephant: "Animals",
  tiger: "Animals",
  leopard: "Animals",
  cheetah: "Animals",
  giraffe: "Animals",
  panda: "Animals",
  fox: "Animals",
  wolf: "Animals",
  cow: "Animals",
  cattle: "Animals",
  livestock: "Animals",
  sheep: "Animals",
  goat: "Animals",
  duck: "Animals",
  goose: "Animals",
  fowl: "Animals",
  hen: "Animals",
  parrot: "Animals",
  butterfly: "Animals",
  bee: "Animals",
  snake: "Animals",
  lizard: "Animals",
  turtle: "Animals",
  frog: "Animals",
  "sea life": "Animals",
  aquarium: "Animals",
  // Architecture / landmarks / places of worship
  architecture: "Architecture",
  building: "Architecture",
  landmark: "Architecture",
  temple: "Architecture",
  shrine: "Architecture",
  pagoda: "Architecture",
  cathedral: "Architecture",
  church: "Architecture",
  mosque: "Architecture",
  synagogue: "Architecture",
  monument: "Architecture",
  tower: "Architecture",
  castle: "Architecture",
  palace: "Architecture",
  fortress: "Architecture",
  ruins: "Architecture",
  bridge: "Architecture",
  lighthouse: "Architecture",
  fountain: "Architecture",
  dome: "Architecture",
  spire: "Architecture",
  steeple: "Architecture",
  house: "Architecture",
  villa: "Architecture",
  mansion: "Architecture",
  cottage: "Architecture",
  housing: "Architecture",
  "office building": "Architecture",
  "high rise": "Architecture",
  "apartment building": "Architecture",
  condo: "Architecture",
  skyscraper: "Architecture",
  // Architecture — pure SETTING labels (city/hotel), see BACKDROP_LABELS:
  // still Architecture-category, but scored at scenery weight so a lone
  // "City" label on a people/food photo can't win by itself.
  city: "Architecture",
  hotel: "Architecture",
  // Food
  food: "Food",
  meal: "Food",
  dish: "Food",
  restaurant: "Food",
  pizza: "Food",
  burger: "Food",
  sandwich: "Food",
  "hot dog": "Food",
  taco: "Food",
  burrito: "Food",
  bread: "Food",
  dessert: "Food",
  cake: "Food",
  "birthday cake": "Food",
  cupcake: "Food",
  "ice cream": "Food",
  chocolate: "Food",
  cookie: "Food",
  pastry: "Food",
  donut: "Food",
  croissant: "Food",
  pancake: "Food",
  waffle: "Food",
  fruit: "Food",
  apple: "Food",
  banana: "Food",
  orange: "Food",
  vegetable: "Food",
  salad: "Food",
  pasta: "Food",
  noodle: "Food",
  spaghetti: "Food",
  curry: "Food",
  soup: "Food",
  rice: "Food",
  seafood: "Food",
  sushi: "Food",
  meat: "Food",
  steak: "Food",
  bacon: "Food",
  egg: "Food",
  cheese: "Food",
  fries: "Food",
  breakfast: "Food",
  lunch: "Food",
  dinner: "Food",
  brunch: "Food",
  snack: "Food",
  platter: "Food",
  bakery: "Food",
  beverage: "Food",
  drink: "Food",
  coffee: "Food",
  "coffee cup": "Food", // deliberate: a café photo is a food-moment photo, not a Kitchen product shot
  tea: "Food",
  juice: "Food",
  wine: "Food",
  beer: "Food",
  cocktail: "Food",
  // Sports (2026-07-12, was previously UNREACHABLE — every sports photo
  // also contains a Person label, so the curated People match always fired
  // first and the taxonomy fallback [only tried when curated is EMPTY]
  // never got a chance to run). Now a first-class category: a person mid-
  // game still scores People highly too (face refinement handles that
  // correctly), but pure equipment/venue shots (a golf course, a cricket
  // bat on grass) now have somewhere real to land instead of Uncategorized.
  sport: "Sports",
  sports: "Sports",
  team: "Sports",
  "team sport": "Sports",
  football: "Sports",
  "american football": "Sports",
  soccer: "Sports",
  "soccer ball": "Sports",
  basketball: "Sports",
  baseball: "Sports",
  cricket: "Sports",
  tennis: "Sports",
  "tennis racket": "Sports",
  badminton: "Sports",
  golf: "Sports",
  "golf course": "Sports",
  volleyball: "Sports",
  rugby: "Sports",
  hockey: "Sports",
  gym: "Sports",
  fitness: "Sports",
  yoga: "Sports",
  cycling: "Sports",
  skiing: "Sports",
  snowboarding: "Sports",
  skateboard: "Sports",
  surfing: "Sports",
  swimming: "Sports",
  stadium: "Sports",
  // Vehicles
  car: "Vehicles",
  truck: "Vehicles",
  motorcycle: "Vehicles",
  bicycle: "Vehicles",
  vehicle: "Vehicles",
  transportation: "Vehicles",
  automobile: "Vehicles",
  suv: "Vehicles",
  "sports car": "Vehicles",
  "pickup truck": "Vehicles",
  convertible: "Vehicles",
  taxi: "Vehicles",
  tractor: "Vehicles",
  boat: "Vehicles",
  ship: "Vehicles",
  sailboat: "Vehicles",
  yacht: "Vehicles",
  canoe: "Vehicles",
  kayak: "Vehicles",
  ferry: "Vehicles",
  "cruise ship": "Vehicles",
  airplane: "Vehicles",
  aircraft: "Vehicles",
  helicopter: "Vehicles",
  jet: "Vehicles",
  train: "Vehicles",
  bus: "Vehicles",
  van: "Vehicles",
  scooter: "Vehicles",
  "motor scooter": "Vehicles",
  moped: "Vehicles",
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
  headphones: "Electronics",
  speaker: "Electronics",
  microphone: "Electronics",
  stereo: "Electronics",
  television: "Electronics",
  tv: "Electronics",
  "electrical device": "Electronics",
  "video gaming": "Electronics",
  "remote control": "Electronics",
  // Kitchen — appliances/cookware ONLY carry full weight unconditionally.
  // Tableware (bowl/plate/cup/mug/cutlery/spoon/fork/knife, see
  // TABLEWARE_LABELS) is scored CONDITIONALLY in rankCategories: full
  // weight when it's the only evidence (a bare product shot of dishware),
  // demoted to scenery weight whenever a Food label also fires (a plated
  // meal, where the tableware is context, not the subject).
  "kitchen utensil": "Kitchen",
  utensil: "Kitchen",
  "wooden spoon": "Kitchen",
  cookware: "Kitchen",
  pan: "Kitchen",
  "cooking pan": "Kitchen",
  "cooking pot": "Kitchen",
  cooker: "Kitchen",
  "slow cooker": "Kitchen",
  steamer: "Kitchen",
  kettle: "Kitchen",
  microwave: "Kitchen",
  oven: "Kitchen",
  refrigerator: "Kitchen",
  stove: "Kitchen",
  blender: "Kitchen",
  toaster: "Kitchen",
  "frying pan": "Kitchen",
  saucepan: "Kitchen",
  appliance: "Kitchen",
  kitchen: "Kitchen",
  bowl: "Kitchen",
  plate: "Kitchen",
  cup: "Kitchen",
  mug: "Kitchen",
  fork: "Kitchen",
  spoon: "Kitchen",
  knife: "Kitchen",
  cutlery: "Kitchen",
  // Furniture
  furniture: "Furniture",
  chair: "Furniture",
  armchair: "Furniture",
  couch: "Furniture",
  sofa: "Furniture",
  "coffee table": "Furniture",
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
  // Furniture — generic setting labels (a bare "table" fires on billiard
  // tables, workbenches, board-game nights, and every plated-meal photo
  // alongside "Dining Table" — none of that is evidence the PHOTO is about
  // furniture). See BACKDROP_LABELS: still Furniture-category so a real
  // furniture-subject photo (an empty coffee-table product shot) keeps
  // getting filed here, just never enough on its own to swing a photo that
  // has a real competing subject.
  table: "Furniture",
  "dining table": "Furniture",
  tabletop: "Furniture",
  "interior design": "Furniture",
  "home decor": "Furniture",
  // Art (2026-07-12, adversarial scenario S16: a painting of a landscape
  // was filed under Nature because "Mountain"/"Tree" leaked through the
  // frame at low confidence while the MUCH stronger Art/Painting/Canvas
  // signal had nowhere curated to go — and the taxonomy fallback that WOULD
  // have caught it never got a chance to run, since ANY nonzero curated
  // match skips the fallback entirely, see rankCategories).
  art: "Art",
  painting: "Art",
  canvas: "Art",
  "modern art": "Art",
  drawing: "Art",
  sketch: "Art",
  mural: "Art",
  // Festivals (2026-07-12, adversarial scenario S18: an indoor Christmas
  // tree filed under Nature via generic Tree/Plant labels, exactly the same
  // starved-fallback mechanism as Art above).
  "christmas tree": "Festivals",
  ornament: "Festivals",
  "christmas decorations": "Festivals",
  carnival: "Festivals",
  parade: "Festivals",
  festival: "Festivals",
  // Documents
  passport: "Documents",
  receipt: "Documents",
  document: "Documents",
  page: "Documents",
  menu: "Documents",
  "business card": "Documents",
  "id cards": "Documents",
  diploma: "Documents",
  newspaper: "Documents",
  poster: "Documents",
  advertisement: "Documents",
  handwriting: "Documents",
  "white board": "Documents",
  "qr code": "Documents",
  // Documents — "text" alone fires on street signs, storefronts, t-shirts,
  // birthday-cake icing, and book spines in the background just as often as
  // on an actual document; see BACKDROP_LABELS. The specific document
  // vocabulary above (page/menu/receipt/business card/...) carries the real
  // signal now, so bare "text" only needs to support, never decide, alone.
  text: "Documents",
  // Screenshots — Rekognition's real-world model does not reliably emit
  // "Screenshot"/"App"/"Ui" as label text (screenshots come back as
  // Text/Page/Number/Word instead, indistinguishable from a paper
  // document). These keys are kept in case a future model version changes
  // that, but reliable screenshot detection needs a pre-classification
  // metadata check (PNG mime + device-resolution pixel dimensions + no EXIF
  // camera fields) — see this file's header comment / the accuracy report
  // for why that's a separate, NOT-yet-implemented feature.
  screenshot: "Screenshots",
  app: "Screenshots",
  ui: "Screenshots",
  // Nature (catch-all setting/scenery labels — lowest priority so a more
  // specific subject label elsewhere always wins). Every entry here is
  // scored at SCENERY_WEIGHT AND additionally vote-capped (only the top
  // NATURE_VOTE_CAP highest-confidence Nature labels count at all — see
  // rankCategories) — so keeping this vocabulary broad is now safe: a pure
  // landscape photo still scores fully up to the cap, but no amount of
  // stacked scenery synonyms can out-vote a real subject elsewhere the way
  // they used to (2026-07-11 finding: the zebra golden case had only an 11%
  // score margin over Nature purely because Nature's ~50-entry vocabulary
  // out-counted Animals' ~10; the cap fixes this structurally instead of
  // relying on trimming words one at a time).
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
  glacier: "Nature",
  iceberg: "Nature",
  volcano: "Nature",
  canyon: "Nature",
  cliff: "Nature",
  cave: "Nature",
  dune: "Nature",
  stream: "Nature",
  creek: "Nature",
  rainforest: "Nature",
  swamp: "Nature",
  garden: "Nature",
  park: "Nature",
  moon: "Nature",
  rainbow: "Nature",
  "cherry blossom": "Nature",
  "potted plant": "Nature",
  waterfront: "Nature",
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
  "popular landmarks": "Architecture",
  "nature and outdoors": "Nature",
  "plants and flowers": "Nature",
  "weather and climate": "Nature",
  // Fixed 2026-07-12: this taxonomy branch is carried by product/flat-lay
  // labels (Cosmetics, Lipstick, Perfume, Skincare) that have no faces at
  // all — routing it to "People" meant every such photo wastefully ran
  // face refinement, got rejected (no face found), and bounced unstably.
  // "Fashion" (below) is the honest category for a product shot.
  "beauty and personal care": "Fashion",
  "person description": "People",
  "events and attractions": "People",
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
  // Added 2026-07-12: property/attachment categories, same class as the
  // original list — a stray rust/crack label or a toy-gun/video-game
  // screenshot should never mint a folder named after them.
  "damage detection",
  "weapons and military",
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

// Dominance-scoring weights (see rankCategories). Nature's vocabulary is
// setting/backdrop language — Rekognition attaches 5-10 of those labels to
// ANY outdoor photo regardless of subject — so a Nature label carries half
// the weight of a specific-subject label. A zebra shot still tags ~9 scenery
// labels vs ~5 animal labels; 5×2 > 9×1 keeps it in Animals, while a pure
// river/valley shot (a dozen Nature labels, no subject labels) stays Nature.
const SPECIFIC_SUBJECT_WEIGHT = 2;
const SCENERY_WEIGHT = 1;

/**
 * Labels that describe the SETTING a photo was taken in, not its subject —
 * they still map to a real category above (so a genuine subject-less
 * product/building shot of them still classifies correctly), but never
 * score at full SPECIFIC_SUBJECT_WEIGHT, so they can never single-handedly
 * outvote an actual subject label elsewhere in the same photo. Added
 * 2026-07-12 after the vocabulary audit found "City"/"Text"/"Table" etc.
 * winning photos purely by being common, not by being informative.
 */
const BACKDROP_LABELS = new Set([
  "city",
  "hotel",
  "restaurant",
  "text",
  "table",
  "dining table",
  "tabletop",
  "interior design",
  "home decor",
]);

/**
 * Tableware — full SPECIFIC_SUBJECT_WEIGHT when it's the only evidence (a
 * bare dishware product photo genuinely IS Kitchen), but demoted to
 * SCENERY_WEIGHT whenever a Food-category label ALSO fires (a plated meal —
 * tableware is context around the food, not the subject). See the
 * "conditional" pass in rankCategories. 2026-07-11/12 fix for "Food
 * hijacked by the Kitchen tableware vocab."
 */
const TABLEWARE_LABELS = new Set(["bowl", "plate", "cup", "mug", "fork", "spoon", "knife", "cutlery"]);

/**
 * Animal-vocabulary de-duplication (2026-07-12, adversarial scenario S21:
 * "person holding their dog" misfiled as Animals). Rekognition tags ONE
 * physical dog with Dog + Canine (a specific-species synonym pair) AND
 * Animal + Mammal + Pet + Wildlife (generic filler words that ride along
 * with ANY animal, regardless of species) — 5-6 near-synonym votes for one
 * subject, versus a real portrait's typical 3-4 People attribute words.
 * Each cluster below contributes ONE vote at its members' MAX confidence,
 * not a sum, so vocabulary density stops being the deciding factor.
 */
const ANIMAL_SYNONYM_CLUSTERS: Record<string, string> = {
  dog: "dog",
  canine: "dog",
  cat: "cat",
  feline: "cat",
};
const GENERIC_ANIMAL_LABELS = new Set(["animal", "mammal", "pet", "wildlife"]);
const GENERIC_ANIMAL_CLUSTER_KEY = "__generic_animal__";

/**
 * Nature vote cap (2026-07-11/12): only the top-N highest-confidence
 * Nature-mapped labels contribute to Nature's score at all — the rest are
 * discarded. Rekognition attaches 8-15 generic scenery words to almost any
 * outdoor photo; without a cap, Nature's ~90-entry vocabulary (deliberately
 * kept broad — see the table's own comment) can out-count a genuine
 * 3-5-label subject purely on volume even at half weight. Capping the VOTE
 * COUNT (not the vocabulary) means a real subject only ever has to beat a
 * bounded, fixed-size Nature score, and a pure landscape photo still scores
 * fully up to the cap.
 */
const NATURE_VOTE_CAP = 4;

export interface CategoryScore {
  category: string;
  score: number;
}

/**
 * Scores every category DOMINANCE-style (not first-match-wins): every
 * mappable label above MIN_LABEL_CONFIDENCE votes for its category with (its
 * confidence × its category's weight), subject to three refinements —
 * BACKDROP_LABELS demotion, conditional TABLEWARE_LABELS demotion, animal-
 * synonym clustering, and the Nature vote cap (see each constant's own doc
 * comment above for why). Returns every category with a nonzero score,
 * highest first — CATEGORY_PRIORITY order is the stable-sort tiebreak for
 * equal scores (the array is built in that order, and Array#sort is
 * stable). Empty when result.confidence is below CONFIDENCE_THRESHOLD, or
 * when no label maps to any category.
 *
 * Exposed (not just mapToCategory's top pick) so the worker can re-rank when
 * the top pick, "People", turns out on closer (face-geometry) inspection not
 * to actually be about a person — see faces.ts's null-return contract.
 */
export function rankCategories(result: ClassificationResult): CategoryScore[] {
  if (result.confidence < CONFIDENCE_THRESHOLD) {
    return [];
  }

  // Pass 1: does a Food label fire at all? Decides whether tableware gets
  // demoted below (a bare product shot of dishware has no Food label and
  // keeps tableware at full weight; a plated meal does, and demotes it).
  let hasFoodLabel = false;
  for (let i = 0; i < result.labels.length; i++) {
    const perLabel = result.labelConfidences?.[i];
    if (perLabel !== undefined && perLabel < MIN_LABEL_CONFIDENCE) continue;
    if (LABEL_TO_CATEGORY[result.labels[i].trim().toLowerCase()] === "Food") {
      hasFoodLabel = true;
      break;
    }
  }

  const scores = new Map<string, number>();
  const natureConfidences: number[] = [];
  const animalClusterMax = new Map<string, number>();

  for (let i = 0; i < result.labels.length; i++) {
    // The per-label floor only applies when per-label confidence is actually
    // KNOWN (real Rekognition results). Without it (the mock, legacy stored
    // results), every label would inherit the overall confidence and a
    // result in the 0.60-0.74 range would have ALL its labels rejected —
    // violating the "exactly 0.60 IS categorized" spec AC. Caught by the
    // golden-set harness on its very first run (2026-07-11).
    const perLabel = result.labelConfidences?.[i];
    if (perLabel !== undefined && perLabel < MIN_LABEL_CONFIDENCE) continue;
    const labelConfidence = perLabel ?? result.confidence;

    const normalized = result.labels[i].trim().toLowerCase();
    const category = LABEL_TO_CATEGORY[normalized];
    if (!category) continue;

    // Nature: accumulate for the vote cap instead of scoring directly.
    if (category === "Nature") {
      natureConfidences.push(labelConfidence);
      continue;
    }

    // Animals: route synonym-cluster members into the max-per-cluster map
    // instead of scoring directly.
    if (category === "Animals") {
      const clusterKey =
        ANIMAL_SYNONYM_CLUSTERS[normalized] ??
        (GENERIC_ANIMAL_LABELS.has(normalized) ? GENERIC_ANIMAL_CLUSTER_KEY : normalized);
      animalClusterMax.set(clusterKey, Math.max(animalClusterMax.get(clusterKey) ?? 0, labelConfidence));
      continue;
    }

    let weight = SPECIFIC_SUBJECT_WEIGHT;
    if (BACKDROP_LABELS.has(normalized)) {
      weight = SCENERY_WEIGHT;
    } else if (TABLEWARE_LABELS.has(normalized) && hasFoodLabel) {
      weight = SCENERY_WEIGHT;
    }

    scores.set(category, (scores.get(category) ?? 0) + labelConfidence * weight);
  }

  if (natureConfidences.length > 0) {
    const topNature = natureConfidences.sort((a, b) => b - a).slice(0, NATURE_VOTE_CAP);
    const natureScore = topNature.reduce((sum, c) => sum + c, 0) * SCENERY_WEIGHT;
    scores.set("Nature", (scores.get("Nature") ?? 0) + natureScore);
  }

  if (animalClusterMax.size > 0) {
    const animalScore = [...animalClusterMax.values()].reduce((sum, c) => sum + c, 0) * SPECIFIC_SUBJECT_WEIGHT;
    scores.set("Animals", (scores.get("Animals") ?? 0) + animalScore);
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
    // Same known-confidence-only floor as the curated pass above.
    const perLabel = result.labelConfidences?.[i];
    if (perLabel !== undefined && perLabel < MIN_LABEL_CONFIDENCE) continue;
    const labelConfidence = perLabel ?? result.confidence;

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
