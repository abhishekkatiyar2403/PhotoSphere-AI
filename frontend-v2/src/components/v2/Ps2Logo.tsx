// The "ringed sphere" mark from the PhotoSphere redesign - an orbit ring
// passing behind and in front of a gradient sphere. `gradientId` must be
// unique per instance since multiple logos can be on screen at once (sidebar,
// mobile top bar, splash) and SVG gradient ids are global to the document.
export function Ps2Logo({ size = 32, gradientId }: { size?: number; gradientId: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--ps2-accent)" />
          <stop offset="100%" stopColor="var(--ps2-purple)" />
        </linearGradient>
      </defs>
      <path
        d="M4 20 A14 5.5 0 0 1 32 20"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.8"
        fill="none"
        opacity=".35"
        strokeLinecap="round"
        transform="rotate(-14 18 20)"
      />
      <circle cx="18" cy="16" r="9.5" fill={`url(#${gradientId})`} />
      <path
        d="M12.5 11.5a8 8 0 0 1 9.5-1.8"
        stroke="rgba(255,255,255,.55)"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M4 20 A14 5.5 0 0 0 32 20"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
        transform="rotate(-14 18 20)"
      />
    </svg>
  );
}
