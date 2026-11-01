"use client";

import { useMemo, useState } from "react";
import { qrPath } from "../lib/glasses/qr.ts";
import { ApiError, bindGlassesCode, mintGlassesLink, type GlassesLink } from "../lib/session/api.ts";

type Notice = { kind: "ok" | "error"; text: string } | null;

const why = (err: unknown): string => (err instanceof ApiError ? err.message : "The gateway could not be reached. Try again.");
const until = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Qr({ text }: { text: string }) {
  const { size, d } = useMemo(() => qrPath(text), [text]);
  return (
    <svg className="glasses-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="QR code for the glasses link" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

// Pairing and the glasses preview (DESIGN §26.5, §26.6). The glasses show a code and it is entered here, or the
// workbench makes a link for them. The preview is the real /hud page in a frame, paired with its own code, so it
// shows exactly what the lens shows, from the same event stream the glasses read.
export function GlassesPanel({ sessionId }: { sessionId: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [link, setLink] = useState<GlassesLink | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice({ kind: "error", text: why(err) });
    } finally {
      setBusy(false);
    }
  };

  const pair = () =>
    run(async () => {
      await bindGlassesCode(sessionId, code.trim());
      setCode("");
      setNotice({ kind: "ok", text: "Paired. The glasses now follow this inspection." });
    });

  const makeLink = () =>
    run(async () => {
      setLink(await mintGlassesLink(sessionId));
    });

  const togglePreview = () =>
    run(async () => {
      if (preview !== null) {
        setPreview(null);
        return;
      }
      setPreview((await mintGlassesLink(sessionId)).code);
    });

  return (
    <section className="panel" aria-labelledby="gl-h">
      <h2 id="gl-h">Glasses</h2>
      <p className="muted">Follow this inspection on Meta Ray-Ban Display glasses. Enter the code the glasses show, or send them a link.</p>

      <form
        className="glasses-form"
        onSubmit={(e) => {
          e.preventDefault();
          void pair();
        }}
      >
        <label htmlFor="gl-code">Code on the glasses</label>
        <input
          id="gl-code"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={8}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="K7Q-2MX"
        />
        <button type="submit" disabled={busy || code.trim().length < 6}>
          Pair
        </button>
      </form>

      <div className="controls">
        <button type="button" disabled={busy} onClick={() => void makeLink()}>
          {link === null ? "Make a link for the glasses" : "Make a new link"}
        </button>
        <button type="button" disabled={busy} aria-pressed={preview !== null} onClick={() => void togglePreview()}>
          {preview === null ? "Preview the glasses view" : "Hide the preview"}
        </button>
      </div>

      {notice !== null ? (
        <p role={notice.kind === "error" ? "alert" : "status"} className={notice.kind === "error" ? "alert" : "verdict pass"}>
          {notice.text}
        </p>
      ) : null}

      {link !== null ? (
        <div className="glasses-link">
          <Qr text={link.url} />
          <div>
            <p>
              Code <strong className="glasses-display">{link.display}</strong>, good until {until(link.expiresAt)}, one use.
            </p>
            <p>
              <a href={link.url}>Open the glasses page</a>
            </p>
            <p>
              <a href={link.deepLink}>Open in the Meta AI app</a>
            </p>
          </div>
        </div>
      ) : null}

      {preview !== null ? (
        <figure className="glasses-figure">
          <div className="glasses-frame">
            <iframe title="What the glasses show" src={`/hud?code=${encodeURIComponent(preview)}`} />
          </div>
          <figcaption className="muted">The glasses page, live. Black is clear on the lens.</figcaption>
        </figure>
      ) : null}
    </section>
  );
}
