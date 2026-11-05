# ChronoSight on Modal (Serverless & Cloud Sandbox)

This directory provides serverless deployment templates for running ChronoSight's **Digital Twin** and **Isolated Patch Sandbox** on [Modal](https://modal.com) using your Modal compute credits.

---

## Capabilities

1. **Serverless Digital Twin (`deploy/modal/app.py`):**
   - Runs the FastAPI twin simulation service with ffmpeg, OpenCV headless, NumPy, and SciPy.
   - Auto-scales from 0 to multiple concurrent workers with 5-minute warm standby (`scaledown_window=300`).
   - Offloads compute-heavy rendering and spectral analysis from local hardware or constrained free-tier servers.

2. **Cloud Patch Evaluation Sandbox (`deploy/modal/sandbox.py`):**
   - Implements PRD §15.3 and DL-22 cloud sandbox isolation.
   - Executes untrusted Python patches synthesized by Meta Muse Code inside ephemeral Modal micro-VMs without requiring a local Docker daemon socket.
   - Enforces 1 CPU, 512 MB RAM, AST import allowlisting, and 60-second execution deadlines.

---

## Setup & Deployment

### 1. Install & Authenticate Modal CLI

Run in your terminal:

```bash
pip install modal
python3 -m modal setup
```

This will authenticate your terminal against your Modal account (`veditagrawal21`).

### 2. Configure Environment Variables

Add your Modal API token to `.env.local`:

```bash
# Modal Partner Compute (PRD §15.3)
PARTNER_ENDPOINTS_ENABLED=true
MODAL_TOKEN_ID=your_modal_token_id
MODAL_TOKEN_SECRET=your_modal_token_secret
```

### 3. Deploy the Digital Twin

From the root of the `chronosight-mcp` repository:

```bash
modal deploy deploy/modal/app.py
```

Modal will output your live URL (e.g. `https://<workspace>--chronosight-twin-fastapi-app.modal.run`).

### 4. Deploy the Cloud Sandbox

```bash
modal deploy deploy/modal/sandbox.py
```

### 5. Point the Gateway to Modal

In `.env.local`, set:

```bash
TWIN_BASE_URL=https://<workspace>--chronosight-twin-fastapi-app.modal.run
```

The gateway orchestrator will immediately route all twin physics simulation, rendering, and visual unit test evaluations through Modal's high-performance cloud infrastructure.

