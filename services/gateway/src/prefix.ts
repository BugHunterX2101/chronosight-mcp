// Cached prompt prefix P0–P4 (DESIGN §16.3, DL-13/14, D-9).
//
// Everything here is byte-identical for a given scenario and corpus version: NFC
// text, LF endings, pages in manifest order, files sorted by path, no timestamps.
// corpusHash12 = first 12 hex of sha256(P0 ‖ P1 ‖ P2 ‖ P3 ‖ P4), the parts'
// UTF-8 bytes concatenated with no separator (D-9).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { jcs, sha256Hex } from "@chronosight/run-model";
import { paths } from "./paths.ts";

export type PartId = "P0" | "P1" | "P2" | "P3" | "P4";

export interface Scenario {
  id: string;
  title: string;
  hazardousVoltage: boolean;
  objectives: string[];
  hardBounds: Record<string, [number, number]>;
  targetFiles: string[];
  concepts: { slug: string; prompt: string; role: string; expectedCount: number }[];
  assertions: { type: string; role: string; params: Record<string, number> }[];
  [k: string]: unknown;
}

export interface CorpusManifest {
  docId: string;
  title: string;
  version: string;
  licence: string;
  pages: number;
  sha256: string;
}

export interface Prefix {
  scenarioId: string;
  parts: { id: PartId; text: string }[];
  corpusHash12: string;
  /** page text by number, for citation verification (§16.7) */
  pages: Map<number, string>;
  manifest: CorpusManifest;
  scenario: Scenario;
}

export const CONTROLLER_INTERFACE = "Controller.step(state: State, dt: float) -> Command";

function readText(path: string): string {
  const text = readFileSync(path, "utf8");
  if (text.includes("\r")) throw new Error(`${path}: CR found, prefix inputs must use LF`);
  if (text.normalize("NFC") !== text) throw new Error(`${path}: text is not NFC`);
  return text;
}

export function loadScenario(scenarioId: string): Scenario {
  if (!/^[a-z0-9]{1,16}$/.test(scenarioId)) throw new Error(`bad scenario id ${scenarioId}`);
  return parseYaml(readText(join(paths.scenarios, scenarioId, "scenario.yaml"))) as Scenario;
}

export function loadCorpus(docId = "encx14"): { manifest: CorpusManifest; pages: Map<number, string>; p2: string } {
  const dir = join(paths.corpus, docId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as CorpusManifest;
  const pages = new Map<number, string>();
  let p2 = "";
  for (let n = 1; n <= manifest.pages; n++) {
    const text = readText(join(dir, "pages", `${String(n).padStart(3, "0")}.md`));
    pages.set(n, text);
    p2 += `<<doc=${manifest.docId} page=${n}>>\n${text}`;
  }
  // Startup assert: the bytes we send are the bytes the corpus builder hashed.
  const got = sha256Hex(Buffer.from(p2, "utf8"));
  if (got !== manifest.sha256) {
    throw new Error(`corpus ${docId}: P2 sha256 ${got} != manifest ${manifest.sha256}; run npm run corpus:check`);
  }
  return { manifest, pages, p2 };
}

function controllerSource(scenarioId: string): string {
  const dir = join(paths.scenarios, scenarioId, "baseline");
  const files = readdirSync(dir).filter((f) => f.endsWith(".py")).sort();
  return files
    .map((f) => {
      const text = readText(join(dir, f));
      return `<<file=${f} sha=${sha256Hex(Buffer.from(text, "utf8"))}>>\n${text}${text.endsWith("\n") ? "" : "\n"}`;
    })
    .join("");
}

function scenarioSpec(sc: Scenario): string {
  const spec = {
    id: sc.id,
    title: sc.title,
    hazardousVoltage: sc.hazardousVoltage,
    interface: CONTROLLER_INTERFACE,
    targetFiles: sc.targetFiles,
    hardBounds: sc.hardBounds,
    objectives: sc.objectives,
    concepts: sc.concepts.map((c, i) => ({ objectId: i, slug: c.slug, role: c.role })),
    assertions: sc.assertions.map((a) => ({ type: a.type, role: a.role })),
  };
  return `<<scenario=${sc.id}>>\n${jcs(spec)}\n`;
}

const cache = new Map<string, Prefix>();

export function buildPrefix(scenarioId: string): Prefix {
  const hit = cache.get(scenarioId);
  if (hit) return hit;
  const scenario = loadScenario(scenarioId);
  const { manifest, pages, p2 } = loadCorpus();
  const p1 = `<<manifest>>\n${jcs({ documents: [{ docId: manifest.docId, title: manifest.title, version: manifest.version, pages: manifest.pages }] })}\n`;
  const parts: Prefix["parts"] = [
    { id: "P0", text: readText(join(paths.prompts, "p0.v1.txt")) },
    { id: "P1", text: p1 },
    { id: "P2", text: p2 },
    { id: "P3", text: controllerSource(scenarioId) },
    { id: "P4", text: scenarioSpec(scenario) },
  ];
  const corpusHash12 = sha256Hex(Buffer.concat(parts.map((p) => Buffer.from(p.text, "utf8")))).slice(0, 12);
  const prefix = { scenarioId, parts, corpusHash12, pages, manifest, scenario };
  cache.set(scenarioId, prefix);
  return prefix;
}

export function promptCacheKey(scenarioId: string, corpusHash12: string, lane: "contrib" | "std"): string {
  return `cs:${scenarioId}:${corpusHash12}:${lane}`;
}
