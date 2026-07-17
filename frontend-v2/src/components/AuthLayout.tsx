import type { ReactNode } from "react";

/**
 * Shared visual shell for /signup and /login (Option B — split screen).
 * Left panel: branded color block with product name + tagline.
 * Right panel: the existing form card, unchanged.
 * Collapses to a stacked layout on narrow/mobile widths (see .auth-brand-panel
 * breakpoint in globals.css) — the branded panel shrinks to a small header bar
 * above the form instead of taking half the viewport.
 *
 * This component only supplies the visual wrapper. It has no knowledge of
 * form state, validation, or auth logic — callers pass their existing card
 * markup as children.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <div className="auth-brand-panel">
        <span className="auth-brand-name">PhotoSphere AI</span>
        <p className="auth-brand-tagline">
          AI-organized photo storage, without the manual sorting.
        </p>
      </div>
      <div className="auth-form-panel">{children}</div>
    </main>
  );
}
