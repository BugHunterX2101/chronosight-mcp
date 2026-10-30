"""S1 renderer: side view of the arm, forearm hunting about the elbow (DESIGN §20.3).

Layers, bottom to top: textured wall and bench, base, upper arm and markers (static,
drawn once), the forearm and gripper (alpha from `subframes` motion-blur samples), the
elbow cap. Then the slow lighting drift, the camera shake (a subpixel translation of
the whole frame, so markers move with it) and Gaussian sensor noise.

Ground truth comes from the same alpha the frame is composited from, so it is exact
for this renderer: centroids use pixel centres at (i + 0.5, j + 0.5), like twin/metrics.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from scipy.signal import lombscargle

from .encode import FfmpegWriter, ffmpeg_version

RENDERER_VERSION = "s1-render/1"
SCENE_TEXTURE_SEED = 20261027        # the scene itself is fixed, runs vary only by run seed

# Scene geometry, px (1280x720, 0.5 mm/px)
SHOULDER = (330.0, 520.0)
ELBOW = (560.0, 300.0)
ELBOW_R = 40.0
UPPER_W = 72.0
FOREARM_START, FOREARM_END, FOREARM_W = 30.0, 390.0, 64.0
THETA0 = math.radians(-10.0)
MARKER_A = (120, 610)                # top-left corner, px; side = sizeMm / mmPerPx
MARKER_B = (1060, 610)
ROI = (480, 120, 1060, 420)          # x0, y0, x1, y1: everything the forearm and gripper can reach

# BGR colours
ORANGE = np.array([38, 128, 236], np.float32)
ORANGE_DARK = np.array([24, 92, 180], np.float32)
GRIPPER = np.array([58, 58, 64], np.float32)
ELBOW_COL = (52, 52, 58)
ARM_COL = (168, 166, 160)

SHIFT = 4
ONE = 1 << SHIFT


@dataclass(frozen=True)
class Camera:
    width: int = 1280
    height: int = 720
    mm_per_px: float = 0.5
    shake_px: float = 0.6
    sensor_noise_dn: float = 2.0
    subframes: int = 3
    fps: int = 30
    marker_mm: float = 40.0

    @classmethod
    def from_scenario(cls, sc: dict) -> "Camera":
        c = sc["camera"]
        return cls(width=c["width"], height=c["height"], mm_per_px=c["mmPerPx"], shake_px=c["shakePx"],
                   sensor_noise_dn=c["sensorNoiseDn"], subframes=c["subframes"], fps=sc["fps"],
                   marker_mm=sc["markers"]["sizeMm"])


def _pts(points) -> np.ndarray:
    return np.round(np.asarray(points, np.float64) * ONE).astype(np.int32).reshape(-1, 1, 2)


def _rect(origin, d, n, a0, a1, half_w, off=(0.0, 0.0)):
    ox, oy = origin[0] - off[0], origin[1] - off[1]
    return _pts([(ox + d[0] * a + n[0] * w, oy + d[1] * a + n[1] * w)
                 for a, w in ((a0, -half_w), (a1, -half_w), (a1, half_w), (a0, half_w))])


def forearm_polys(q: float, off=(0.0, 0.0)):
    """Polygons (fixed-point, `SHIFT` bits) for the forearm body, its centre channel and the gripper."""
    th = THETA0 + q
    d = (math.cos(th), math.sin(th))
    n = (-d[1], d[0])
    body = _rect(ELBOW, d, n, FOREARM_START, FOREARM_END, FOREARM_W / 2, off)
    channel = _rect(ELBOW, d, n, FOREARM_START + 70, FOREARM_END - 24, 7.0, off)
    finger_l = (off[0] - n[0] * 30, off[1] - n[1] * 30)
    finger_r = (off[0] + n[0] * 30, off[1] + n[1] * 30)
    grip = [_rect(ELBOW, d, n, FOREARM_END, FOREARM_END + 18, 40.0, off),
            _rect(ELBOW, d, n, FOREARM_END + 18, FOREARM_END + 58, 6.0, finger_l),
            _rect(ELBOW, d, n, FOREARM_END + 18, FOREARM_END + 58, 6.0, finger_r)]
    return body, channel, grip


def _smooth_noise(rng, h, w, scale, amp):
    small = rng.normal(0.0, 1.0, (max(2, h // scale), max(2, w // scale))).astype(np.float32)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC) * amp


def build_static_scene(cam: Camera) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Static layers: (background, elbow-cap colour in the ROI, elbow-cap alpha in the ROI)."""
    rng = np.random.Generator(np.random.PCG64(SCENE_TEXTURE_SEED))
    h, w = cam.height, cam.width
    yy = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None]
    wall = 92.0 + 26.0 * (1.0 - yy) + _smooth_noise(rng, h, w, 48, 5.0) + _smooth_noise(rng, h, w, 6, 2.0)
    img = np.repeat(wall[:, :, None], 3, axis=2) * np.array([1.0, 0.98, 0.93], np.float32)
    bench_top = 588
    bh = h - bench_top
    streaks = np.repeat(_smooth_noise(rng, bh, 2, 1, 1.0)[:, :1], w, axis=1)
    bench = 118.0 + 9.0 * streaks + _smooth_noise(rng, bh, w, 10, 4.0) + _smooth_noise(rng, bh, w, 2, 2.0)
    img[bench_top:] = bench[:, :, None] * np.array([0.72, 0.86, 1.0], np.float32)
    img[bench_top:bench_top + 3] *= 0.6                              # bench edge shadow
    img = np.clip(img, 0, 255).astype(np.uint8)

    aa = cv2.LINE_AA
    cv2.fillPoly(img, [_pts([(260, 600), (400, 600), (384, 548), (276, 548)])], (70, 72, 78), aa, SHIFT)
    cv2.fillPoly(img, [_pts([(250, 604), (410, 604), (410, 590), (250, 590)])], (54, 56, 60), aa, SHIFT)
    sx, sy = SHOULDER
    ex, ey = ELBOW
    length = math.hypot(ex - sx, ey - sy)
    d = ((ex - sx) / length, (ey - sy) / length)
    n = (-d[1], d[0])
    cv2.fillPoly(img, [_rect(SHOULDER, d, n, 0.0, length, UPPER_W / 2)], ARM_COL, aa, SHIFT)
    cv2.fillPoly(img, [_rect(SHOULDER, d, n, 30.0, length - 40.0, 4.0, (n[0] * 18, n[1] * 18))],
                 (140, 138, 132), aa, SHIFT)
    cv2.circle(img, (int(sx * ONE), int(sy * ONE)), int(46 * ONE), (64, 64, 70), -1, aa, SHIFT)
    cv2.circle(img, (int(sx * ONE), int(sy * ONE)), int(18 * ONE), (110, 110, 116), -1, aa, SHIFT)

    side = int(round(cam.marker_mm / cam.mm_per_px))                 # 40 mm checkerboards, 4x4 cells
    cell = side // 4
    for mx, my in (MARKER_A, MARKER_B):
        for i in range(4):
            for j in range(4):
                v = 245 if (i + j) % 2 == 0 else 18
                img[my + i * cell: my + (i + 1) * cell, mx + j * cell: mx + (j + 1) * cell] = v

    x0, y0, x1, y1 = ROI
    c = (int((ex - x0) * ONE), int((ey - y0) * ONE))
    cap = np.zeros((y1 - y0, x1 - x0), np.uint8)
    cv2.circle(cap, c, int(ELBOW_R * ONE), 255, -1, aa, SHIFT)
    cap_col = np.zeros((y1 - y0, x1 - x0, 3), np.uint8)
    cap_col[:] = ELBOW_COL
    cv2.circle(cap_col, c, int(26 * ONE), (92, 92, 98), 3, aa, SHIFT)
    cv2.circle(cap_col, c, int(9 * ONE), (120, 120, 126), -1, aa, SHIFT)
    return img, cap_col.astype(np.float32), cap.astype(np.float32) / 255.0


def _layer_alpha(polys_per_sub, shape) -> np.ndarray:
    acc = np.zeros(shape, np.float32)
    m = np.zeros(shape, np.uint8)
    for polys in polys_per_sub:
        m[:] = 0
        cv2.fillPoly(m, polys, 255, cv2.LINE_AA, SHIFT)
        acc += m
    return acc / (255.0 * len(polys_per_sub))


def _ou(rng, n, sigma, tau_s, dt):
    """Stationary Ornstein-Uhlenbeck path, one value per frame."""
    a = math.exp(-dt / tau_s)
    s = sigma * math.sqrt(1.0 - a * a)
    x = np.empty(n)
    x[0] = rng.normal(0.0, sigma)
    for k in range(1, n):
        x[k] = a * x[k - 1] + rng.normal(0.0, s)
    return x


def _centroid(alpha: np.ndarray, x0: float, y0: float) -> tuple[float, float, float]:
    area = float(alpha.sum())
    cx = float(alpha.sum(axis=0) @ np.arange(alpha.shape[1])) / area + x0 + 0.5
    cy = float(alpha.sum(axis=1) @ np.arange(alpha.shape[0])) / area + y0 + 0.5
    return cx, cy, area


def _bbox(polys, shape, margin: int = 2) -> tuple[int, int, int, int]:
    pts = np.concatenate([p.reshape(-1, 2) for p in polys]) >> SHIFT
    bx0, by0 = (pts.min(axis=0) - margin).tolist()
    bx1, by1 = (pts.max(axis=0) + margin + 2).tolist()
    return max(0, bx0), max(0, by0), min(shape[1], bx1), min(shape[0], by1)


def _shifted(poly: np.ndarray, bx: int, by: int) -> np.ndarray:
    return poly - np.array([bx * ONE, by * ONE], np.int32)


def _blend(roi: np.ndarray, alpha: np.ndarray, colour: np.ndarray) -> np.ndarray:
    return cv2.blendLinear(colour, roi, alpha, 1.0 - alpha)


def render_clip(t_sim: np.ndarray, q_sim: np.ndarray, q_ref: float, cam: Camera,
                render_ss: np.random.SeedSequence, duration_s: float, out_dir: Path,
                name: str, meta: dict | None = None) -> dict:
    """Render `duration_s` of the trajectory to `<out_dir>/<name>.mp4` plus `<name>.gt.json`."""
    cv2.setNumThreads(1)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    shake_ss, light_ss, noise_ss = render_ss.spawn(3)
    n_frames = int(round(duration_s * cam.fps))
    dtf = 1.0 / cam.fps

    shake_rng = np.random.Generator(np.random.PCG64(shake_ss))
    shake = np.stack([_ou(shake_rng, n_frames, cam.shake_px, 0.4, dtf),
                      _ou(shake_rng, n_frames, cam.shake_px, 0.4, dtf)], axis=1)
    phase = np.random.Generator(np.random.PCG64(light_ss)).uniform(0.0, 2.0 * math.pi)
    noise_rng = np.random.Generator(np.random.PCG64(noise_ss))
    pad = 32
    bank = np.round(noise_rng.normal(0.0, cam.sensor_noise_dn, (2, cam.height + pad, cam.width + pad, 3)))
    bank_pos = np.clip(bank, 0, 255).astype(np.uint8)
    bank_neg = np.clip(-bank, 0, 255).astype(np.uint8)
    del bank
    picks = noise_rng.integers(0, [2, pad, pad], size=(n_frames, 3))

    bg, cap_col, cap_a = build_static_scene(cam)
    x0, y0, x1, y1 = ROI
    roi_shape = (y1 - y0, x1 - x0)
    off = (float(x0), float(y0))
    exposure = 0.5 * dtf
    sub_off = [(j + 0.5) / cam.subframes * exposure - exposure / 2 for j in range(cam.subframes)]

    plane_orange = np.empty(roi_shape + (3,), np.float32)
    plane_orange[:] = ORANGE
    plane_orange_dark = np.empty_like(plane_orange)
    plane_orange_dark[:] = ORANGE_DARK
    plane_grip = np.empty_like(plane_orange)
    plane_grip[:] = GRIPPER
    ex, ey = ELBOW[0] - x0, ELBOW[1] - y0
    cap_box = _pts([(ex - ELBOW_R, ey - ELBOW_R), (ex + ELBOW_R, ey + ELBOW_R)])

    body_c, _, _ = forearm_polys(q_ref, off)                          # commanded pose: no blur, no shake
    cmd_cx, cmd_cy, _ = _centroid(_layer_alpha([[body_c]], roi_shape) * (1.0 - cap_a), x0, y0)

    side = cam.marker_mm / cam.mm_per_px
    m_a = (MARKER_A[0] + side / 2, MARKER_A[1] + side / 2)
    m_b = (MARKER_B[0] + side / 2, MARKER_B[1] + side / 2)

    clip = out_dir / f"{name}.mp4"
    writer = FfmpegWriter(clip, cam.width, cam.height, cam.fps)
    hasher = hashlib.sha256()
    frames_gt = []
    try:
        for k in range(n_frames):
            tk = k * dtf
            qs = np.interp([tk + o for o in sub_off], t_sim, q_sim)
            polys = [forearm_polys(float(q), off) for q in qs]
            bx0, by0, bx1, by1 = _bbox([p[0] for p in polys] + [g for p in polys for g in p[2]] + [cap_box],
                                       roi_shape)
            box = (by1 - by0, bx1 - bx0)
            sh = [(_shifted(p[0], bx0, by0), _shifted(p[1], bx0, by0), [_shifted(g, bx0, by0) for g in p[2]])
                  for p in polys]
            a_body = _layer_alpha([[p[0]] for p in sh], box)
            a_chan = _layer_alpha([[p[1]] for p in sh], box)
            a_grip = _layer_alpha([p[2] for p in sh], box)
            c_a = cap_a[by0:by1, bx0:bx1]

            frame = bg.copy()
            sub = frame[y0 + by0:y0 + by1, x0 + bx0:x0 + bx1]
            roi = sub.astype(np.float32)
            roi = _blend(roi, a_body, plane_orange[:box[0], :box[1]])
            roi = _blend(roi, a_chan, plane_orange_dark[:box[0], :box[1]])
            roi = _blend(roi, a_grip, plane_grip[:box[0], :box[1]])
            roi = _blend(roi, c_a, cap_col[by0:by1, bx0:bx1])
            sub[:] = cv2.convertScaleAbs(roi)

            gain = 1.0 + 0.03 * math.sin(2.0 * math.pi * 0.11 * tk + phase)
            frame = cv2.convertScaleAbs(frame, alpha=gain)
            dx, dy = float(shake[k, 0]), float(shake[k, 1])
            m = np.array([[1.0, 0.0, dx], [0.0, 1.0, dy]])
            frame = cv2.warpAffine(frame, m, (cam.width, cam.height), flags=cv2.INTER_LINEAR,
                                   borderMode=cv2.BORDER_REFLECT)
            b, oy, ox = (int(v) for v in picks[k])
            sl = (b, slice(oy, oy + cam.height), slice(ox, ox + cam.width))
            frame = cv2.subtract(cv2.add(frame, bank_pos[sl]), bank_neg[sl])

            hasher.update(frame.tobytes())
            writer.write(frame)

            cx, cy, area = _centroid(a_body * (1.0 - c_a), x0 + bx0, y0 + by0)
            frames_gt.append({
                "frame": k, "t": round(tk, 6), "q": float(np.interp(tk, t_sim, q_sim)),
                "forearm": {"cx": cx + dx, "cy": cy + dy, "area": area},
                "markerA": {"cx": m_a[0] + dx, "cy": m_a[1] + dy, "area": side * side},
                "markerB": {"cx": m_b[0] + dx, "cy": m_b[1] + dy, "area": side * side},
                "commanded": {"cx": cmd_cx, "cy": cmd_cy},
                "shake": {"dx": dx, "dy": dy}, "gain": gain,
            })
        writer.close()
    except BaseException:
        writer.abort()
        raise

    cx = np.array([f["forearm"]["cx"] - f["shake"]["dx"] - cmd_cx for f in frames_gt])
    cy = np.array([f["forearm"]["cy"] - f["shake"]["dy"] - cmd_cy for f in frames_gt])
    amp_px = float(np.sqrt(np.mean((cx - cx.mean()) ** 2 + (cy - cy.mean()) ** 2)))
    tq = np.array([f["t"] for f in frames_gt])
    qv = np.array([f["q"] for f in frames_gt])
    grid = np.arange(0.5, 0.4 * cam.fps, 1.0 / (5.0 * (tq[-1] - tq[0])))
    pw = lombscargle(tq, qv - qv.mean(), 2.0 * np.pi * grid)
    gt = {
        "version": 1,
        "renderer": RENDERER_VERSION,
        "ffmpeg": ffmpeg_version(),
        "encodeCommand": writer.command_line,
        "width": cam.width, "height": cam.height, "fps": cam.fps, "frames": n_frames,
        "mmPerPx": cam.mm_per_px,
        "rawFramesSha256": hasher.hexdigest(),
        "trueAmplitudePx": amp_px,
        "trueAmplitudeMm": amp_px * cam.mm_per_px,
        "trueFStarHz": float(grid[int(np.argmax(pw))]),
        "meta": meta or {},
        "framesGt": frames_gt,
    }
    gt_path = out_dir / f"{name}.gt.json"
    gt_path.write_text(json.dumps(gt, separators=(",", ":")))
    return {"clipPath": str(clip), "groundTruthPath": str(gt_path), "frames": n_frames, "fps": cam.fps,
            "rawFramesSha256": gt["rawFramesSha256"]}
