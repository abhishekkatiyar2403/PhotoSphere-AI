import {
  RekognitionClient,
  DetectFacesCommand,
  CreateCollectionCommand,
  SearchFacesByImageCommand,
  IndexFacesCommand,
  ListFacesCommand,
} from "@aws-sdk/client-rekognition";

/**
 * Face-based refinement of the "People" category (Abhishek's request,
 * 2026-07-10): instead of one flat People folder, photos of the SAME person
 * group into their own "Person N" folder, and photos with several people go
 * to a shared "Group" folder. Uses Rekognition's face collections — one
 * collection per owner, so person-matching never crosses user boundaries
 * (same per-user scope rule as dedup).
 *
 * Folder-name protocol (this module's whole output is ONE folder name — the
 * worker's existing findOrCreateFolder/assign machinery does the rest, and
 * the folders themselves are ordinary ai_generated folders the user can
 * rename/manage like any other):
 *   - "Group"      — 2+ PROMINENT faces detected (see MIN_FACE_AREA_RATIO).
 *   - "Person N"   — exactly 1 prominent face; N is stable per real-world
 *                    person via the face collection (ExternalImageId
 *                    "person-N").
 *   - "People"     — 0 clear faces (labels said person, but e.g. a
 *                    back-of-head shot), OR any face-API failure. Graceful
 *                    fallback, never a hard error: face refinement failing
 *                    must not fail the whole classification pipeline.
 *   - null         — faces WERE found but none are prominent (e.g. a
 *                    pedestrian in the far background of a street/building
 *                    photo) — tells the caller to reject "People" entirely
 *                    and re-rank the OTHER categories the labels matched
 *                    instead (2026-07-10 bug: a street photo of Marine Drive
 *                    with a distant, incidental person landed in "Person 1"
 *                    because Rekognition tags one face with a whole cluster
 *                    of near-synonymous labels — Face/Head/Portrait/Adult/
 *                    Male/Man — outnumbering the photo's own Architecture
 *                    labels. Size, not label count, is what actually tells
 *                    "the photo is a portrait" from "a person happens to be
 *                    in frame").
 *
 * Swappable-provider pattern, same gating as lib/classification/index.ts:
 * the real Rekognition provider activates ONLY under
 * CLASSIFICATION_PROVIDER=rekognition and never under Vitest — tests and
 * mock-mode keep today's exact behavior (everything stays in "People").
 *
 * NOTE ON IAM: this needs four MORE Rekognition actions than DetectLabels:
 * rekognition:DetectFaces, rekognition:CreateCollection,
 * rekognition:SearchFacesByImage, rekognition:IndexFaces (plus
 * rekognition:ListFaces). If the policy lacks them, every call lands in the
 * catch-all fallback and photos simply stay in "People" — degraded, not
 * broken.
 */

export const GROUP_FOLDER = "Group";
export const PEOPLE_FALLBACK_FOLDER = "People";

/** Similarity bar for "this is the same person as an already-seen face". */
const FACE_MATCH_THRESHOLD = 90;

/** Only count faces Rekognition is quite sure about — a blurry maybe-face in
 * a crowd shouldn't flip a portrait into "Group". */
const MIN_FACE_CONFIDENCE = 90;

/**
 * A face must cover at least this fraction of the image's area
 * (BoundingBox.Width × BoundingBox.Height, both already 0-1 fractions of the
 * frame) to count as an intentional subject rather than an incidental
 * passer-by. 1.5% corresponds to roughly a 12%-of-width square face — a
 * clear portrait/selfie/group-shot face is typically far larger than this; a
 * pedestrian in a street/landscape photo is typically far smaller.
 */
const MIN_FACE_AREA_RATIO = 0.015;

export interface FaceRefinementProvider {
  /** Returns null to mean "reject People" (see module header). */
  refinePeopleFolder(ownerId: string, imageBuffer: Buffer): Promise<string | null>;
}

/** Mock/local default: no face analysis, everything stays in "People" —
 * byte-for-byte the pre-feature behavior, which is what the offline test
 * suite and mock classification mode expect. */
class NoopFaceProvider implements FaceRefinementProvider {
  async refinePeopleFolder(): Promise<string> {
    return PEOPLE_FALLBACK_FOLDER;
  }
}

class RekognitionFaceProvider implements FaceRefinementProvider {
  private readonly client: RekognitionClient;
  // Owners whose collection is confirmed to exist this process lifetime —
  // saves a CreateCollection round-trip per photo after the first.
  private readonly knownCollections = new Set<string>();

  constructor(region: string) {
    this.client = new RekognitionClient({ region });
  }

  private collectionId(ownerId: string): string {
    // ownerId is a UUID — already within Rekognition's [a-zA-Z0-9_.-] rules.
    return `photosphere-faces-${ownerId}`;
  }

  private async ensureCollection(ownerId: string): Promise<string> {
    const id = this.collectionId(ownerId);
    if (this.knownCollections.has(id)) return id;
    try {
      await this.client.send(new CreateCollectionCommand({ CollectionId: id }));
    } catch (err) {
      // Already existing is the steady-state, not an error.
      if ((err as { name?: string }).name !== "ResourceAlreadyExistsException") throw err;
    }
    this.knownCollections.add(id);
    return id;
  }

  /** Next unused person number: max over existing "person-N" ExternalImageIds + 1. */
  private async nextPersonNumber(collectionId: string): Promise<number> {
    let max = 0;
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListFacesCommand({ CollectionId: collectionId, NextToken: nextToken }),
      );
      for (const face of page.Faces ?? []) {
        const match = /^person-(\d+)$/.exec(face.ExternalImageId ?? "");
        if (match) max = Math.max(max, Number(match[1]));
      }
      nextToken = page.NextToken;
    } while (nextToken);
    return max + 1;
  }

  async refinePeopleFolder(ownerId: string, imageBuffer: Buffer): Promise<string | null> {
    try {
      const detect = await this.client.send(
        new DetectFacesCommand({ Image: { Bytes: imageBuffer } }),
      );
      const confidentFaces = (detect.FaceDetails ?? []).filter(
        (f) => (f.Confidence ?? 0) >= MIN_FACE_CONFIDENCE,
      );
      const faces = confidentFaces.filter((f) => {
        const box = f.BoundingBox;
        if (!box || box.Width == null || box.Height == null) return false;
        return box.Width * box.Height >= MIN_FACE_AREA_RATIO;
      });

      if (confidentFaces.length === 0) return PEOPLE_FALLBACK_FOLDER;
      // Faces exist but none are prominent enough to be the subject — reject
      // People entirely rather than defaulting to the flat "People" folder,
      // so the caller re-ranks toward what the photo is actually OF.
      if (faces.length === 0) return null;
      if (faces.length >= 2) return GROUP_FOLDER;

      // Exactly one clear face: match against everyone seen before, or
      // enroll as a brand-new person.
      const collectionId = await this.ensureCollection(ownerId);

      const search = await this.client.send(
        new SearchFacesByImageCommand({
          CollectionId: collectionId,
          Image: { Bytes: imageBuffer },
          FaceMatchThreshold: FACE_MATCH_THRESHOLD,
          MaxFaces: 1,
        }),
      );
      const matchedExternalId = search.FaceMatches?.[0]?.Face?.ExternalImageId;
      const matched = matchedExternalId ? /^person-(\d+)$/.exec(matchedExternalId) : null;
      if (matched) {
        return `Person ${matched[1]}`;
      }

      const personNumber = await this.nextPersonNumber(collectionId);
      const indexed = await this.client.send(
        new IndexFacesCommand({
          CollectionId: collectionId,
          Image: { Bytes: imageBuffer },
          ExternalImageId: `person-${personNumber}`,
          MaxFaces: 1,
          QualityFilter: "AUTO",
        }),
      );
      if ((indexed.FaceRecords ?? []).length === 0) {
        // Quality filter rejected the face — too blurry/small to ever match
        // against later. Don't mint a person number for it.
        return PEOPLE_FALLBACK_FOLDER;
      }
      return `Person ${personNumber}`;
    } catch (err) {
      // Face refinement is strictly best-effort — a missing IAM permission,
      // a Rekognition hiccup, or an image its face APIs reject must never
      // fail classification. Land in the generic folder and say why.
      // eslint-disable-next-line no-console
      console.error(`[faces] refinement failed for owner ${ownerId}, falling back to "People":`, err);
      return PEOPLE_FALLBACK_FOLDER;
    }
  }
}

// Same gating as the classification provider selection in ./index.ts —
// explicit opt-in via CLASSIFICATION_PROVIDER, and Vitest always forces the
// no-op (deterministic, zero-network tests).
const provider: FaceRefinementProvider =
  process.env.CLASSIFICATION_PROVIDER === "rekognition" && !process.env.VITEST
    ? new RekognitionFaceProvider(process.env.REKOGNITION_REGION ?? "us-east-1")
    : new NoopFaceProvider();

export async function refinePeopleFolder(ownerId: string, imageBuffer: Buffer): Promise<string | null> {
  return provider.refinePeopleFolder(ownerId, imageBuffer);
}
