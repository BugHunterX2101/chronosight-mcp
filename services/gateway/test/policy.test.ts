// Policy engine table test (TECHNICAL §6.6), including the tricky cases it names.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, loadPolicy, policyDecide, shellwords, type ApprovalRequest, type Choice } from "../src/muse/policy.ts";
import { paths } from "../src/paths.ts";

const policy = loadPolicy(join(paths.root, "sandbox", "policies", "allowlist.yaml"));
const TARGETS = ["controller.py", "params.py"];
const shell = (command: string) => evaluate({ kind: "shell", command }, policy, TARGETS);

describe("shell commands", () => {
  it.each([
    ["pytest", "ALLOWLIST"],
    ["pytest -q", "ALLOWLIST"],
    ["pytest -q -x tests/", "ALLOWLIST"],
    ["pytest tests/test_step_response.py", "ALLOWLIST"],
    ["pytest /workspace/tests", "ALLOWLIST"],
    ["python -m pytest -q tests", "ALLOWLIST"],
    ["pio run -t compile", "ALLOWLIST"],
  ])("allows %s", (cmd, rule) => {
    expect(shell(cmd)).toEqual({ allow: true, rule });
  });

  it.each([
    ["pytest tests/../../etc", "PATH_ESCAPE"],
    ["pytest /etc/passwd", "PATH_ESCAPE"],
    ["pytest $(id)", "METACHAR"],
    ["pytest; rm -rf /", "METACHAR"],
    ["pytest 'a;b'", "METACHAR"],
    ["pytest | tee x", "METACHAR"],
    ["pytest > out.txt", "METACHAR"],
    ["pytest `id`", "METACHAR"],
    ["pytest\nid", "METACHAR"],
    ["PYTHONPATH=x pytest", "ENV_ASSIGN"],
    ['pytest -k "a or b"', "DEFAULT_DENY"],
    ["ｐytest", "DEFAULT_DENY"],
    ["pytest tests/../controller.py", "DEFAULT_DENY"],
    ["python -c 'import os'", "DEFAULT_DENY"],
    ["pio run -t upload", "DEFAULT_DENY"],
    ["curl https://example.com", "DEFAULT_DENY"],
    ["pytest 'unterminated", "PARSE"],
    ["", "PARSE"],
  ])("denies %j", (cmd, rule) => {
    expect(shell(cmd)).toEqual({ allow: false, rule });
  });
});

describe("other subjects", () => {
  it("allows writes to target files only", () => {
    expect(evaluate({ kind: "fileAccess", access: "write", path: "params.py" }, policy, TARGETS)).toEqual({ allow: true, rule: "FILE_EDIT" });
    expect(evaluate({ kind: "fileAccess", access: "write", path: "/workspace/controller.py" }, policy, TARGETS).allow).toBe(true);
    expect(evaluate({ kind: "fileAccess", access: "write", path: "tests/test_step_response.py" }, policy, TARGETS)).toEqual({ allow: false, rule: "FILE_EDIT" });
    expect(evaluate({ kind: "fileAccess", access: "write", path: "../etc/passwd" }, policy, TARGETS)).toEqual({ allow: false, rule: "PATH_ESCAPE" });
  });

  it("allows reads inside the workspace only", () => {
    expect(evaluate({ kind: "fileAccess", access: "read", path: "tests/test_step_response.py" }, policy, TARGETS).allow).toBe(true);
    expect(evaluate({ kind: "fileAccess", access: "read", path: "/home/muse/.config" }, policy, TARGETS)).toEqual({ allow: false, rule: "PATH_ESCAPE" });
  });

  it.each(["network", "unixSocket", "process", "tool", "somethingNew"])("denies %s", (kind) => {
    expect(evaluate({ kind, host: "example.com" }, policy, TARGETS)).toEqual({ allow: false, rule: "DEFAULT_DENY" });
  });
});

describe("choice selection", () => {
  const choices: Choice[] = [
    { choiceId: "c-session", decision: "approvedForSession", scope: "session" },
    { choiceId: "c-always", decision: "approvedPolicyAmendment", scope: "localPersistent" },
    { choiceId: "c-once", decision: "approved", scope: "once" },
    { choiceId: "c-reject", decision: "denied", scope: "once", acceptsFeedback: true },
  ];
  const req = (command: string, availableChoices = choices): ApprovalRequest =>
    ({ approvalId: "a1", availableChoices, subject: { kind: "shell", command } });

  it("allows with the once-scoped choice, never a session or persistent grant", () => {
    expect(policyDecide(req("pytest -q"), policy, TARGETS)).toEqual({ allow: true, choiceId: "c-once", feedback: null, rule: "ALLOWLIST" });
  });

  it("denies with feedback naming the allowed commands", () => {
    const d = policyDecide(req("curl x"), policy, TARGETS);
    expect(d).toMatchObject({ allow: false, choiceId: "c-reject", rule: "DEFAULT_DENY" });
    expect(d.feedback).toContain("pytest");
    expect(d.feedback).toContain("controller.py");
  });

  it("denies an allowed command when no allow-once choice is offered", () => {
    const d = policyDecide(req("pytest", choices.filter((c) => c.choiceId !== "c-once")), policy, TARGETS);
    expect(d).toMatchObject({ allow: false, choiceId: "c-reject", rule: "NO_ALLOW_ONCE" });
  });

  it("returns no choice when only broad grants are offered, so the turn is cancelled", () => {
    const d = policyDecide(req("curl x", choices.slice(0, 2)), policy, TARGETS);
    expect(d).toEqual({ allow: false, choiceId: null, feedback: null, rule: "DEFAULT_DENY" });
  });
});

describe("shellwords", () => {
  it("splits with POSIX quoting and no expansion", () => {
    expect(shellwords(`a 'b c' "d \\" e" f\\ g`)).toEqual(["a", "b c", 'd " e', "f g"]);
    expect(shellwords("  ")).toEqual([]);
  });
});
