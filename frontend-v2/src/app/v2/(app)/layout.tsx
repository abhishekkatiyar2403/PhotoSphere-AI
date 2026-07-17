import type { ReactNode } from "react";
import AppShellV2 from "@/components/v2/AppShellV2";

export default function V2AppLayout({ children }: { children: ReactNode }) {
  return <AppShellV2>{children}</AppShellV2>;
}
