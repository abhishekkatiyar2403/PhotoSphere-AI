"use client";

import type { CSSProperties } from "react";

// First-visit welcome tour (Upload -> Search -> Share), gated on a
// localStorage flag so it never nags twice, with a "Replay welcome tour"
// escape hatch from the profile menu (AppShellV2 owns the open/step state
// and the flag; this component is purely presentational).
//
// Markup/copy mirror the design's centered 400px modal (design lines
// 1247-1261, 2430-2434).

export const TOUR_STEPS = [
  {
    title: "Upload anything",
    body: "Drag photos or videos in — AI tags, sorts, and files everything on arrival.",
  },
  {
    title: "Find it by describing it",
    body: "Press ⌘K or open Search and type what you remember: “warm sunset over water”.",
  },
  {
    title: "Share without accounts",
    body: "Generate guest links from Share — friends view your folders with no signup.",
  },
];

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 470,
  background: "rgba(5,6,10,.6)",
  backdropFilter: "blur(8px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  animation: "ps2In .25s both",
};

const panelStyle: CSSProperties = {
  width: 400,
  maxWidth: "92vw",
  borderRadius: 20,
  background: "var(--ps2-panel)",
  border: "1px solid var(--ps2-border)",
  boxShadow: "var(--ps2-shadow)",
  padding: 28,
  animation: "ps2Up .3s cubic-bezier(.2,.8,.2,1) both",
};

export function OnboardingTourV2({ step, onNext, onSkip }: { step: number; onNext: () => void; onSkip: () => void }) {
  const current = TOUR_STEPS[step];
  const isLast = step === TOUR_STEPS.length - 1;

  return (
    <div style={backdropStyle}>
      <div style={panelStyle}>
        <div style={{ fontSize: 11.5, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--ps2-accent)", marginBottom: 10 }}>
          Welcome · {step + 1} of {TOUR_STEPS.length}
        </div>
        <div style={{ fontFamily: "var(--ps2-font-serif)", fontSize: 28, lineHeight: 1.15, marginBottom: 10 }}>{current.title}</div>
        <div style={{ fontSize: 13.5, color: "var(--ps2-muted)", lineHeight: 1.65, marginBottom: 22 }}>{current.body}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <button
            type="button"
            onClick={onSkip}
            className="ps2-tour-skip"
            style={{ border: "none", background: "transparent", color: "var(--ps2-muted)", fontFamily: "inherit", fontSize: 13, cursor: "pointer", padding: "8px 0", transition: "color .2s" }}
          >
            Skip tour
          </button>
          <button
            type="button"
            onClick={onNext}
            className="ps2-tour-next"
            style={{ borderRadius: 11, border: "none", background: "var(--ps2-accent)", color: "#141118", padding: "11px 22px", fontSize: 13.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", transition: "transform .2s" }}
          >
            {isLast ? "Done" : "Next"}
          </button>
        </div>
      </div>
      <style>{`
        .ps2-tour-skip:hover { color: var(--ps2-text); }
        .ps2-tour-next:hover { transform: translateY(-2px); }
      `}</style>
    </div>
  );
}
