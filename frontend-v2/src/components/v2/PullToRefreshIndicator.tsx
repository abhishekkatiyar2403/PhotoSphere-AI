"use client";

import { Ps2Logo } from "./Ps2Logo";

export function PullToRefreshIndicator({ pullY, refreshing }: { pullY: number; refreshing: boolean }) {
  if (pullY === 0 && !refreshing) return null;
  const progress = Math.min(1, pullY / 64);
  return (
    <div className="ps2-ptr-indicator" style={{ top: (refreshing ? 40 : pullY) - 40, opacity: refreshing ? 1 : progress }}>
      <div style={refreshing ? { animation: "ps2Spin 1s linear infinite" } : { transform: `rotate(${progress * 360}deg)` }}>
        <Ps2Logo size={22} gradientId="ps2LogoPtr" />
      </div>
    </div>
  );
}
