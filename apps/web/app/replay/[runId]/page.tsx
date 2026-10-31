import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReplayPlayer } from "../../../components/ReplayPlayer.tsx";

export const metadata: Metadata = { title: "Replay · Chronosight" };

// A recorded run, played back in the browser from a sha256-checked bundle (DESIGN §24). The route
// is dynamic because the nonce CSP needs a per-request render (TQ-1).
export default async function ReplayPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  if (!/^run_[0-9A-Z]{26}$/.test(runId)) notFound();
  return (
    <main id="main" className="shell">
      <ReplayPlayer runId={runId} />
    </main>
  );
}
