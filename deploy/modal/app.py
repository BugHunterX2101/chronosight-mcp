"""ChronoSight Digital Twin - Serverless Modal Deployment (PRD §15.3, DESIGN §20.6).

Deploys the full physics simulation, OpenCV frame renderer, and visual unit test
engine as an auto-scaling serverless web service on Modal.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
import modal

# 1. Define Modal App
app = modal.App("chronosight-twin")

# 2. Build Container Image with system ffmpeg and exact Python dependencies
twin_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libgl1-mesa-glx", "libglib2.0-0")
    .pip_install(
        "numpy>=2.2.0",
        "scipy>=1.15.0",
        "opencv-python-headless>=4.10.0,<5",
        "pyyaml>=6.0",
        "msgpack>=1.0.0",
        "fastapi>=0.115.0",
        "uvicorn[standard]>=0.30.0",
        "httpx>=0.27.0",
        "rfc8785>=0.1.4",
        "python-dotenv>=1.0.0",
        "pydantic>=2.9.0",
        "meta-sam-parser>=0.1.0",
    )
    .add_local_dir("services/twin/twin", remote_path="/root/services/twin/twin")
    .add_local_dir("corpus", remote_path="/root/corpus")
)

# 3. Serverless ASGI Twin Endpoint
@app.function(
    image=twin_image,
    scaledown_window=300,        # Keep warm for 5 minutes between test evaluations
    allow_concurrent_inputs=10,  # Handle concurrent keyframe and telemetry requests
    timeout=180,                 # 3-minute max execution for long multi-object perception runs
)
@modal.asgi_app()
def fastapi_app():
    """Mounts the production FastAPI twin router."""
    sys.path.insert(0, "/root/services/twin")
    os.environ["DATA_DIR"] = "/tmp/chronosight/data"
    os.environ["CORPUS_DIR"] = "/root/corpus"
    os.makedirs("/tmp/chronosight/data", exist_ok=True)
    
    from twin.app.main import app as twin_api
    return twin_api
