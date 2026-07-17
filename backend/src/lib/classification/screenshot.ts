/**
 * Metadata-based screenshot detection (2026-07-12 accuracy audit, ranked
 * follow-up #1): Rekognition's real label model does NOT emit
 * "Screenshot"/"App"/"Ui" as label text — an actual screenshot comes back
 * described by its CONTENT (Text/Page/Number for a chat, Nature/Beach for a
 * screenshot of a beach photo), which makes the Screenshots category
 * unreachable by any label-table fix and misfiles what is typically 10-30%
 * of a real phone library into Documents/Nature/whatever-the-pixels-show.
 *
 * Screenshots are, however, trivially identifiable from METADATA, before
 * ever calling a vision API (which also saves the DetectLabels spend):
 *   1. FILENAME: every major OS names screenshots recognizably
 *      ("Screenshot 2026-07-12 at 10.30.41.png" on macOS,
 *      "Screenshot_20260712-103041.png" on Android, "Screenshot (4).png" on
 *      Windows, "Screen Recording..."-adjacent "Screen Shot" on older
 *      macOS). Filename alone is decisive — no real camera ever produces
 *      these names.
 *   2. PNG + NO CAMERA EXIF + EXACT DEVICE-SCREEN DIMENSIONS: phone
 *      screenshots are PNGs whose pixel dimensions exactly equal the
 *      device's screen resolution, and carry no camera Make/Model/DateTime
 *      EXIF (cameras write all three; screenshot pipelines write none). The
 *      resolution list is exact-match on purpose — a random downloaded/
 *      exported PNG (design mockups, logos, web images) essentially never
 *      lands on a device resolution by accident, which keeps false
 *      positives near zero at the cost of missing screenshots from devices
 *      not in the list (those still classify by content, i.e. today's
 *      behavior — the fallback is the status quo, never worse).
 *
 * Pure function, no I/O — the worker supplies the signals (it already has
 * the buffer, mime, filename, and freshly-extracted EXIF in hand).
 */

export const SCREENSHOT_FILENAME_PATTERN = /screen[\s_-]?shot|screen[\s_-]?capture|screencap/i;

// Exact device screen resolutions, normalized as [smaller, larger] (so one
// entry covers both orientations). iPhone (SE through 16 Pro Max), iPad,
// and the common Android panel resolutions. Extending this list is cheap
// and safe — exact match only ever ADDS detections.
const DEVICE_SCREEN_RESOLUTIONS = new Set(
  [
    // iPhone
    [640, 1136],
    [750, 1334],
    [828, 1792],
    [1080, 1920],
    [1125, 2436],
    [1170, 2532],
    [1179, 2556],
    [1206, 2622],
    [1242, 2208],
    [1242, 2688],
    [1284, 2778],
    [1290, 2796],
    [1320, 2868],
    // iPad
    [1536, 2048],
    [1620, 2160],
    [1640, 2360],
    [1668, 2224],
    [1668, 2388],
    [2048, 2732],
    [1488, 2266],
    // Android (common panels)
    [720, 1280],
    [720, 1520],
    [720, 1600],
    [1080, 2160],
    [1080, 2220],
    [1080, 2280],
    [1080, 2340],
    [1080, 2400],
    [1080, 2408],
    [1080, 2412],
    [1220, 2712],
    [1264, 2780],
    [1344, 2992],
    [1440, 2560],
    [1440, 2960],
    [1440, 3040],
    [1440, 3088],
    [1440, 3120],
    [1440, 3200],
  ].map(([a, b]) => `${a}x${b}`),
);

export interface ScreenshotSignals {
  mimeType: string;
  originalFilename: string;
  /** True when ANY camera EXIF is present (Make, Model, or DateTimeOriginal)
   * — cameras write these, screenshot pipelines never do. */
  hasCameraExif: boolean;
  /** Pixel dimensions; omit/null when unknown (filename rule still applies). */
  width?: number | null;
  height?: number | null;
}

export function looksLikeScreenshot(signals: ScreenshotSignals): boolean {
  if (SCREENSHOT_FILENAME_PATTERN.test(signals.originalFilename)) {
    return true;
  }

  if (signals.mimeType !== "image/png") return false;
  if (signals.hasCameraExif) return false;
  if (signals.width == null || signals.height == null) return false;

  const key =
    signals.width <= signals.height
      ? `${signals.width}x${signals.height}`
      : `${signals.height}x${signals.width}`;
  return DEVICE_SCREEN_RESOLUTIONS.has(key);
}

/**
 * The synthetic detection a screenshot short-circuits to — "Screenshot" is
 * in LABEL_TO_CATEGORY, so it flows through the exact same mapping/
 * assignment/caching machinery as a real Rekognition result (including the
 * aiDetection cache, which makes the verdict durable across reclassifies
 * without re-checking metadata). Frozen so no caller can mutate the shared
 * instance.
 */
export const SCREENSHOT_DETECTION = Object.freeze({
  labels: ["Screenshot"],
  confidence: 1,
  labelConfidences: [1],
});
