"use client";

// PhotoSphere brand lockup — the orb mark is an image asset
// (/v2/logo-orb.png, transparent background, provided artwork); the
// "PhotoSphere" wordmark is REAL TEXT, not an image. That's deliberate: the
// wordmark image had "Photo" baked in near-white, which vanished on light
// theme's light background — real text uses --ps2-muted / --ps2-text, which
// flip correctly with the theme, so it stays legible in both.
//   - "login":   52px-tall orb with an accent-tinted glow, 19px wordmark.
//   - "sidebar": 46px-tall orb, no glow, 16.5px wordmark.
//
// `gradientId` is kept in the prop signature for call-site compatibility
// (unused now — it was the SVG-orb fallback's gradient id).

export function Ps2Brand({ variant }: { variant: "login" | "sidebar"; gradientId?: string }) {
  const box = variant === "login" ? 96 : 60;
  return (
    <div className={`ps2-brand ps2-brand--${variant}`}>
      <div className="ps2-brand-mark" style={{ width: box, height: box }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/v2/logo-orb-v2.png" alt="" width={box} height={box} style={{ objectFit: "contain" }} />
      </div>
      <div className="ps2-brand-word">
        <span className="ps2-brand-word-1">Photo</span>
        <span className="ps2-brand-word-2">Sphere</span>
      </div>
    </div>
  );
}
