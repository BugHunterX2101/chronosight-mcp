// Records a finished PUBLIC run into replays/{runId}/ and features it for its scenario (DESIGN §24).
//
//   node scripts/record-replay.ts <sessionId> [runId]
//
// Reads data/audit/{sessionId}.jsonl and the run's clips, masks and SAM tees under DATA_DIR.
// Prints the bundle's path, file count and size, then the result of verifying it. Never prints a key.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { paths } from "../src/paths.ts";
import { recordReplay, updateIndex, verifyBundle } from "../src/replay/record.ts";

const [sessionId, runId] = process.argv.slice(2);
if (!sessionId) {
  console.error("usage: node scripts/record-replay.ts <sessionId> [runId]");
  process.exit(2);
}

const appCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: paths.root, encoding: "utf8" }).trim();
const replaysDir = join(paths.root, "replays");
const now = Date.now();

const { dir, manifest } = recordReplay({ dataDir: paths.data, replaysDir, sessionId, runId, appCommit, now });
const v = verifyBundle(dir);
if (!v.ok) {
  console.error(`bundle ${dir} failed verification: ${v.path}: ${v.reason}`);
  process.exit(1);
}
updateIndex(replaysDir, manifest, now);
const bytes = manifest.files.reduce((n, f) => n + f.bytes, 0);
console.log(`recorded ${manifest.runId} (${manifest.scenarioId}) → ${dir}`);
console.log(`${manifest.files.length} files, ${(bytes / 1e6).toFixed(1)} MB, verified; models: ${manifest.models.join(", ")}`);
