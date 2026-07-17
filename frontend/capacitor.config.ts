import type { CapacitorConfig } from '@capacitor/cli';

// This app has no Next.js API routes/middleware and no static-export-
// incompatible server rendering — every page is a client component talking
// to the separate Express backend (see src/lib/api.ts's API_BASE_URL). The
// one thing static export CAN'T handle is the dynamic /g/[token] guest
// route (Next needs every dynamic path known at build time to pre-render
// it, and invite tokens are generated at runtime).
//
// So instead of a static bundle, the native shell's WebView points straight
// at the ALREADY-RUNNING `npm run dev` server on this Mac's LAN IP — same
// idea as opening the site in Safari on your phone, just wrapped as an app.
// This only works while your Mac is on, `npm run dev` is running, and your
// phone is on the SAME WiFi network. It is NOT a real deployment — there is
// still no publicly reachable hosting for this app (see agents/STATUS.md).
//
// Swap DEV_SERVER_LAN_URL for a real deployed URL once one exists — no
// other change needed here.
const DEV_SERVER_LAN_URL = 'http://10.10.144.146:3000';

const config: CapacitorConfig = {
  appId: 'com.photosphereai.app',
  appName: 'PhotoSphere AI',
  webDir: 'out',
  server: {
    url: DEV_SERVER_LAN_URL,
    cleartext: true, // plain http, not https — LAN dev only
  },
};

export default config;
