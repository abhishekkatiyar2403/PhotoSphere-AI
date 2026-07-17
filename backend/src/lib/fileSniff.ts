/**
 * Minimal magic-byte content sniffer, scoped to exactly the formats this
 * spec allows (spec Open Question 1: JPEG, PNG, WebP, HEIC only). Written
 * in-house rather than pulling in `file-type` (ESM-only in its current
 * major version, awkward with this repo's CommonJS/tsx setup) since the
 * allowlist is small and fixed.
 *
 * Never trust the `Content-Type` header or file extension alone - this
 * inspects the actual bytes, per the spec's acceptance criteria (a
 * renamed .exe must be rejected even with a .jpg extension).
 */

export type AllowedMimeType = "image/jpeg" | "image/png" | "image/webp" | "image/heic";

export function sniffMimeType(buffer: Buffer): AllowedMimeType | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WebP: "RIFF"....."WEBP" (bytes 0-3 = RIFF, 8-11 = WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  // HEIC/HEIF: ISO base media file format, box at offset 4 = "ftyp",
  // followed by one of the HEIC/HEIF brand codes.
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
  }

  return null;
}
