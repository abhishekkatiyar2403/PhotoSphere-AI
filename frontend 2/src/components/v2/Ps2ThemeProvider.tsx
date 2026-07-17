"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Ps2Logo } from "@/components/v2/Ps2Logo";

type Theme = "dark" | "light";

const Ps2ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void }>({
  theme: "dark",
  toggleTheme: () => {},
});

export function usePs2Theme() {
  return useContext(Ps2ThemeContext);
}

/**
 * Wraps every /v2 screen in the `.ps2` scope that carries the redesign's
 * design tokens (see globals.css), and owns dark/light state. The inline
 * script sets data-theme on first paint (before hydration) so switching to
 * light mode doesn't flash dark on reload — same trick as any SSR dark-mode
 * toggle.
 *
 * Also hosts the two prototype-global chrome pieces that appear on every
 * screen including Login: the branded first-paint splash and the ambient
 * cursor-reactive glow (PhotoSphere.dc.html renders both outside any view
 * conditional).
 */
export function Ps2ThemeProvider({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    const stored = window.localStorage.getItem("ps2_theme");
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  useEffect(() => {
    rootRef.current?.setAttribute("data-theme", theme);
    window.localStorage.setItem("ps2_theme", theme);
  }, [theme]);

  // Branded splash — matches the prototype's 950ms intro window.
  useEffect(() => {
    const timer = window.setTimeout(() => setShowSplash(false), 950);
    return () => window.clearTimeout(timer);
  }, []);

  // Ambient cursor-reactive glow — present on every v2 screen (see .ps2-ambient).
  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      document.documentElement.style.setProperty("--ps2-mx", `${(e.clientX / window.innerWidth) * 100}%`);
      document.documentElement.style.setProperty("--ps2-my", `${(e.clientY / window.innerHeight) * 100}%`);
    }
    window.addEventListener("pointermove", onPointerMove);
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return (
    <Ps2ThemeContext.Provider value={{ theme, toggleTheme }}>
      <div className="ps2" ref={rootRef}>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('ps2_theme');if(t==='light')document.currentScript.parentElement.setAttribute('data-theme','light');}catch(e){}",
          }}
        />
        <div className="ps2-ambient" aria-hidden="true" />
        {showSplash && (
          <div className="ps2-splash" aria-hidden="true">
            <div className="ps2-splash-mark">
              <Ps2Logo size={56} gradientId="ps2LogoSplash" />
            </div>
          </div>
        )}
        {children}
      </div>
    </Ps2ThemeContext.Provider>
  );
}
