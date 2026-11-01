// The HUD page's entry (DESIGN §26). Plain DOM, no framework: the glasses' runtime gives a 600x600 viewport and a
// bundle budget of 60 KB gzipped. It pairs, opens the transport, folds the projected events, and draws the one
// screen the model and the focus graph call for. Approval goes through the same two-step call as the workbench.

import { attemptLine, emptyModel, fold, foldEvent, gauge, nextStep, spokenFor, statusLine, verdictLine, type HudEvent, type HudModel } from "./model.ts";
import { home, initialUi, onModel, press, targetsOf, type Icon, type Key, type Ui } from "./nav.ts";
import * as pair from "./pair.ts";
import { Speaker } from "./speech.ts";
import { HudTransport, type Link } from "./transport.ts";

const gateway = document.body.dataset.gateway ?? "";
const root = document.getElementById("hud")!;
const speaker = new Speaker();

/** After a connect or snapshot the log replays at once; those screens are not announced. */
const QUIET_MS = 1500;

let creds: pair.Creds | null = null;
let model: HudModel = emptyModel;
let synced: HudModel = emptyModel;
let ui: Ui = initialUi;
let link: Link = "connecting";
let transport: HudTransport | null = null;
let queue: HudEvent[] = [];
let syncing = false;
let quietUntil = 0;
let note = "";
let busy = false;
let code: { display: string } | null = null;
let pairTimer: ReturnType<typeof setTimeout> | null = null;

const api = () => ({ fetch: globalThis.fetch.bind(globalThis), gateway });

// ------------------------------------------------------------------ drawing

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const LINK_TEXT: Record<Link, string> = { connecting: "CONNECTING", ws: "LIVE", sse: "LIVE · SSE", poll: "LIVE · POLL", offline: "OFFLINE" };

function icon(name: Icon): HTMLImageElement {
  const i = el("img", "ic");
  i.src = `/hud/icons/${name}.png`;
  i.width = 64;
  i.height = 64;
  i.alt = "";
  return i;
}

function body(): HTMLElement[] {
  const m = model;
  switch (ui.screen) {
    case "H0":
      return [el("p", "lead", "Glasses code:"), el("p", "code", code?.display ?? "······"), el("p", "body", note || "Type it into Pair glasses on the laptop.")];
    case "H1":
      return [el("p", "lead big", statusLine(m)), el("p", "body", attemptLine(m))];
    case "H2": {
      if (m.pre === null && m.post === null) return [el("p", "lead", "No reading yet"), el("p", "body dim", "The first clip is still being measured.")];
      const g = gauge(m);
      return [el("p", "fig", g.hz), el("p", "fig", g.mm), el("p", "body", `${g.coverage} · ${g.which}`)];
    }
    case "H3":
      return [el("p", "lead", nextStep(m).text)];
    case "H4": {
      const out = [el("p", "lead", `Risk: ${m.riskLevel ?? "unknown"}`), el("p", "body", m.diagnosis?.precondition ?? m.concern ?? "No precondition.")];
      if (m.approval === null) out.push(el("p", "body dim", m.state?.startsWith("AWAITING_APPROVAL") ? "Waiting for the next step…" : "Nothing to approve yet."));
      if (note) out.push(el("p", "body", note));
      return out;
    }
    case "H5": {
      const v = m.verdict;
      if (!v) return [el("p", "lead", "No verdict yet")];
      const line = verdictLine(v);
      const row = el("div", "row");
      row.append(icon(v.verdict === "PASS" ? "check" : "cross"), el("p", "lead big", line.head));
      return line.reason ? [row, el("p", "body", line.reason)] : [row];
    }
    default: {
      const row = el("div", "row");
      row.append(icon("warn"), el("p", "lead", m.error?.message ?? "Something went wrong"));
      return m.error?.retryable === false ? [row, el("p", "body", "Use the laptop.")] : [row];
    }
  }
}

function render(): void {
  const head = el("header", "bar");
  head.append(el("span", "", "ChronoSight"), el("span", `link ${link}`, creds === null ? "NOT PAIRED" : LINK_TEXT[link]));
  const main = el("section", "main");
  main.append(...body());
  const nav = el("nav", "targets");
  targetsOf(ui.screen, model).forEach((t, i) => {
    const b = el("button", `t${i === ui.focus ? " on" : ""}${t.enabled ? "" : " off"}`);
    b.type = "button";
    b.tabIndex = -1;
    b.disabled = !t.enabled;
    b.append(icon(t.icon), el("span", "", t.label));
    b.addEventListener("click", () => {
      if (!t.enabled) return;
      ui = { ...ui, focus: i };
      key("Enter");
    });
    nav.append(b);
  });
  root.replaceChildren(head, main, nav);
  document.body.dataset.screen = ui.screen;
  document.body.dataset.link = link;
  // The browser's own history is never pushed (at most 5 entries); the screen rides in the current one.
  history.replaceState({ screen: ui.screen }, "");
}

// ------------------------------------------------------------------ model and screens

function scheduleSync(): void {
  if (syncing) return;
  syncing = true;
  globalThis.setTimeout(sync, 0);
}

/** Folds what arrived in one go, so a replayed log changes the screen once. */
function sync(): void {
  syncing = false;
  const prev = synced;
  const before = ui.screen;
  model = queue.reduce(foldEvent, model);
  queue = [];
  synced = model;
  if (creds === null) return;
  ui = onModel(ui, prev, model);
  render();
  if (Date.now() < quietUntil) return;
  if (ui.screen !== before) speaker.say(spokenFor(model, ui.screen));
  else if (ui.screen === "H1" && statusLine(model) !== statusLine(prev)) speaker.say(spokenFor(model, "H1"));
}

/** The gateway's projected log replaces what was folded; the cursor moves to the snapshot's head. */
function adopt(events: HudEvent[], headSeq: number): void {
  const folded = fold(events);
  const prev = synced;
  model = { ...folded, seq: Math.max(folded.seq, headSeq) };
  synced = model;
  queue = [];
  quietUntil = Date.now() + QUIET_MS;
  ui = onModel(ui, prev, model);
  render();
}

// ------------------------------------------------------------------ input

function key(k: Key): void {
  const r = press(ui, model, k, performance.now());
  ui = r.ui;
  render();
  if (r.act?.kind === "approve") void approve(r.act.step);
  else if (r.act?.kind === "retry") {
    note = "";
    transport?.retry();
  }
}

const KEYS: Record<string, Key> = { ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", Enter: "Enter", Escape: "Escape", Backspace: "Backspace" };

document.addEventListener("keydown", (e) => {
  const k = KEYS[e.key];
  if (!k || e.repeat) return;
  e.preventDefault();
  key(k);
});

async function approve(step: 1 | 2): Promise<void> {
  const a = model.approval;
  const dx = model.diagnosis?.id;
  if (creds === null || a === null || a.step !== step || !dx || busy) return;
  busy = true;
  note = "Sending…";
  render();
  try {
    const r = await fetch(`${gateway}/api/sessions/${creds.sessionId}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${creds.capability}` },
      body: JSON.stringify({ diagnosisId: dx, patchSpecHash: a.patchSpecHash, decision: "approve", step, token: a.token }),
    });
    if (r.ok) note = "";
    else if (r.status === 404) lost();
    else {
      const b = (await r.json().catch(() => null)) as { message?: string } | null;
      note = b?.message ?? "Could not approve";
      speaker.say(note);
      if (r.status === 409) void transport?.snapshot();
    }
  } catch {
    note = "Could not reach the gateway";
  } finally {
    busy = false;
    render();
  }
}

// ------------------------------------------------------------------ pairing and the link

function connect(c: pair.Creds): void {
  creds = c;
  pair.save(sessionStorage, c);
  if (pairTimer !== null) clearTimeout(pairTimer);
  model = emptyModel;
  synced = emptyModel;
  queue = [];
  quietUntil = Date.now() + QUIET_MS;
  ui = home(initialUi, model);
  transport?.stop();
  transport = new HudTransport({
    gateway, sessionId: c.sessionId, capability: c.capability,
    since: () => model.seq,
    onEvent: (e) => { queue.push(e); scheduleSync(); },
    onSnapshot: adopt,
    onLink: (l) => { link = l; render(); },
    onAuthLost: lost,
  });
  transport.start();
  render();
}

/** The gateway no longer knows this pairing: start over with a new code. */
function lost(): void {
  transport?.stop();
  transport = null;
  creds = null;
  pair.forget(sessionStorage);
  ui = initialUi;
  note = "Pairing ended. Pair again.";
  void hudFirst();
}

async function hudFirst(): Promise<void> {
  const c = await pair.newCode(api());
  if (c === null) {
    note = "Can't reach the gateway.";
    code = null;
    render();
    pairTimer = setTimeout(() => void hudFirst(), 5000);
    return;
  }
  code = { display: c.display };
  if (note === "Can't reach the gateway.") note = "";
  render();
  speaker.say(`Glasses code ${c.display.replace("-", " ").split("").join(" ")}`);
  const poll = async (): Promise<void> => {
    const r = await pair.redeem(api(), c.code);
    if (r.kind === "paired") {
      note = "";
      connect(r.creds);
    } else if (r.kind === "invalid") {
      note = "";
      void hudFirst();
    } else {
      if (r.kind === "limited") note = "Too many tries. Wait a moment.";
      pairTimer = setTimeout(() => void poll(), r.kind === "limited" ? r.retryAfterS * 1000 : pair.POLL_MS);
    }
  };
  pairTimer = setTimeout(() => void poll(), pair.POLL_MS);
}

async function boot(): Promise<void> {
  render();
  const linked = pair.codeFromUrl(location.search);
  if (linked !== null) {
    history.replaceState(null, "", location.pathname);
    const r = await pair.redeem(api(), linked);
    if (r.kind === "paired") {
      connect(r.creds);
      return;
    }
    note = r.kind === "invalid" ? "That link has expired." : "Can't reach the gateway.";
  }
  const kept = pair.load(sessionStorage, Date.now());
  if (kept !== null) {
    connect(kept);
    return;
  }
  void hudFirst();
}

void boot();
