import { describe, expect, it } from "vitest";
import { looksLikeScreenshot, SCREENSHOT_DETECTION } from "../lib/classification/screenshot";
import { mapToCategory } from "../lib/classification/categoryMapping";
import { isLowEntropyPHash, DUPLICATE_HAMMING_THRESHOLD } from "../lib/phash";

/**
 * Offline unit tests for the metadata-based screenshot detector
 * (lib/classification/screenshot.ts) and the low-entropy pHash guard —
 * both pure functions, no network, no DB. See the 2026-07-12 accuracy
 * audit: Rekognition never emits a "Screenshot" label, so this detector is
 * the ONLY route into the Screenshots category with the real provider.
 */

describe("looksLikeScreenshot", () => {
  it("detects by filename regardless of format or dimensions (macOS style)", () => {
    expect(
      looksLikeScreenshot({
        mimeType: "image/png",
        originalFilename: "Screenshot 2026-07-12 at 10.30.41.png",
        hasCameraExif: false,
        width: 1728, // laptop screenshots have arbitrary sizes — filename decides
        height: 1117,
      }),
    ).toBe(true);
  });

  it("detects Android-style Screenshot_ filenames", () => {
    expect(
      looksLikeScreenshot({
        mimeType: "image/png",
        originalFilename: "Screenshot_20260712-103041_Chrome.png",
        hasCameraExif: false,
        width: null,
        height: null,
      }),
    ).toBe(true);
  });

  it("detects a renamed PNG by exact device resolution + no camera EXIF (iPhone 14 Pro, portrait)", () => {
    expect(
      looksLikeScreenshot({
        mimeType: "image/png",
        originalFilename: "IMG_0001.png",
        hasCameraExif: false,
        width: 1179,
        height: 2556,
      }),
    ).toBe(true);
  });

  it("device resolution matches in landscape orientation too", () => {
    expect(
      looksLikeScreenshot({
        mimeType: "image/png",
        originalFilename: "whatever.png",
        hasCameraExif: false,
        width: 2556,
        height: 1179,
      }),
    ).toBe(true);
  });

  it("rejects a real camera JPEG even at device-like dimensions", () => {
    expect(
      looksLikeScreenshot({
        mimeType: "image/jpeg",
        originalFilename: "DSC_0042.JPG",
        hasCameraExif: true,
        width: 1080,
        height: 1920,
      }),
    ).toBe(false);
  });

  it("rejects a PNG that carries camera EXIF (a converted real photo)", () => {
    expect(
      looksLikeScreenshot({
        mimeType: "image/png",
        originalFilename: "converted.png",
        hasCameraExif: true,
        width: 1170,
        height: 2532,
      }),
    ).toBe(false);
  });

  it("rejects an ordinary downloaded PNG at a non-device resolution", () => {
    expect(
      looksLikeScreenshot({
        mimeType: "image/png",
        originalFilename: "logo-export.png",
        hasCameraExif: false,
        width: 800,
        height: 600,
      }),
    ).toBe(false);
  });

  it("rejects a PNG with unknown dimensions and a non-screenshot filename", () => {
    expect(
      looksLikeScreenshot({
        mimeType: "image/png",
        originalFilename: "image4.png",
        hasCameraExif: false,
        width: null,
        height: null,
      }),
    ).toBe(false);
  });

  it("the synthetic detection maps to the Screenshots category", () => {
    expect(mapToCategory({ ...SCREENSHOT_DETECTION, labels: [...SCREENSHOT_DETECTION.labels] })).toBe(
      "Screenshots",
    );
  });
});

describe("low-entropy pHash guard", () => {
  it("threshold is 6 (a dedup false-positive is a permanent classification miss)", () => {
    expect(DUPLICATE_HAMMING_THRESHOLD).toBe(6);
  });

  it("flags near-flat hashes in both directions, passes structured ones", () => {
    expect(isLowEntropyPHash("0000000000000000")).toBe(true); // fully flat
    expect(isLowEntropyPHash("0000000000000007")).toBe(true); // 3 set bits — near-flat
    expect(isLowEntropyPHash("ffffffffffffffff")).toBe(true); // inverse-flat
    expect(isLowEntropyPHash("fffffffffffffff8")).toBe(true); // 61 set bits
    expect(isLowEntropyPHash("000000000000007f")).toBe(true); // 7 set bits — just under the floor
    expect(isLowEntropyPHash("00000000000000ff")).toBe(false); // exactly 8 set bits — boundary, has enough structure
    expect(isLowEntropyPHash("a5a5a5a5a5a5a5a5")).toBe(false); // balanced structure
    expect(isLowEntropyPHash("1248124812481248")).toBe(false); // 16 set bits
  });
});
