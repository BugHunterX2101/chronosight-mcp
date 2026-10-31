import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Workbench } from "../../../components/Workbench.tsx";

export const metadata: Metadata = { title: "Workbench · Chronosight" };

// The live workbench (DESIGN §25.1): a client page over the session's WebSocket. The session id is
// only a handle; the HttpOnly cookie the gateway set is what authorises reads and actions.
export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  if (!/^ses_[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId)) notFound();
  return (
    <main id="main" className="shell">
      <Workbench sessionId={sessionId} />
    </main>
  );
}
