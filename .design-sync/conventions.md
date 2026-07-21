# PhotoSphere brand components

Two logo components. **Both must render inside an element carrying the `.ps2` class** — the design tokens (`--ps2-accent`, `--ps2-purple`, `--ps2-text`, `--ps2-bg`, `--ps2-muted`, …) are defined on `.ps2`, not `:root`. Without a `.ps2` ancestor they render unstyled (black SVG gradient, browser-default text). `.ps2` is **dark by default**; add `data-theme="light"` on the same element for the light palette (`.ps2[data-theme="light"]`).

## Ps2Logo — the portable mark
Self-contained SVG "ringed sphere" orb. No image or network dependency — renders anywhere. Its gradient reads `--ps2-accent → --ps2-purple`, so it needs the `.ps2` wrapper.
Props: `gradientId: string` (**required**, must be unique per instance on the page — SVG gradient ids are document-global), `size?: number` (px, default 32).
```tsx
<div className="ps2">
  <Ps2Logo size={40} gradientId="logo-topbar" />
</div>
```

## Ps2Brand — the full lockup (orb + wordmark)
Renders the app-served image **`/v2/logo-mark.png`** (the cinematic orb + "PhotoSphere" wordmark). The host app must serve that file at that path; when it's absent the component **falls back** to the `Ps2Logo` orb + a two-weight text wordmark ("Photo" = weight 400 `--ps2-muted`, "Sphere" = weight 800 `--ps2-text`).
Props: `variant: "login" | "sidebar"` (`login` ≈ 56px tall with an accent entrance glow; `sidebar` ≈ 40px, no glow), `gradientId: string` (used by the fallback orb).
```tsx
<div className="ps2">
  <Ps2Brand variant="sidebar" gradientId="brand-sidebar" />
</div>
```

## Styling idiom
This DS styles via **CSS custom properties scoped to `.ps2`** — reference them as `var(--ps2-accent)`, `var(--ps2-text)`, etc. Component classes are prefixed `ps2-` (e.g. `ps2-brand`, `ps2-brand-lockup`, `ps2-brand-word`). Read the bound `styles.css` (and the `_ds_bundle.css` it imports) for the full token + class vocabulary. Brand fonts — **Space Grotesk** (UI) and **Instrument Serif** (display headings) — are provided by the host app and are not shipped in this bundle; text falls back to system fonts here.
