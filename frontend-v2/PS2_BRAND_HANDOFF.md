# PhotoSphere brand (logo + wordmark + star field) — apply to another frontend

This documents exactly what was changed in this `frontend-v2` app to render the
PhotoSphere brand lockup (orb image + real "PhotoSphere" text + a hand-placed
star field), so the same result can be reproduced in another copy of the app.

## Prerequisite (check this first)

The target app must already have a `.ps2`-scoped design-token system with
these custom properties defined (dark default, overridden under
`.ps2[data-theme="light"]`):

- `--ps2-text`, `--ps2-muted`
- `--ps2-accent`, `--ps2-purple`

If the target app uses different token names, substitute them everywhere
below. If it has no such token system at all, this whole approach (Photo/black
in light, Sphere gradient in both themes) needs those tokens to exist first.

## 1. The asset — one PNG, transparent background

Only **one** image file is needed: the glowing "ringed sphere" orb, with a
**real alpha channel** (not just visually see-through — an actual PNG alpha
channel, verified with `sips -g hasAlpha` or `file`'s color-type byte).

**If the other project is on this same machine**, just copy the file:

```bash
cp "/Users/akatiyar/Claude/Projects/PhotoSphere AI/frontend-v2/public/v2/logo-orb.png" \
   "<TARGET_APP>/public/v2/logo-orb.png"
```

**If it's a different machine / you only have the original flat artwork**
(orb on a plain near-white background, no real transparency), regenerate it
with this recipe (needs the `sharp` npm package — check `node_modules/sharp`
in the target repo or a sibling package, or `npm i sharp` in a scratch dir):

```js
const sharp = require('sharp');
(async () => {
  const src = sharp('logo-source.png'); // the flat orb-on-white artwork
  const { width, height } = await src.metadata();
  const { data } = await src.raw().toBuffer({ resolveWithObject: true }); // RGB, 3 channels
  const out = Buffer.alloc(width * height * 4);
  const HI = 236, LO = 205; // tune per source: fully transparent above HI luminance,
                            // fully opaque below LO, linear feather between
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const lum = (r + g + b) / 3;
    let alpha;
    if (lum >= HI) alpha = 0;
    else if (lum <= LO) alpha = 255;
    else alpha = Math.round(255 * (HI - lum) / (HI - LO));
    out[j] = r; out[j+1] = g; out[j+2] = b; out[j+3] = alpha;
  }
  await sharp(out, { raw: { width, height, channels: 4 } }).png().toFile('logo-orb.png');
})();
```

Before trusting the threshold, histogram the source image's luminance to find
where the real background band sits vs. the object's content — the source
used here had background at luminance 240–255 and all real content below 240,
so `HI=236/LO=205` cut cleanly. A different source may need different numbers.
**Verify the result** by compositing it onto a dark rectangle (`sharp .composite()`
onto a `background:'#0a0b10'` canvas) and viewing the output — a leftover faint
checkerboard/box means the threshold didn't fully clear the background.

Place the file at: **`public/v2/logo-orb.png`** in the target app.

## 2. The component

Create/replace the brand component (adjust the import path if the target
app's component tree differs):

`src/components/v2/Ps2Brand.tsx`:

```tsx
"use client";

// PhotoSphere brand lockup — the orb mark is an image asset
// (/v2/logo-orb.png, transparent background, provided artwork); the
// "PhotoSphere" wordmark is REAL TEXT, not an image. That's deliberate: a
// wordmark-as-image had "Photo" baked in near-white, which vanished on light
// theme's light background — real text uses --ps2-muted / --ps2-text, which
// flip correctly with the theme, so it stays legible in both.
//   - "login":   52px-tall orb with an accent-tinted glow, 19px wordmark.
//   - "sidebar": 46px-tall orb, no glow, 16.5px wordmark.
//
// `gradientId` is kept in the prop signature for call-site compatibility
// (unused now — it was an earlier SVG-orb fallback's gradient id; drop it
// from the prop type and call sites if nothing else references it).

export function Ps2Brand({ variant }: { variant: "login" | "sidebar"; gradientId?: string }) {
  const box = variant === "login" ? 52 : 46;
  return (
    <div className={`ps2-brand ps2-brand--${variant}`}>
      <div className="ps2-brand-mark" style={{ width: box, height: box }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/v2/logo-orb.png" alt="" width={box} height={box} style={{ objectFit: "contain" }} />
      </div>
      <div className="ps2-brand-word">
        <span className="ps2-brand-word-1">Photo</span>
        <span className="ps2-brand-word-2">Sphere</span>
      </div>
    </div>
  );
}
```

Call sites (login form panel, sidebar) should look like:

```tsx
<Ps2Brand variant="login" gradientId="ps2LogoAuthForm" />
<Ps2Brand variant="sidebar" gradientId="ps2LogoSidebar" />
```

Both must render **inside an element carrying the `.ps2` class** (that's where
the design tokens live) — if the call site isn't already inside one, wrap it.

## 3. The CSS — add to the target app's global stylesheet

Add this whole block (it's self-contained — no other rules depend on it
besides the prerequisite tokens above):

```css
/* ---- Brand lockup (Ps2Brand): logo mark + star field + two-weight wordmark ---- */

.ps2-brand {
  position: relative;
  display: flex;
  align-items: center;
}
.ps2-brand--login {
  gap: 12px;
  padding: 10px 16px;
  margin-bottom: 36px;
  animation: ps2Up 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) both 0.15s;
  /* Hand-placed, non-tiling star field — 6 dots, fixed px size, %-based
     position, white at varying opacity, transparent 60% falloff. No animation. */
  background-image:
    radial-gradient(1.4px 1.4px at 8% 15%, rgba(255, 255, 255, 0.9) 0, transparent 60%),
    radial-gradient(1.2px 1.2px at 90% 20%, rgba(255, 255, 255, 0.7) 0, transparent 60%),
    radial-gradient(1.6px 1.6px at 60% 85%, rgba(255, 255, 255, 0.8) 0, transparent 60%),
    radial-gradient(1.1px 1.1px at 30% 90%, rgba(255, 255, 255, 0.6) 0, transparent 60%),
    radial-gradient(1px 1px at 75% 55%, rgba(255, 255, 255, 0.5) 0, transparent 60%),
    radial-gradient(1.3px 1.3px at 15% 55%, rgba(255, 255, 255, 0.7) 0, transparent 60%);
}
.ps2-brand--sidebar {
  gap: 6px;
  padding: 8px 10px;
  margin-bottom: 30px;
  /* Denser 8-dot star field, same hand-placed convention as the login row. */
  background-image:
    radial-gradient(1.6px 1.6px at 6% 15%, rgba(255, 255, 255, 0.95) 0, transparent 60%),
    radial-gradient(1.3px 1.3px at 92% 20%, rgba(255, 255, 255, 0.75) 0, transparent 60%),
    radial-gradient(1.8px 1.8px at 55% 85%, rgba(255, 255, 255, 0.9) 0, transparent 60%),
    radial-gradient(1.2px 1.2px at 28% 90%, rgba(255, 255, 255, 0.65) 0, transparent 60%),
    radial-gradient(1.1px 1.1px at 78% 60%, rgba(255, 255, 255, 0.55) 0, transparent 60%),
    radial-gradient(1.4px 1.4px at 15% 55%, rgba(255, 255, 255, 0.75) 0, transparent 60%),
    radial-gradient(1px 1px at 45% 10%, rgba(255, 255, 255, 0.5) 0, transparent 60%),
    radial-gradient(1.3px 1.3px at 98% 80%, rgba(255, 255, 255, 0.6) 0, transparent 60%);
}
@media (max-width: 760px) {
  .ps2-brand--login {
    display: none;
  }
}

.ps2-brand-mark {
  display: grid;
  place-items: center;
  flex: none;
  position: relative;
  z-index: 1;
}
/* Accent-tinted glow only on the login mark, not the sidebar. */
.ps2-brand--login .ps2-brand-mark {
  filter: drop-shadow(0 6px 16px color-mix(in oklab, var(--ps2-accent) 45%, transparent));
}

.ps2-brand-word {
  position: relative;
  z-index: 1;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.ps2-brand--login .ps2-brand-word {
  font-size: 19px;
}
.ps2-brand--sidebar .ps2-brand-word {
  font-size: 16.5px;
}
/* "Photo" — near-white in dark theme (fixed, matches the reference artwork,
   not a muted-gray token); flips to black in light theme so it stays legible
   on the light panel. */
.ps2-brand-word-1 {
  font-weight: 400;
  color: #f4f5f8;
}
.ps2[data-theme="light"] .ps2-brand-word-1 {
  color: #000000;
}
/* "Sphere" — the same purple-to-blue gradient in both themes (matches the
   orb mark's own gradient tokens), never inverted by theme. */
.ps2-brand-word-2 {
  font-weight: 800;
  background: linear-gradient(90deg, var(--ps2-purple), var(--ps2-accent));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
```

If the target app doesn't already define `@keyframes ps2Up` (a simple
fade+rise entrance: `from { opacity:0; transform:translateY(18px) } to { opacity:1; transform:none }`),
add it too, or drop the `animation:` line from `.ps2-brand--login`.

## 4. Verify

1. `npx tsc --noEmit` — should be clean.
2. Load the login page and the post-login sidebar in a browser.
3. **Dark theme**: orb renders with no visible box/rectangle behind it;
   "Photo" is white, "Sphere" is a purple→blue gradient; a handful of faint
   star dots are visible scattered around the logo row.
4. **Light theme** (toggle however the app switches `data-theme` on the `.ps2`
   element — here it's `localStorage.ps2_theme = 'light'` + reload): "Photo"
   is now black and legible against the light background; "Sphere" keeps the
   *same* gradient colors (unchanged by theme).

## What NOT to carry over

- `logo-word.png` / any "wordmark as one image" file — not used. The final
  version renders "PhotoSphere" as real `<span>` text specifically so it
  adapts to light/dark theme; a baked-image wordmark can't do that (this was
  tried and reverted for exactly that reason).
- Any earlier "star field as a separate `::before`/absolute div" approach —
  the final version applies the star-field `background-image` directly on
  the `.ps2-brand--login` / `.ps2-brand--sidebar` container itself, nothing
  else needed.
