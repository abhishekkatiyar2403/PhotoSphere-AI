// Authored preview — the self-contained SVG orb mark. Renders anywhere with no
// asset dependency; its gradient reads --ps2-accent / --ps2-purple, so the
// card wraps it in `.ps2` (where those tokens live) on a dark surface.
import { Ps2Logo } from "@photosphere/frontend";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="ps2"
      data-ps2-theme="dark"
      style={{ background: "#0a0b10", padding: 32, display: "flex", gap: 28, alignItems: "center", justifyContent: "center" }}
    >
      {children}
    </div>
  );
}

export const Default = () => (
  <Frame>
    <Ps2Logo size={48} gradientId="ps2logo-default" />
  </Frame>
);

export const Sizes = () => (
  <Frame>
    <Ps2Logo size={24} gradientId="ps2logo-24" />
    <Ps2Logo size={36} gradientId="ps2logo-36" />
    <Ps2Logo size={56} gradientId="ps2logo-56" />
    <Ps2Logo size={80} gradientId="ps2logo-80" />
  </Frame>
);
