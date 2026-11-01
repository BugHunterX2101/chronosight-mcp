"use client";

import { useId, useRef, useState } from "react";
import { ApiError, clipUrl, uploadClip, type ClipScale, type UploadedClip } from "../lib/session/api.ts";
import { clipProblem, parseScale, PRIVACY_NOTICE } from "../lib/session/byo.ts";
import { recordCameraClip } from "../lib/capture/camera.ts";

// Bring your own clip (PRD FR-CAP-4): acknowledge the privacy notice, upload an MP4 or MOV, say how big the reference
// marker is if you know, then analyse. Nothing is sent until the notice is acknowledged; the gateway checks it again.

const say = (err: unknown): string => (err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));

export function ByoPanel({ sessionId, busy, onAnalyse }: { sessionId: string; busy: boolean; onAnalyse: (scale: ClipScale) => void }) {
  const ids = { notice: useId(), file: useId(), marker: useId(), px: useId() };
  const [agreed, setAgreed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [clip, setClip] = useState<UploadedClip | null>(null);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [marker, setMarker] = useState("");
  const [px, setPx] = useState("");
  const camera = useRef<Promise<void> | null>(null);

  const choose = (f: File | null) => {
    setClip(null);
    setFile(f);
    setProblem(f === null ? null : clipProblem(f));
  };

  const send = async () => {
    if (file === null || !agreed) return;
    setSending(true);
    setProblem(null);
    try {
      setClip(await uploadClip(sessionId, file, new Date()));
    } catch (err) {
      setProblem(say(err));
    } finally {
      setSending(false);
    }
  };

  const analyse = () => {
    const parsed = parseScale(marker, px);
    if ("error" in parsed) setProblem(parsed.error);
    else {
      setProblem(null);
      onAnalyse(parsed.scale);
    }
  };

  const record = () => {
    if (recording) return;
    setProblem(null);
    setRecording(true);
    const job = recordCameraClip().then((captured) => choose(captured)).catch((err: unknown) => setProblem(say(err))).finally(() => {
      setRecording(false);
      camera.current = null;
    });
    camera.current = job;
  };

  return (
    <section className="byo" aria-label="Analyse your own clip">
      <p id={ids.notice} className="banner" role="note">
        {PRIVACY_NOTICE}
      </p>
      <label className="byo-check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} aria-describedby={ids.notice} />I have read this notice
      </label>

      <label
        htmlFor={ids.file}
        className={dragging ? "byo-drop byo-drop-on" : "byo-drop"}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files[0] ?? null);
        }}
      >
        {file === null ? "Drop an MP4 or MOV here, or choose one (up to 100 MB)" : `${file.name} · ${(file.size / 1_048_576).toFixed(1)} MB`}
      </label>
      <input id={ids.file} className="byo-file" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" onChange={(e) => choose(e.target.files?.[0] ?? null)} />

      <div className="controls">
        <button type="button" disabled={!agreed || recording || sending || file !== null} onClick={record}>
          {recording ? "Recording 5 s…" : "Record 5 s from camera"}
        </button>
        <button type="button" className="primary" disabled={!agreed || file === null || problem !== null || sending || clip !== null} onClick={() => void send()}>
          {sending ? "Uploading…" : "Upload clip"}
        </button>
        {!agreed ? <span className="muted">Acknowledge the notice to upload.</span> : null}
      </div>

      {clip !== null ? (
        <div className="byo-ready">
          <video className="byo-preview" src={clipUrl(`/api/sessions/${sessionId}/clip`)} controls muted playsInline preload="metadata" aria-label="Your uploaded clip" />
          <p>
            {clip.durationS.toFixed(1)} s · {clip.frames} frames at {clip.fps} fps · {clip.width}×{clip.height}
          </p>
          <p className="muted">
            The tracker looks for this scenario&apos;s parts (the orange arm segment, the round joint and the checkered square). A clip without them is stopped
            before any analysis. A run is capped at about 25 seconds.
          </p>
          <div className="byo-scale">
            <label htmlFor={ids.marker}>Checkered marker width, mm (optional)</label>
            <input id={ids.marker} type="text" inputMode="decimal" value={marker} onChange={(e) => setMarker(e.target.value)} />
            <label htmlFor={ids.px}>or millimetres per pixel (optional)</label>
            <input id={ids.px} type="text" inputMode="decimal" value={px} onChange={(e) => setPx(e.target.value)} />
          </div>
          <p className="muted">With neither, the run reports sizes in pixels and says so.</p>
          <button type="button" className="primary" disabled={busy} onClick={analyse}>
            Analyse this clip
          </button>
        </div>
      ) : null}

      {problem !== null ? (
        <p role="alert" className="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
