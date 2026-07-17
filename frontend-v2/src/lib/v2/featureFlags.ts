// Backend-pending feature flags - each of these UI features is fully built
// and usable today with a local (per-browser) fallback, since the real
// backend endpoint/field doesn't exist yet. Flip a flag to `true` once the
// matching backend work ships, and the feature switches from its local
// fallback to the real API call - no other code changes needed.
export const FEATURE_FLAGS = {
  // Needs GET/POST /api/photos/:id/comments. Off: comments are stored in
  // localStorage keyed by photo id.
  comments: false,

  // Needs PATCH /api/photos/:id with a new title/filename. Off: the renamed
  // title is stored in localStorage keyed by photo id (still real,
  // survives reload, just not synced to other devices).
  photoRename: false,

  // Needs PATCH /api/photos/:id with edit params (light/contrast/color).
  // Off: sliders live-preview via CSS filter() but reset when you close the
  // viewer or move to another photo.
  photoEditorSave: false,

  // Needs the backend to accept/store real video files (today the upload
  // dropzone only accepts image/jpeg,png,webp,heic, so no photo will ever
  // match this regardless). Off: no duration badge/play button anywhere.
  videoPlayback: false,

  // Needs the backend to add gpsLat/gpsLng to the list/grid response
  // (FolderPhoto / SearchResponse) instead of only PhotoDetail. Off: Places
  // fetches photo detail one-by-one to read GPS (accepted N+1 cost for a
  // modest library size).
  placesGpsList: false,

  // Needs the backend to add takenAt/fileSize to the list/grid response.
  // Off: Browse's "Oldest first" sort fetches photo detail per item on the
  // current page (accepted N+1 cost, bounded to one page).
  sortByDateSize: false,
} as const;
