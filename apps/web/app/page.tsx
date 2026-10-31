import { FeaturedReplays } from "../components/FeaturedReplays.tsx";
import { StartLive } from "../components/StartLive.tsx";

export default function Home() {
  return (
    <main className="shell">
      <h1>Chronosight</h1>
      <p>
        A model watches a simulated machine, finds the fault in the video, proposes a code patch, and a physics twin checks the repair. Every step below is a
        recording of a real run, replayed with its checksums verified.
      </p>
      <h2>Recorded runs</h2>
      <FeaturedReplays />
      <h2>Run it live</h2>
      <StartLive />
      <p className="muted">
        <a href="/about">About Chronosight</a>
      </p>
    </main>
  );
}
