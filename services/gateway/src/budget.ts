// Prices and metering (DESIGN §22.1–22.2).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "./paths.ts";
import type { Usage } from "./meta.ts";

const Prices = z.object({
  verifiedOn: z.iso.date(),
  currency: z.literal("USD"),
  models: z.record(z.string(), z.object({
    inputPerM: z.number().min(0),
    cachedInputPerM: z.number().min(0),
    outputPerM: z.number().min(0),
    perImage: z.number().optional(),
    perHour: z.number().optional(),
    perFrame: z.number().optional(),
    minFramesPerRequest: z.int().optional(),
  })),
  searchPer1k: z.number(),
});
export type Prices = z.infer<typeof Prices>;

export function loadPrices(file = join(paths.config, "prices.json")): Prices {
  return Prices.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Days since the table was verified; the admin page warns above 7 (§22.1). */
export function pricesAgeDays(p: Prices, now = new Date()): number {
  return Math.floor((now.getTime() - Date.parse(`${p.verifiedOn}T00:00:00Z`)) / 86_400_000);
}

/** (input − cached) × in + cached × cachedIn + output × out; output includes reasoning. */
export function costOf(p: Prices, model: string, u: Usage): number {
  const m = p.models[model];
  if (!m) throw new Error(`no price for model ${model} in config/prices.json`);
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return ((u.input_tokens - cached) * m.inputPerM + cached * m.cachedInputPerM + u.output_tokens * m.outputPerM) / 1e6;
}
