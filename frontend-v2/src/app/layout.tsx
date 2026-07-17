import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Instrument_Serif, Space_Grotesk } from "next/font/google";
import "./globals.css";

// Self-hosted via next/font (fetched + cached at build time, no runtime
// request to Google) for the /v2 redesign - see globals.css's --ps2-font-*.
// Additive: exposed only as CSS variables on <body>, so classic pages (whose
// CSS never references these vars) are visually unaffected.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
});

export const metadata: Metadata = {
  title: "PhotoSphere AI",
  description: "AI-organized photo storage - local MVP",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.variable} ${instrumentSerif.variable}`}>{children}</body>
    </html>
  );
}
