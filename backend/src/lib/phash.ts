import sharp from "sharp";

/**
 * Perceptual hash (difference hash / dHash variant) for near-duplicate
 * detection, per roadmap §13 step 3. Implemented directly on Sharp rather
 * than pulling in an extra dependency - deterministic, no native deps
 * beyond what we already use for thumbnails.
 *
 * Algorithm: shrink to a small grayscale grid, compare each pixel to its
 * right-hand neighbor, encode "brighter" as a 1 bit. Produces a 64-bit hash
 * (16 hex chars) from an 8x8 grid, which is what computeHammingDistance
 * below expects.
 */

const HASH_GRID = 8; // 8x8 -> 64 bits

export async function computePHash(imageBuffer: Buffer): Promise<string> {
  const { data } = await sharp(imageBuffer)
    .grayscale()
    .resize(HASH_GRID + 1, HASH_GRID, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let row = 0; row < HASH_GRID; row++) {
    for (let col = 0; col < HASH_GRID; col++) {
      const left = data[row * (HASH_GRID + 1) + col];
      const right = data[row * (HASH_GRID + 1) + col + 1];
      bits += left > right ? "1" : "0";
    }
  }

  // Encode the 64-bit string as hex for compact DB storage.
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two hex-encoded hashes of equal bit length. */
export function hammingDistance(hashA: string, hashB: string): number {
  if (hashA.length !== hashB.length) {
    // Mismatched hash lengths (e.g. legacy data) - treat as maximally different.
    return Math.max(hashA.length, hashB.length) * 4;
  }

  let distance = 0;
  for (let i = 0; i < hashA.length; i++) {
    const a = parseInt(hashA[i], 16);
    const b = parseInt(hashB[i], 16);
    let xor = a ^ b;
    while (xor > 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

// Near-duplicate radius on the 64-bit dHash. Roadmap §13 step 3 originally
// said "hamming distance < 10", but 9-of-64 tolerated bits (14%) is loose by
// perceptual-hashing standards and — critically — a dedup false-positive
// here is a PERMANENT classification miss (a photo flagged duplicate is
// never classified, worker hard gate). Lowered to 6 (2026-07-12 accuracy
// audit): genuine re-exports/recompressions/minor-crops of the same photo
// cluster at distance 0-4, so <6 still catches all of them, while burst-
// sequence frames, similar-but-different sunsets, and same-wall document
// shots — the real photos the old radius was swallowing — sit outside it.
export const DUPLICATE_HAMMING_THRESHOLD = 6;

// What every flat/solid-color image hashes to under this dHash (no
// left-right pixel differences anywhere in the grid -> all-zero bits),
// per Tester's 2026-07-02 methodology finding. Near-dup comparisons are
// SKIPPED whenever either side equals this value (specs/ai-classification.md
// §5) — flat images only ever dedup via the SHA-256 exact-byte pass.
export const DEGENERATE_PHASH = "0000000000000000";

/**
 * Generalizes the DEGENERATE_PHASH guard to NEAR-flat images (2026-07-12
 * accuracy audit): a hash with almost no set bits (or almost all set bits —
 * the symmetric case) means the image had nearly zero left-right gradient
 * structure — skies, sunsets, plain walls, fog. Two DIFFERENT such photos
 * trivially land within any reasonable Hamming radius of each other because
 * there's barely any signal in the hash to differ on, so near-dup
 * comparisons are skipped for them entirely (same rule as the exact
 * degenerate hash: low-texture images only ever dedup via the SHA-256
 * exact-byte pass). 8 of 64 bits = 12.5% structure minimum.
 */
export function isLowEntropyPHash(hash: string): boolean {
  let setBits = 0;
  for (let i = 0; i < hash.length; i++) {
    let nibble = parseInt(hash[i], 16);
    while (nibble > 0) {
      setBits += nibble & 1;
      nibble >>= 1;
    }
  }
  const totalBits = hash.length * 4;
  return setBits < 8 || setBits > totalBits - 8;
}
