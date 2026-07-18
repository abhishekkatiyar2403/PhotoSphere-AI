import {
  RekognitionClient,
  DetectFacesCommand,
  CreateCollectionCommand,
  DeleteCollectionCommand,
  SearchFacesByImageCommand,
  IndexFacesCommand,
} from "@aws-sdk/client-rekognition";
import { prepareForRekognition } from "./index";
import { logger } from "../logger";

/**
 * Face-based refinement of the "People" category (Abhishek's request,
 * 2026-07-10): instead of one flat People folder, photos of the SAME person
 * group into their own per-person folder, and photos with several people go
 * to a shared "Group" folder. Uses Rekognition's face collections — one
 * collection per owner, so person-matching never crosses user boundaries
 * (same per-user scope rule as dedup).
 *
 * REFACTORED (2026-07-11, renameable-Person-folders): this module no longer
 * returns a folder NAME — it returns a structured FaceVerdict, and the
 * WORKER resolves it to a folder. Person identity is carried by the
 * Rekognition FaceId, which the worker maps to a folder row via the new
 * person_faces table (see schema.prisma) — so renaming "Person 1" to "Mom"
 * keeps that person's future photos filing into "Mom". Under the old
 * name-convention scheme a rename silently broke the link and re-minted
 * "Person N".
 *
 * Verdicts:
 *   - { kind: "group" }    — 2+ PROMINENT faces (see MIN_FACE_AREA_RATIO), OR
 *                            5+ confident faces regardless of prominence
 *                            (LARGE_GROUP_FACE_COUNT — a big wedding/team
 *                            photo where every individual face is small).
 *   - { kind: "person" }   — exactly 1 prominent face, carrying the matched
 *                            or newly-indexed collection FaceId.
 *   - { kind: "reject" }   — faces exist but none prominent (incidental
 *                            passer-by): the photo is NOT a People photo;
 *                            the worker re-ranks its other categories.
 *   - { kind: "fallback" } — no clear face at all (back-of-head shot),
 *                            unindexable face quality, any face-API failure,
 *                            or the no-op provider: plain "People" folder,
 *                            exactly the pre-feature behavior. Never a hard
 *                            error — face refinement failing must not fail
 *                            the classification pipeline.
 *
 * Swappable-provider pattern, same gating as lib/classification/index.ts:
 * the real Rekognition provider activates ONLY under
 * CLASSIFICATION_PROVIDER=rekognition and never under Vitest.
 *
 * NOTE ON IAM: needs rekognition:DetectFaces, CreateCollection,
 * SearchFacesByImage, IndexFaces beyond DetectLabels. Missing permissions
 * land every call in the fallback verdict — degraded, not broken.
 * (ListFaces is no longer needed — person numbering now comes from the
 * person_faces table, not from enumerating the collection.)
 */

export const GROUP_FOLDER = "Group";
export const PEOPLE_FALLBACK_FOLDER = "People";

export type FaceVerdict =
  | { kind: "group" }
  | { kind: "person"; faceId: string }
  | { kind: "reject" }
  | { kind: "fallback" };

/**
 * Similarity bar for "this is the same person as an already-seen face".
 * Lowered from 90 to 85 (2026-07-12 parameter audit): identity here is
 * strictly 1-face-per-registry-row (see resolvePersonFolder in worker.ts) —
 * there's no growing multi-exemplar set per person, just a single reference
 * photo each new face is compared against. At 90, ordinary lighting/angle/
 * age variation across a real person's photos routinely scores 82-89 —
 * a MISS, which mints a brand-new "Person N" folder for the same real
 * person instead of matching them, fragmenting one person across several
 * folders (worst case found live: infant/child faces, which change fast
 * enough that month-apart photos frequently fail to match even at 85). 85
 * is AWS's own commonly-cited threshold for personal-library-scale
 * matching; the false-merge risk (two DIFFERENT similar-looking people
 * merging into one folder) is low outside of twins/close relatives and is
 * the right side to err on for the "count IS the point" per-person folder
 * feature — a wrongly-merged folder is a one-click split away from fixed,
 * where a fragmented person is invisible sprawl across silently-numbered
 * folders. NOT lab-testable (this only matters against live AWS face
 * similarity, no golden-set equivalent exists) — worth re-verifying by eye
 * against your own library before and after.
 */
const FACE_MATCH_THRESHOLD = 85;

/** Only count faces Rekognition is quite sure about — a blurry maybe-face in
 * a crowd shouldn't flip a portrait into "Group". */
const MIN_FACE_CONFIDENCE = 90;

/**
 * A photo with this many CONFIDENT faces is unambiguously a group photo
 * (a wedding, a team photo, a family reunion) even when every individual
 * face is too small to pass the per-face MIN_FACE_AREA_RATIO/HEIGHT_RATIO
 * prominence gate below — a 15-person group shot naturally has small
 * per-face area, but 15 confident faces is itself overwhelming evidence
 * this is a group photo, not an accident. Checked BEFORE the prominence
 * gate (2026-07-12 audit: "large group photos... land in flat People, not
 * Group" — this closes that gap without loosening the gate that correctly
 * rejects a single tiny incidental passer-by, since a lone background face
 * never reaches 5 confident faces on its own).
 */
const LARGE_GROUP_FACE_COUNT = 5;

/**
 * A face counts as PROMINENT (an intentional subject, not an incidental
 * passer-by) when EITHER geometry test passes:
 *  - area (BoundingBox.Width × Height, both 0-1 frame fractions) ≥ 1.5% —
 *    head-and-shoulders portraits, selfies, group shots; OR
 *  - face HEIGHT ≥ 6% of frame height — catches FULL-BODY portraits, where
 *    the face is naturally ~1/8 of the subject's height and its AREA lands
 *    well under 1.5% despite the person filling the frame (found live
 *    2026-07-11: a full-body walking shot got rejected by the area-only
 *    gate and fell through to Electronics via the subject's own
 *    headphones — its real measured face height was 0.0799, which also
 *    informed picking 6% over a rounder 8%). An incidental pedestrian at
 *    20-30% of frame height has a face height of only 2-4% — still
 *    correctly rejected by both tests. Note this gate only ever runs when
 *    People already TOPPED the label ranking, so the failure mode of a
 *    looser threshold is mild (a People photo sorting per-person instead
 *    of staying in the flat folder).
 */
const MIN_FACE_AREA_RATIO = 0.015;
const MIN_FACE_HEIGHT_RATIO = 0.06;

export interface FaceRefinementProvider {
  refinePeople(ownerId: string, imageBuffer: Buffer): Promise<FaceVerdict>;
  /**
   * Permanently deletes the owner's entire face collection (2026-07-13
   * backend audit #4, account deletion): CreateCollectionCommand was called
   * for every owner enrolled into face grouping, but nothing ever called its
   * counterpart — deleting a User row (even via the DB's own cascades)
   * would leave that owner's face data orphaned in Rekognition forever.
   * Best-effort by design (matches lib/purge.ts's S3-cleanup posture): a
   * missing collection (never enrolled, or already deleted) is a no-op
   * success, not an error.
   */
  deleteCollection(ownerId: string): Promise<void>;
}

/** Mock/local default: no face analysis, everything stays in "People" —
 * byte-for-byte the pre-feature behavior, which is what the offline test
 * suite and mock classification mode expect. */
class NoopFaceProvider implements FaceRefinementProvider {
  async refinePeople(): Promise<FaceVerdict> {
    return { kind: "fallback" };
  }
  async deleteCollection(): Promise<void> {
    // No collection was ever created — nothing to delete.
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

  async deleteCollection(ownerId: string): Promise<void> {
    const id = this.collectionId(ownerId);
    try {
      await this.client.send(new DeleteCollectionCommand({ CollectionId: id }));
    } catch (err) {
      // "Never enrolled" (no collection was ever created) is a no-op
      // success, same posture as lib/storage.ts's deleteObject on an
      // already-gone key. Any OTHER failure is logged, never thrown —
      // this is best-effort cleanup and must never block account deletion
      // (matches lib/purge.ts's S3-cleanup posture exactly).
      if ((err as { name?: string }).name !== "ResourceNotFoundException") {
        logger.error({ err, ownerId }, "failed to delete face collection");
      }
    }
    this.knownCollections.delete(id);
  }

  async refinePeople(ownerId: string, imageBuffer: Buffer): Promise<FaceVerdict> {
    try {
      // Shared prepared buffer across every Rekognition call this photo
      // needs (DetectFaces, and possibly SearchFacesByImage/IndexFaces
      // below) — same 5MB-limit reliability fix as classify() in ./index.ts.
      const prepared = await prepareForRekognition(imageBuffer);

      const detect = await this.client.send(
        new DetectFacesCommand({ Image: { Bytes: prepared } }),
      );
      const confidentFaces = (detect.FaceDetails ?? []).filter(
        (f) => (f.Confidence ?? 0) >= MIN_FACE_CONFIDENCE,
      );
      const prominentFaces = confidentFaces.filter((f) => {
        const box = f.BoundingBox;
        if (!box || box.Width == null || box.Height == null) return false;
        return (
          box.Width * box.Height >= MIN_FACE_AREA_RATIO || box.Height >= MIN_FACE_HEIGHT_RATIO
        );
      });

      if (confidentFaces.length === 0) return { kind: "fallback" };
      // A large enough face COUNT is itself proof of a group photo, even if
      // every individual face is too small to pass the prominence gate.
      if (confidentFaces.length >= LARGE_GROUP_FACE_COUNT) return { kind: "group" };
      // Faces exist but none are prominent enough to be the subject — this
      // isn't a People photo at all (incidental passer-by, Bugs.md #16).
      if (prominentFaces.length === 0) return { kind: "reject" };
      if (prominentFaces.length >= 2) return { kind: "group" };

      // Exactly one prominent face: match against everyone seen before, or
      // enroll as a brand-new face. Either way the verdict carries the
      // collection FaceId — person→folder resolution is the worker's job.
      const collectionId = await this.ensureCollection(ownerId);

      // QualityFilter AUTO (2026-07-18 parameter pass): SearchFacesByImage's
      // DEFAULT quality filter is NONE — unlike IndexFaces below, whose AUTO
      // bar this codebase already relies on ("too blurry to ever match
      // against later — don't enroll"). Without it, a query face too
      // low-quality to ENROLL could still be MATCHED against the registry,
      // and low-quality query faces are exactly where spurious ≥85-similarity
      // matches come from (AWS's own guidance is to quality-filter searches)
      // — a wrong match files the photo into the WRONG person's folder, the
      // one invisible failure mode in this feature. Filtering the query face
      // can't fragment anyone (no new Person is minted on the fallback path);
      // the photo just stays in flat "People", the same terminal state the
      // IndexFaces AUTO rejection below would have produced anyway. When the
      // filter rejects every face, Rekognition signals it as
      // InvalidParameterException ("no faces detected") — an expected
      // outcome here, not an error, so it's handled locally as a quiet
      // fallback instead of tripping the outer catch's error log.
      let matchedFaceId: string | undefined;
      try {
        const search = await this.client.send(
          new SearchFacesByImageCommand({
            CollectionId: collectionId,
            Image: { Bytes: prepared },
            FaceMatchThreshold: FACE_MATCH_THRESHOLD,
            MaxFaces: 1,
            QualityFilter: "AUTO",
          }),
        );
        matchedFaceId = search.FaceMatches?.[0]?.Face?.FaceId;
      } catch (err) {
        if ((err as { name?: string }).name !== "InvalidParameterException") throw err;
        return { kind: "fallback" };
      }
      if (matchedFaceId) {
        return { kind: "person", faceId: matchedFaceId };
      }

      const indexed = await this.client.send(
        new IndexFacesCommand({
          CollectionId: collectionId,
          Image: { Bytes: prepared },
          MaxFaces: 1,
          QualityFilter: "AUTO",
        }),
      );
      const newFaceId = indexed.FaceRecords?.[0]?.Face?.FaceId;
      if (!newFaceId) {
        // Quality filter rejected the face — too blurry/small to ever match
        // against later. Don't enroll a person for it.
        return { kind: "fallback" };
      }
      return { kind: "person", faceId: newFaceId };
    } catch (err) {
      // Face refinement is strictly best-effort — a missing IAM permission,
      // a Rekognition hiccup, or an image its face APIs reject must never
      // fail classification. Land in the generic folder and say why.
      logger.error({ err, ownerId }, 'face refinement failed, falling back to "People"');
      return { kind: "fallback" };
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

export async function refinePeople(ownerId: string, imageBuffer: Buffer): Promise<FaceVerdict> {
  return provider.refinePeople(ownerId, imageBuffer);
}

export async function deleteFaceCollection(ownerId: string): Promise<void> {
  return provider.deleteCollection(ownerId);
}
