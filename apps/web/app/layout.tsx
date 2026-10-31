import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chronosight",
  description: "Diagnose a robot's mechanical fault from video, repair it, and prove the repair.",
};

// Reading the request headers makes every page dynamic, which is what lets Next stamp the nonce
// from proxy.ts onto its own scripts (TQ-1).
export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
