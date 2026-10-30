"""ffmpeg pipe with the DESIGN §11.3 normalization profile, pinned for reproducible bytes (§20.5)."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np


def ffmpeg_bin() -> str:
    exe = shutil.which("ffmpeg")
    if exe is None:
        raise RuntimeError("ffmpeg not found on PATH")
    return exe


def ffmpeg_version() -> str:
    out = subprocess.run([ffmpeg_bin(), "-version"], capture_output=True, text=True, check=True)
    return out.stdout.splitlines()[0]


def encode_args(width: int, height: int, fps: int, out: Path) -> list[str]:
    return [
        ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
        "-an", "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-preset", "veryfast", "-crf", "20", "-threads", "1", "-x264-params", "threads=1",
        "-fps_mode", "cfr", "-r", str(fps),
        "-movflags", "+faststart", "-map_metadata", "-1",
        "-fflags", "+bitexact", "-flags:v", "+bitexact",
        "-f", "mp4", str(out),
    ]


class FfmpegWriter:
    """Writes bgr24 frames to an MP4. The final file appears only on a clean close."""

    def __init__(self, out: Path, width: int, height: int, fps: int) -> None:
        self.out = Path(out)
        self.partial = self.out.with_suffix(self.out.suffix + ".partial")
        self.args = encode_args(width, height, fps, self.partial)
        self.shape = (height, width, 3)
        self.proc = subprocess.Popen(self.args, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    @property
    def command_line(self) -> str:
        return " ".join(a if " " not in a else f'"{a}"' for a in self.args[1:])

    def write(self, frame: np.ndarray) -> None:
        if frame.shape != self.shape or frame.dtype != np.uint8:
            raise ValueError(f"frame must be uint8 {self.shape}, got {frame.dtype} {frame.shape}")
        assert self.proc.stdin is not None
        self.proc.stdin.write(np.ascontiguousarray(frame).data)

    def close(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()
        err = self.proc.stderr.read().decode(errors="replace") if self.proc.stderr else ""
        if self.proc.wait() != 0:
            self.partial.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg failed: {err.strip()}")
        self.partial.replace(self.out)

    def abort(self) -> None:
        self.proc.kill()
        self.proc.wait()
        self.partial.unlink(missing_ok=True)
