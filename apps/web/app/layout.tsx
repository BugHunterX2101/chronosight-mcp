import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ChronoSight · Autonomous Robotic Inspection", template: "%s · ChronoSight" },
  description: "Autonomous kinematic inspection of industrial robotics from real-time visual telemetry. Meta SAM 3.1 perception, grounded dual-lane causal diagnosis, and ISO 10816-3 mechanical verification.",
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
          <a className="brand" href="/" aria-label="ChronoSight home">
            <span className="brand-mark" aria-hidden="true" />
            ChronoSight
          </a>
          <nav aria-label="Primary">
            <a href="/#runs">Telemetry Runs</a>
            <a href="/#live">Real-Time Inspection</a>
            <a href="/about">About</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
