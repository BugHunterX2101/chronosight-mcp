import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Chronosight", template: "%s" },
  description: "Diagnose a robot's mechanical fault from video, repair it, and prove the repair.",
};

export const viewport: Viewport = { colorScheme: "dark light", themeColor: "#0b0d10" };

// Reading the request headers makes every page dynamic, which is what lets Next stamp the nonce
// from proxy.ts onto its own scripts (TQ-1).
export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="site no-print">
          <a className="brand" href="/" aria-label="Chronosight home">
            <span className="brand-mark" aria-hidden="true" />
            Chronosight
          </a>
          <nav aria-label="Primary">
            <a href="/#runs">Recorded runs</a>
            <a href="/#live">Run live</a>
            <a href="/about">About</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
