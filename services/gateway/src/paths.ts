// Repository-relative locations the gateway reads at startup. All are static
// inputs; runtime data lives under DATA_DIR, shared with the twin.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export const paths = {
  root,
  corpus: process.env.CORPUS_DIR ? resolve(process.env.CORPUS_DIR) : resolve(root, "corpus"),
  scenarios: resolve(root, "services/twin/twin/scenarios"),
  prompts: resolve(root, "services/gateway/prompts"),
  config: resolve(root, "config"),
  fixtures: resolve(root, "fixtures"),
  // A relative DATA_DIR is taken from the repo root, as the twin does, so both see one directory.
  data: resolve(root, process.env.DATA_DIR || "data"),
};
