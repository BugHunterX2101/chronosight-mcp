"use client";

import { useEffect, useRef } from "react";
import { decodeRaster, type MaskFile, type MaskRecord } from "../lib/replay/csmk.ts";

// Compositor (DESIGN §10, §25): the verified clip underneath, SAM mask fills at 35% alpha with an
// outline and a text chip per track on a canvas above it. The canvas is the frame's own size so the
// masks' frame-pixel boxes need no scaling math; CSS scales both layers together.

// Okabe–Ito object tokens by concept index.
const TRACK_RGB: [number, number, number][] = [
  [0x56, 0xb4, 0xe9],
  [0x00, 0x72, 0xb2],
  [0xcc, 0x79, 0xa7],
  [0xf0, 0xe4, 0x42],
];
const rgb = (i: number) => TRACK_RGB[i % TRACK_RGB.length]!;

interface Props {
  src: string | null;
  masks: MaskFile | null;
  concepts: { slug: string; role: string }[];
  playing: boolean;
  /** Called once with the performance.now() of the first frame that drew a mask. */
  onFirstMask: (at: number) => void;
}

export function VideoStage({ src, masks, concepts, playing, onFirstMask }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fills = useRef(new WeakMap<MaskRecord, HTMLCanvasElement>());
  const first = useRef(false);
  const notify = useRef(onFirstMask);
  notify.current = onFirstMask;

  useEffect(() => {
    const v = video.current;
    if (v === null || src === null) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing, src]);

  useEffect(() => {
    const v = video.current;
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (v === null || c === null || !ctx || masks === null) return;
    first.current = false;

    const fillFor = (rec: MaskRecord): HTMLCanvasElement => {
      const hit = fills.current.get(rec);
      if (hit !== undefined) return hit;
      const raster = decodeRaster(rec);
      const tile = document.createElement("canvas");
      tile.width = rec.w;
      tile.height = rec.h;
      const t = tile.getContext("2d")!;
      const img = t.createImageData(rec.w, rec.h);
      const [r, g, b] = rgb(rec.conceptIdx);
      for (let i = 0; i < raster.length; i++) {
        if (raster[i] === 1) {
          img.data[i * 4] = r;
          img.data[i * 4 + 1] = g;
          img.data[i * 4 + 2] = b;
          img.data[i * 4 + 3] = Math.round(0.35 * 255);
        }
      }
      t.putImageData(img, 0, 0);
      fills.current.set(rec, tile);
      return tile;
    };

    const draw = (mediaTime: number) => {
      ctx.clearRect(0, 0, c.width, c.height);
      const frame = Math.min(Math.round(mediaTime * masks.fps), Math.max(...masks.byFrame.keys()));
      const records = masks.byFrame.get(frame) ?? [];
      ctx.font = "600 18px system-ui, sans-serif";
      ctx.textBaseline = "top";
      for (const rec of records) {
        const [x1, y1, x2, y2] = rec.box;
        const [r, g, b] = rgb(rec.conceptIdx);
        ctx.drawImage(fillFor(rec), x1, y1, x2 - x1, y2 - y1);
        ctx.strokeStyle = `rgb(${r} ${g} ${b})`;
        ctx.lineWidth = 3;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        const slug = concepts[rec.conceptIdx]?.slug ?? `concept ${rec.conceptIdx}`;
        const label = `${slug} #${rec.objectId} ${Math.round(rec.conf * 100)}%`;
        const w = ctx.measureText(label).width + 12;
        ctx.fillStyle = "#0b0d10";
        ctx.fillRect(x1, Math.max(0, y1 - 26), w, 26);
        ctx.fillStyle = `rgb(${r} ${g} ${b})`;
        ctx.fillText(label, x1 + 6, Math.max(0, y1 - 26) + 4);
      }
      if (records.length > 0 && !first.current) {
        first.current = true;
        notify.current(performance.now());
      }
    };

    let handle = 0;
    let alive = true;
    const loop = (_now: number, meta?: VideoFrameCallbackMetadata) => {
      if (!alive) return;
      draw(meta?.mediaTime ?? v.currentTime);
      handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(loop) : requestAnimationFrame((t) => loop(t));
    };
    const once = () => draw(v.currentTime);
    v.addEventListener("loadeddata", once);
    v.addEventListener("seeked", once);
    v.addEventListener("pause", once);
    if (v.readyState >= 2) once();
    handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(loop) : requestAnimationFrame((t) => loop(t));
    return () => {
      alive = false;
      v.removeEventListener("loadeddata", once);
      v.removeEventListener("seeked", once);
      v.removeEventListener("pause", once);
      if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
    };
  }, [masks, concepts, src]);

  return (
    <div className="stage">
      {src !== null ? <video ref={video} className="stage-video" src={src} muted loop playsInline preload="auto" aria-label="Rendered clip" /> : <div className="stage-video stage-empty">Waiting for the clip…</div>}
      <canvas ref={canvas} className="stage-overlay" width={masks?.frameW ?? 1280} height={masks?.frameH ?? 720} aria-hidden="true" />
    </div>
  );
}
