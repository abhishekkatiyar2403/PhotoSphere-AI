"use client";

import { useState } from "react";

// Folder-card cover mosaic: a big main photo plus a stack of two smaller
// ones, scattered like tossed-in prints (each rotated a couple degrees) that
// straighten and lift on card hover. Hovering a stack thumbnail swaps it
// into the main slot while the previous main photo takes its place - the
// "scattered photo stack" + hover-swap effect described in chat1.md.
export function FolderCovers({ covers }: { covers: (string | null)[] }) {
  const [hovered, setHovered] = useState<"top" | "bottom" | null>(null);
  const [c1, c2, c3] = covers;
  const main = hovered === "top" ? c2 : hovered === "bottom" ? c3 : c1;
  const top = hovered === "top" ? c1 : c2;
  const bottom = hovered === "bottom" ? c1 : c3;

  return (
    <div className="ps2-folder-covers" onMouseLeave={() => setHovered(null)}>
      {main ? (
        <img key={main} className="ps2-folder-cover-main" src={main} alt="" />
      ) : (
        <div className="ps2-folder-cover-main" />
      )}
      <div className="ps2-folder-cover-stack">
        <div className="ps2-folder-cover-slot" onMouseEnter={() => top && setHovered("top")}>
          {top ? (
            <img key={top} className="ps2-folder-cover-small" src={top} alt="" />
          ) : (
            <div className="ps2-folder-cover-small" />
          )}
        </div>
        <div className="ps2-folder-cover-slot" onMouseEnter={() => bottom && setHovered("bottom")}>
          {bottom ? (
            <img key={bottom} className="ps2-folder-cover-small" src={bottom} alt="" />
          ) : (
            <div className="ps2-folder-cover-small" />
          )}
        </div>
      </div>
    </div>
  );
}
