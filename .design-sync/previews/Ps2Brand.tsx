// Authored preview — the full PhotoSphere brand lockup (orb + wordmark). The
// real component renders the app-served image /v2/logo-mark.png; when that
// asset isn't served (as in the design tool) it falls back to the SVG orb +
// two-weight wordmark. Wrapped in `.ps2` dark so tokens/type apply.
//
// The login variant has a one-time `ps2Up` entrance animation (opacity 0→1);
// a static preview capture freezes it at opacity:0, so we neutralize just that
// entrance here to show the resting state (the animation is unchanged in-app).
import { Ps2Brand } from "@photosphere/frontend";

const NoEntrance = () => <style>{`.ps2-brand--login{animation:none!important;opacity:1!important}`}</style>;

export const LoginLockup = () => (
  <div className="ps2" data-ps2-theme="dark" style={{ background: "#0a0b10", padding: 28 }}>
    <NoEntrance />
    <Ps2Brand variant="login" gradientId="ps2brand-login" />
  </div>
);

export const SidebarLockup = () => (
  <div className="ps2" data-ps2-theme="dark" style={{ background: "#12141c", padding: 28, maxWidth: 236 }}>
    <Ps2Brand variant="sidebar" gradientId="ps2brand-sidebar" />
  </div>
);
