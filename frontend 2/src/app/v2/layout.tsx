import type { ReactNode } from "react";
import { Ps2ThemeProvider } from "@/components/v2/Ps2ThemeProvider";
import { ToastProviderV2 } from "@/components/v2/ToastProviderV2";

// Root layout for every /v2 screen (the PhotoSphere redesign). Only supplies
// the design-token scope + dark/light state + the one global toast host
// (see ToastProviderV2 - replaces the separate per-page toast
// implementations); auth and the sidebar/mobile nav live one level down in
// v2/(app)/layout.tsx so an eventual /v2/login can sit outside the
// authenticated shell.
export default function V2Layout({ children }: { children: ReactNode }) {
  return (
    <Ps2ThemeProvider>
      <ToastProviderV2>{children}</ToastProviderV2>
    </Ps2ThemeProvider>
  );
}
