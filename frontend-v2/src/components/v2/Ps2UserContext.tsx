"use client";

import { createContext, useContext } from "react";

export type Ps2User = { id: string; email: string; name: string };

export const Ps2UserContext = createContext<Ps2User | null>(null);

// Every /v2/(app) page renders under AppShellV2, which only mounts its
// children once auth has resolved - so a null here means this hook was
// called outside that tree, not a legitimate "logged out" state.
export function usePs2User(): Ps2User {
  const user = useContext(Ps2UserContext);
  if (!user) throw new Error("usePs2User must be used within AppShellV2");
  return user;
}
