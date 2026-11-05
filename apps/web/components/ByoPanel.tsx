"use client";

import { useEffect, useId, useRef, useState } from "react";
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
  const [autoInspecting, setAutoInspecting] = useState(false);
  const camera = useRef<Promise<void> | null>(null);

  const autoInspect = () => {
    setAutoInspecting(true);
    setAgreed(true);
    setMarker("25.4");
    if (clip !== null) {
      onAnalyse({ markerSizeMm: 25.4 });
    }
  };

  const loadSampleClip = async () => {
    setSending(true);
    setProblem(null);
    setAgreed(true);
    try {
      const res = await fetch("/replays/run_01M68V2MKCFX6SQ14ZNWPSSWXD/clips/pre.mp4");
      if (!res.ok) throw new Error(`Sample clip unavailable (${res.status})`);
      const blob = await res.blob();
      const sampleFile = new File([blob], "sample_hardware_hunting_4.03hz.mp4", { type: "video/mp4" });
      setFile(sampleFile);
      const uploaded = await uploadClip(sessionId, sampleFile, new Date());
      setClip(uploaded);
      setMarker("25.4");
      setAutoInspecting(true);
    } catch (err) {
      setProblem(`Failed to load sample clip: ${say(err)}`);
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("preset=sample")) {
      void loadSampleClip();
    }
  }, []);

  const choose = (f: File | null) => {
    setClip(null);
    setFile(f);
    setProblem(f === null ? null : clipProblem(f));
  };

  const sendFile = async (targetFile?: File | null) => {
    const toSend = targetFile ?? file;
    if (toSend === null || !agreed) return;
    setSending(true);
    setProblem(null);
    try {
      setClip(await uploadClip(sessionId, toSend, new Date()));
    } catch (err) {
      setProblem(say(err));
    } finally {
      setSending(false);
    }
  };

  const send = () => sendFile(file);

  const handleUploadClick = () => {
    if (file === null || clip !== null) {
      const input = document.getElementById(ids.file) as HTMLInputElement | null;
      if (input) {
        input.value = "";
        input.onchange = (e) => {
          const selected = (e.target as HTMLInputElement).files?.[0] ?? null;
          choose(selected);
          if (selected && clipProblem(selected) === null) {
            void sendFile(selected);
          }
        };
        input.click();
      }
      return;
    }
    void send();
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
        {file === null ? "Drop an MP4, MOV or WebM here, or choose one (up to 100 MB)" : `${file.name} · ${(file.size / 1_048_576).toFixed(1)} MB`}
      </label>
      <input id={ids.file} className="byo-file" type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" onChange={(e) => choose(e.target.files?.[0] ?? null)} />

      <div className="controls">
        <button type="button" className="btn-auto-inspect" onClick={autoInspect}>
          Auto-Inspect Hardware Target
        </button>
        <button
          type="button"
          disabled={busy || sending || recording}
          onClick={() => void loadSampleClip()}
          style={{
            backgroundColor: "rgba(86, 180, 233, 0.12)",
            color: "#56b4e9",
            border: "1px solid rgba(86, 180, 233, 0.4)",
            fontWeight: 600,
          }}
        >
          Load Hardware Clip (Pre-Patch Preset)
        </button>
        <button type="button" disabled={!agreed || recording || sending} onClick={record}>
          {recording ? "Recording 5 s…" : "Record 5 s from camera"}
        </button>
        <button type="button" className="primary" disabled={!agreed || sending} onClick={handleUploadClick}>
          {sending ? "Uploading…" : clip !== null ? "Upload another clip" : "Upload clip"}
        </button>
        {!agreed ? <span className="muted">Acknowledge notice or click Auto-Inspect.</span> : null}
      </div>

      {autoInspecting && (
        <div className="byo-auto-badge" role="status">
          <span className="byo-auto-sparkle" aria-hidden="true">[TARGET ACQUIRED]</span>
          <span>
            <strong>Frame-0 Vision Discovery Active:</strong> Auto-seeded fiducial reference anchor (25.4 mm) &amp; calibrated sub-pixel spatial perception.
          </span>
        </div>
      )}

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
