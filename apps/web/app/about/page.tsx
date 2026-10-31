import type { Metadata } from "next";

export const metadata: Metadata = { title: "About · Chronosight" };

// Static (DESIGN §25.1). It describes what the product does today; it carries no validation tables.
// Measured figures are shown where they were measured: in each run's visual test and audit report.
export default function AboutPage() {
  return (
    <main id="main" className="shell light">
      <h1>About Chronosight</h1>
      <p>
        Chronosight inspects a simulated machine from its video. It finds the faulty part, asks a model why it misbehaves, proposes a code patch, and checks the
        repair by running the machine again and measuring the same video signal.
      </p>

      <h2>How a run goes</h2>
      <ol>
        <li>The digital twin renders a short clip of the machine and records its sensor trace.</li>
        <li>A segmentation model finds and tracks the named parts in the clip, and the vibration of the fault part is measured from those tracks.</li>
        <li>You ask a question. A reasoning model returns ranked hypotheses, each with quotes from the machine&apos;s documentation that are checked against the source text.</li>
        <li>A second model reviews the proposed change for risk. You approve it in two separate steps.</li>
        <li>A coding model writes the patch inside hard parameter bounds, and the twin runs it in an isolated sandbox.</li>
        <li>The twin renders the machine again and the same measurement runs on the new clip. The visual test lists every criterion with its value and threshold.</li>
      </ol>

      <h2>What is real and what is not</h2>
      <ul>
        <li>The machine, the camera and the clip are synthetic. They come from a physics simulation, not a camera.</li>
        <li>The model calls are real. Each run&apos;s audit report records its lanes, cost and timings, and the hash chain that protects the log.</li>
        <li>Recorded runs are replays of real runs. Each file in a replay is checked against its sha256 in your browser before it is used; a changed byte stops playback.</li>
        <li>Diagnosis takes minutes, not seconds, because it uses the deepest reasoning setting.</li>
      </ul>

      <h2>Safety and data</h2>
      <ul>
        <li>No patch is applied without your two approvals, and the approval is bound to the exact patch specification you were shown.</li>
        <li>Live runs are limited by a daily budget and a per-visitor hourly cap. When they are off, recorded runs still play.</li>
        <li>The browser never holds a model key. It talks only to this site&apos;s gateway.</li>
        <li>This version runs only the built-in synthetic scenarios. It does not accept uploaded video.</li>
      </ul>

      <p>
        <a href="/">Back to the home page</a>
      </p>
    </main>
  );
}
