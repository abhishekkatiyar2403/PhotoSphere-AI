"use client";

import { useEffect, useState } from "react";

// Same window.innerWidth <= 760 breakpoint the prototype uses everywhere
// (sidebar -> bottom nav, collage -> stacked hero, etc).
export function useIsMobile(breakpoint = 760): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    function check() {
      setIsMobile(window.innerWidth <= breakpoint);
    }
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [breakpoint]);

  return isMobile;
}
