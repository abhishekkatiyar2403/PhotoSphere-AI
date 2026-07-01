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

// Roadmap §13 step 3: "hamming distance < 10" threshold for duplicate detection.
export const DUPLICATE_HAMMING_THRESHOLD = 10;
