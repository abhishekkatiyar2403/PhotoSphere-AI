"use client";

// v2 ("ps2") auth shell — the redesign's cinematic split layout (README.md
// "Login"): left collage panel with floating cards over a radial-glow dark
// background + italic serif tagline, right centered form card. Purely
// presentational; login/signup pass their existing form state as children.
//
// The prototype's collage uses placeholder photo assets that don't live in
// this frontend's public dir, so the floating cards are gradient blobs
// instead — same motion + composition, no broken images.

import { ReactNode } from "react";
import Link from "next/link";

const CARDS = [
  { left: "8%", top: "12%", w: "30%", ar: "4 / 3", tilt: "-5deg", delay: "0s", from: "#1a1e2e", to: "#2b3350" },
  { left: "42%", top: "6%", w: "24%", ar: "3 / 4", tilt: "3deg", delay: "1.2s", from: "#3a2b50", to: "#7fa8e8" },
  { left: "14%", top: "52%", w: "26%", ar: "1 / 1", tilt: "2deg", delay: "0.6s", from: "#12303a", to: "#2b6b6b" },
  { left: "48%", top: "46%", w: "34%", ar: "4 / 3", tilt: "-2deg", delay: "2s", from: "#4a2b1e", to: "#e8a15c" },
  { left: "70%", top: "16%", w: "22%", ar: "3 / 4", tilt: "5deg", delay: "3s", from: "#1a2438", to: "#5a7bc0" },
];

export default function Ps2AuthShell({ switchHref, switchLabel, children }: { switchHref: string; switchLabel: string; children: ReactNode }) {
  return (
    <div className="ps2" data-ps2-theme="dark">
      <div className="ps2-auth">
        <div className="ps2-auth-collage">
          <div className="ps2-auth-collage-glow" />
          {CARDS.map((c, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: c.left,
                top: c.top,
                width: c.w,
                aspectRatio: c.ar,
                ["--ps2-tilt" as string]: c.tilt,
                animation: `ps2Float ${9 + i}s ease-in-out infinite ${c.delay}`,
                borderRadius: 14,
                overflow: "hidden",
                boxShadow: "var(--ps2-shadow)",
                background: `linear-gradient(150deg, ${c.from}, ${c.to})`,
              }}
            />
          ))}
          <div className="ps2-auth-tagline">
            Every photo,<br />remembered beautifully.
          </div>
        </div>

        <div className="ps2-auth-form-panel">
          <Link href={switchHref} className="ps2-classic-link ps2-auth-switch">
            {switchLabel}
          </Link>
          <div className="ps2-auth-card">
            <div className="ps2-auth-logo">
              <div className="ps2-logo-mark"><div className="ps2-logo-dot" style={{ background: "var(--ps2-bg)" }} /></div>
              <div className="ps2-logo-name">PhotoSphere</div>
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
