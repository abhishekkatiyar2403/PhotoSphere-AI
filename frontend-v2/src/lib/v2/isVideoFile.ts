import { FEATURE_FLAGS } from "@/lib/v2/featureFlags";

const VIDEO_EXT_RE = /\.(mp4|mov|webm|avi|mkv|m4v)$/i;

// Video support has no backend field (see featureFlags.ts) - today the
// upload dropzone only accepts image MIME types, so no photo will ever
// match this regardless of the flag. Detection is purely by file extension
// so it activates automatically the moment real video files exist, once
// FEATURE_FLAGS.videoPlayback is flipped on.
export function isVideoFile(filename: string): boolean {
  return FEATURE_FLAGS.videoPlayback && VIDEO_EXT_RE.test(filename);
}
