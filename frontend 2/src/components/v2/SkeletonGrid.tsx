// Shimmer skeleton placeholders shown while a screen's real data is loading,
// replacing plain "Loading…" text - shared by every v2 screen with a grid or
// list layout (Browse/Organize/Search's tile grid, Activity/Trash's rows).

export function SkeletonTiles({ count = 12 }: { count?: number }) {
  return (
    <div className="ps2-browse-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ps2-skeleton ps2-skeleton-tile" />
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div className="ps2-skeleton-rows" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="ps2-skeleton ps2-skeleton-row" />
      ))}
    </div>
  );
}
