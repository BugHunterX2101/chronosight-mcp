"""Record one live SAM 3.1 stream into fixtures/sam/ (MOCK_META=record, TECHNICAL §10.3).

Usage: uv run --all-extras python tools/py/record_sam.py <clip.mp4> "<concept prompt>" <out-name>

The raw SSE bytes are written before anything parses them (DESIGN §12.4). Request
headers are never written.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    clip, concept, name = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    load_dotenv(ROOT / ".env.local")
    base = os.environ.get("META_API_BASE", "https://api.meta.ai/v1").rstrip("/")
    key = os.environ["META_API_KEY"]
    data = base64.b64encode(clip.read_bytes()).decode()
    body = {
        "model": "sam-3.1",
        "stream": True,
        "input": [{"role": "user", "content": [
            {"type": "input_text", "text": concept},
            {"type": "input_video", "video_url": f"data:video/mp4;base64,{data}"},
        ]}],
        "metadata": {"include_confidence": "true", "mask_encoding": "lossless"},
    }
    out = ROOT / "fixtures" / "sam" / f"{name}.sse"
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()
    marks: dict[str, float] = {}
    with httpx.Client(timeout=httpx.Timeout(120.0, connect=15.0)) as cx, \
            cx.stream("POST", f"{base}/responses", json=body,
                      headers={"Authorization": f"Bearer {key}", "Accept": "text/event-stream"}) as r:
        print("status", r.status_code, r.headers.get("content-type"))
        if r.status_code != 200:
            print(r.read().decode(errors="replace")[:2000])
            sys.exit(1)
        with open(out, "wb") as fh:
            for chunk in r.iter_raw():
                marks.setdefault("first_byte", time.monotonic() - t0)
                fh.write(chunk)
    marks["completed"] = time.monotonic() - t0
    print(json.dumps({"bytes": out.stat().st_size, **{k: round(v, 2) for k, v in marks.items()}}))


if __name__ == "__main__":
    main()
