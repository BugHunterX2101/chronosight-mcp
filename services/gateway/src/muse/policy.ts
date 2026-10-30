// Policy engine for Muse Code approvals (DESIGN §18.4, TECHNICAL §6.6).
//
// Every `approval/requested` from a sandboxed `muse serve` is answered here, never by a
// person and never by Muse Code's own judge. Commands are matched as an argument vector
// that this module splits itself from the raw command (the host's own `stages` are not
// trusted). Only a choice scoped to this one request is ever picked: a "session" or
// "localPersistent" grant would let later requests skip the policy.

import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** The subset of MSP `ApprovalChoice` the engine reads. */
export interface Choice {
  choiceId: string;
  decision: string;
  scope: string;
  acceptsFeedback?: boolean;
}

/** The subset of MSP `ApprovalRequestParams` the engine reads. */
export interface ApprovalRequest {
  approvalId: string;
  availableChoices: Choice[];
  subject: { kind: string; command?: string; path?: string; access?: string; host?: string; toolName?: string };
}

export type Rule =
  | "FILE_EDIT" | "FILE_READ" | "PARSE" | "METACHAR" | "ENV_ASSIGN" | "PATH_ESCAPE"
  | "ALLOWLIST" | "DEFAULT_DENY" | "NO_ALLOW_ONCE";

export interface Decision {
  allow: boolean;
  /** null when the request offers no usable choice; the caller then cancels the turn */
  choiceId: string | null;
  feedback: string | null;
  rule: Rule;
}

const CommandSpec = z.strictObject({
  argv0: z.string().min(1),
  args: z.strictObject({
    fixed: z.array(z.string()).default([]),
    flags: z.array(z.string()).default([]),
    pathsUnder: z.string().optional(),
  }),
});

const PolicyFile = z.strictObject({
  version: z.literal(1),
  commands: z.array(CommandSpec).min(1),
  fileEdits: z.strictObject({ targetFilesOnly: z.literal(true) }),
});

export type Policy = z.infer<typeof PolicyFile>;

export function loadPolicy(path: string): Policy {
  return PolicyFile.parse(parseYaml(readFileSync(path, "utf8")));
}

const WORKSPACE = "/workspace";
const METACHARS = /[;|&$><`\n\r]/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** POSIX shell-word splitting: quotes and backslashes only, no expansion. Throws on an unterminated quote. */
export function shellwords(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated single quote");
      cur += line.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      i++;
      for (; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1]!)) i++;
        cur += line[i];
      }
      if (i >= line.length) throw new Error("unterminated double quote");
      inWord = true;
    } else if (c === "\\") {
      if (i + 1 >= line.length) throw new Error("trailing backslash");
      cur += line[++i];
      inWord = true;
    } else if (c === " " || c === "\t") {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/** Workspace-relative normal form of a path argument, or null when it leaves /workspace. */
export function inWorkspace(p: string): string | null {
  const rel = p === WORKSPACE ? "." : p.startsWith(WORKSPACE + "/") ? p.slice(WORKSPACE.length + 1) : p;
  if (posix.isAbsolute(rel)) return null;
  const n = posix.normalize(rel);
  return n === ".." || n.startsWith("../") ? null : n;
}

function under(p: string, dir: string): boolean {
  const n = inWorkspace(p);
  return n !== null && (n === dir || n.startsWith(dir.replace(/\/$/, "") + "/"));
}

function matches(argv: string[], spec: z.infer<typeof CommandSpec>): boolean {
  if (argv[0] !== spec.argv0) return false;
  const { fixed, flags, pathsUnder } = spec.args;
  for (let i = 0; i < fixed.length; i++) if (argv[1 + i] !== fixed[i]) return false;
  return argv.slice(1 + fixed.length).every((a) =>
    flags.includes(a) || (pathsUnder !== undefined && !a.startsWith("-") && under(a, pathsUnder)));
}

export function allowedSummary(policy: Policy, targetFiles: readonly string[]): string {
  const cmds = policy.commands.map((c) =>
    [c.argv0, ...c.args.fixed, ...c.args.flags.map((f) => `[${f}]`), ...(c.args.pathsUnder ? [`[${c.args.pathsUnder}/…]`] : [])].join(" "));
  return `Allowed commands: ${cmds.join("; ")}. Edit only: ${targetFiles.join(", ")}.`;
}

/** The rule-level verdict, before a choice is picked. Exported for the table test. */
export function evaluate(subject: ApprovalRequest["subject"], policy: Policy, targetFiles: readonly string[]): { allow: boolean; rule: Rule } {
  if (subject.kind === "fileAccess") {
    const rel = subject.path === undefined ? null : inWorkspace(subject.path);
    if (rel === null) return { allow: false, rule: "PATH_ESCAPE" };
    if (subject.access === "read") return { allow: true, rule: "FILE_READ" };
    return { allow: subject.access === "write" && targetFiles.includes(rel), rule: "FILE_EDIT" };
  }
  if (subject.kind !== "shell" || typeof subject.command !== "string") return { allow: false, rule: "DEFAULT_DENY" };

  const raw = subject.command;
  if (METACHARS.test(raw)) return { allow: false, rule: "METACHAR" };
  let argv: string[];
  try {
    argv = shellwords(raw.trim());
  } catch {
    return { allow: false, rule: "PARSE" };
  }
  if (argv.length === 0) return { allow: false, rule: "PARSE" };
  if (ENV_ASSIGN.test(argv[0]!)) return { allow: false, rule: "ENV_ASSIGN" };
  if (argv.slice(1).some((a) => !a.startsWith("-") && inWorkspace(a) === null)) return { allow: false, rule: "PATH_ESCAPE" };
  if (policy.commands.some((spec) => matches(argv, spec))) return { allow: true, rule: "ALLOWLIST" };
  return { allow: false, rule: "DEFAULT_DENY" };
}

export function policyDecide(req: ApprovalRequest, policy: Policy, targetFiles: readonly string[]): Decision {
  const verdict = evaluate(req.subject, policy, targetFiles);
  const once = (c: Choice) => c.scope === "once";
  if (verdict.allow) {
    const allow = req.availableChoices.find((c) => once(c) && c.decision === "approved");
    if (allow) return { allow: true, choiceId: allow.choiceId, feedback: null, rule: verdict.rule };
  }
  const rule: Rule = verdict.allow ? "NO_ALLOW_ONCE" : verdict.rule;
  const deny = req.availableChoices.find((c) => once(c) && c.decision === "denied");
  if (!deny) return { allow: false, choiceId: null, feedback: null, rule };
  const feedback = deny.acceptsFeedback ? `Denied (${rule}). ${allowedSummary(policy, targetFiles)}` : null;
  return { allow: false, choiceId: deny.choiceId, feedback, rule };
}
