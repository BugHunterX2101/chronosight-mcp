from __future__ import annotations

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

from .encode import FfmpegWriter, ffmpeg_version


def render_clip(trace, scenario_id: str, seed: int, out_dir: Path, name: str,
                duration_s: float, fps: int, meta: dict | None = None) -> dict:
    width, height = 1280, 720
    frames = max(1, int(round(duration_s * fps)))
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    clip = out_dir / f"{name}.mp4"
    writer = FfmpegWriter(clip, width, height, fps)
    hasher = hashlib.sha256()
    gt_frames = []
    try:
        for k in range(frames):
            i = min(len(trace.t) - 1, int(round((k / fps + max(0.0, -float(trace.t[0]))) / trace.dt)))
            frame = np.full((height, width, 3), (38, 42, 48), dtype=np.uint8)
            if scenario_id == "s2":
                cv2.rectangle(frame, (120, 120), (700, 600), (70, 76, 84), -1)
                temp = float(trace.temp_c[i])
                area = float(trace.hotspot_area[i])
                radius = int(np.clip(np.sqrt(area / np.pi), 20, 180))
                cv2.circle(frame, (430, 340), radius, (30, 50, 220), -1)
                cv2.putText(frame, "SIMULATED IR", (760, 150), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (220, 220, 220), 2)
                cv2.putText(frame, f"temperature {temp:.1f} C", (760, 210), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (220, 220, 220), 2)
                led = str(trace.led_code[i])
                cv2.circle(frame, (220, 210), 18, (0, 0, 255) if led == "3-long" else (0, 220, 0), -1)
                cv2.putText(frame, led, (260, 220), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (240, 240, 240), 2)
                fan = float(trace.fan_rpm[i])
                cv2.ellipse(frame, (500, 300), (95, 95), fan * 0.2, 0, 360, (180, 180, 190), 3)
            else:
                pos = float(trace.position_mm[i])
                vib = float(trace.vibration_mm[i])
                cv2.rectangle(frame, (100, 300), (1180, 390), (110, 110, 118), -1)
                x = int(np.clip(100 + pos * 3.0, 100, 1180))
                cv2.rectangle(frame, (x - 45, 270), (x + 45, 420), (180, 100, 40), -1)
                cv2.line(frame, (100 + 300 * 3, 240), (100 + 300 * 3, 460), (0, 220, 0), 3)
                cv2.putText(frame, f"position {pos:.2f} mm", (100, 160), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (240, 240, 240), 2)
                cv2.putText(frame, f"vibration {abs(vib):.3f}", (100, 210), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (240, 240, 240), 2)
            hasher.update(frame.tobytes())
            writer.write(frame)
            gt_frames.append({"frame": k, "t": round(k / fps, 6), "q": float(trace.q[i])})
        writer.close()
    except BaseException:
        writer.abort()
        raise
    metrics: dict[str, object]
    if scenario_id == "s2":
        metrics = {"ledCode": str(trace.led_code[-1]), "hotspotArea": float(trace.hotspot_area[-1]),
                   "fanRpm": float(trace.fan_rpm[-1])}
    else:
        metrics = {"positionErrorMm": float(trace.q_ref[-1] - trace.position_mm[-1]),
                   "vibrationRms": float(np.sqrt(np.mean(np.square(trace.vibration_mm))))}
    gt = {"version": 1, "renderer": f"{scenario_id}-render/1", "ffmpeg": ffmpeg_version(),
          "encodeCommand": writer.command_line, "width": width, "height": height, "fps": fps,
          "frames": frames, "mmPerPx": 0.5, "rawFramesSha256": hasher.hexdigest(),
          "meta": {**(meta or {}), "syntheticIr": scenario_id == "s2"},
          "scenarioMetrics": metrics, "framesGt": gt_frames}
    gt_path = out_dir / f"{name}.gt.json"
    gt_path.write_text(json.dumps(gt, separators=(",", ":")), encoding="utf-8")
    return {"clipPath": str(clip), "groundTruthPath": str(gt_path), "frames": frames, "fps": fps,
            "rawFramesSha256": gt["rawFramesSha256"]}
