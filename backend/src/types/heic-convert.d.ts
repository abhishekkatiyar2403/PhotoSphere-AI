/**
 * heic-convert (v2.1.0) has no published types and no @types/heic-convert
 * package — this is the minimal shape actually used in worker.ts, taken
 * directly from the package's own lib.js (the `one` export, aliased as the
 * module's default export).
 */
declare module "heic-convert" {
  interface ConvertOptions {
    buffer: Buffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }

  function convert(options: ConvertOptions): Promise<ArrayBuffer>;

  export default convert;
}
