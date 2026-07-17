# Classification test fixtures (specs/ai-classification.md §3)

The mock classifier (`backend/src/lib/classification/index.ts`) deterministically
derives a label set from the file's bytes: `sha256(bytes)[0] % 7` indexes into
`MOCK_LABEL_SETS`, and confidence is `0.75 + (sha256(bytes)[1] % 20) / 100`
(always 0.75–0.94, i.e. always above the 0.60 threshold — the <0.60 path is
exercised via the worker's `FORCE_LOWCONF_` filename hook, not these bytes).

Each fixture below is a small (96x96) seeded-noise JPEG, generated and then
**verified through the real `classify()` + `mapToCategory()` code path** to
hit exactly its named label set. Noise images were chosen deliberately:
their dHashes are non-degenerate and pairwise Hamming distance >= 20, so
uploading any combination of these fixtures as the *same user* never trips
the pHash near-dup gate (duplicate threshold is distance < 10).

| Filename | Mock labels | Confidence | Expected folder |
|---|---|---|---|
| `fixture-people.jpg` | `["Person", "Outdoor"]` | 0.89 | **People** (multi-category: People beats Nature on priority) |
| `fixture-food.jpg` | `["Food", "Meal"]` | 0.83 | **Food** |
| `fixture-documents.jpg` | `["Document", "Text"]` | 0.89 | **Documents** |
| `fixture-nature.jpg` | `["Landscape", "Nature"]` | 0.79 | **Nature** (via the Open Question #2 aliases) |
| `fixture-animals.jpg` | `["Dog", "Animal"]` | 0.76 | **Animals** |
| `fixture-vehicles.jpg` | `["Car", "Truck"]` | 0.9 | **Vehicles** |
| `fixture-unmappable.jpg` | `["Abstract", "Pattern"]` | 0.94 | **Uncategorized** (no label maps to any category) |

Usage notes for Tester:

- **Labels depend only on bytes, not filename.** Renaming a copy of any
  *mappable* fixture to `FORCE_LOWCONF_<anything>.jpg` keeps its labels but
  forces stored confidence to 0.42 in the worker → lands in Uncategorized
  (threshold overrides mapping). A `FORCE_FAIL_<anything>.jpg` rename forces
  the *pipeline* job to fail (3 attempts → `failed`); the hook deliberately
  does not fire on `reclassify` jobs, enabling the failed → reclassify →
  done recovery path with the same file.
- **Byte-identical re-upload by the same user** → `duplicate` with
  `dedupMethod: "sha256"` (exact pass fires before pHash). Use a fixture the
  user hasn't already uploaded when you *don't* want a duplicate verdict.
- Regenerating: the generator lives in the MR notes (seeded noise via Sharp);
  if `MOCK_LABEL_SETS` ever changes length or order, these files and this
  table must be regenerated together.

## In-test generated companion images (not committed as files)

`classification.smoke.test.ts` builds a few more images at runtime with the
same generators; they are documented here because they share this table's
determinism contract:

| Generated in-test | Recipe | Mock labels | Expected outcome |
|---|---|---|---|
| second-food | seeded noise, seed `102` | `["Food", "Meal"]` | Food (folder-reuse test) |
| second-documents | seeded noise, seed `200` | `["Document", "Text"]` | Documents (concurrent same-new-category test) |
| flat red / flat blue | solid 64x64 JPEG, rgb(220,30,30) / rgb(30,30,220) | `["Document", "Text"]` (both: `sha256[0] % 7 == 2`) | both `done`, never pHash-deduped (degenerate-dHash guard); byte-identical re-upload of red → `duplicate` via sha256 |
| exif-tagged gray | solid 64x64 JPEG rgb(128,128,128) + sharp `withExif` IFD0 Make/Model | `["Landscape", "Nature"]` | Nature; `GET /api/photos/:id` exposes `cameraMake`/`cameraModel` |

All flat/solid images hash to the degenerate all-zeros dHash
(`DEGENERATE_PHASH`), so they can never pHash-collide with anything — they
only dedup on exact bytes. Noise seeds were verified offline to have
`sha256[0] % 7` hitting the named label set and pairwise dHash distance
>= 20 from every committed fixture (and from each other).
