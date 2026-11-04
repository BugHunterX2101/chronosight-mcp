import type { Metadata } from "next";

export const metadata: Metadata = { title: "About · Chronosight" };

// Static (DESIGN §25.1). It describes what the product does today; it carries no validation tables.
// Measured figures are shown where they were measured: in each run's visual test and audit report.
export default function AboutPage() {
  return (
    <main id="main" className="shell light">
      <h1>About ChronoSight</h1>
      <p>
        ChronoSight inspects dynamic industrial robotics and precision kinematic machinery in real time from dynamic visual telemetry. It detects anomalous micro-vibrations, performs sub-pixel spatial tracking, isolates the root cause using grounded multi-lane reasoning, executes automated parameter remediation in a deterministic physics sandbox, and verifies mechanical stability against ISO 10816-3 vibration severity standards.
      </p>

      <h2>The Autonomous Visual Inspection Loop</h2>
      <ol>
        <li><strong>Dynamic Telemetry Acquisition:</strong> High-precision dynamic telemetry captures the machine kinematics and records high-frequency optical motion and sensor signals.</li>
        <li><strong>Sub-Pixel Spatial Perception:</strong> Meta SAM 3.1 zero-shot visual segmentation isolates component geometries. Frame-by-frame tracking extracts displacement trajectories, followed by Lomb-Scargle Periodogram (PSD) spectral decomposition to identify dominant resonance peaks (f*).</li>
        <li><strong>Grounded Causal Diagnosis:</strong> Dual-lane reasoning models formulate ranked physical hypotheses. Every proposed mechanism is strictly grounded with verbatim citations from verified technical specifications and datasheets.</li>
        <li><strong>Independent Safety Review:</strong> An adversarial safety auditor analyzes the proposed intervention against parameter bounds, structural limits, and collision hazards before presenting a two-step cryptographic approval gate.</li>
        <li><strong>Sandboxed Remediation:</strong> A verified patch is executed within an isolated parameter sandbox adhering to strict operational envelopes.</li>
        <li><strong>Empirical Verification:</strong> Post-repair physical telemetry is captured and evaluated across six quantitative criteria: spatial coverage (&ge;90%), vibration amplitude reduction (&ge;70%), absolute RMS ceiling (&le;0.50 mm), spectral resonance attenuation (&ge;10 dB), no harmonic spillover (&le;6 dB), and tracking confidence.</li>
      </ol>

      <h2>Empirical Telemetry, Vision Models &amp; Cryptographic Verification</h2>
      <ul>
        <li><strong>Empirical Physics &amp; Telemetry:</strong> Multibody dynamic kinematics simulate high-fidelity industrial robot physics with non-linear joint compliance and realistic sensor noise.</li>
        <li><strong>Production AI Architecture:</strong> Meta SAM 3.1 provides sub-pixel optical flow segmentation. Reasoning lanes utilize temperature-zero deterministic model execution with verbatim document grounding.</li>
        <li><strong>Cryptographic Proof of Execution:</strong> Every run generates an immutable, linearly chained W3C PROV SHA-256 audit log. Replay bundles are cryptographically verified byte-by-byte in the client browser before playback.</li>
        <li><strong>Real-Time Spectral Analysis:</strong> Power Spectral Density (PSD) analysis computes frequency band power across 0.5 to 30 Hz to detect harmonic resonance and mechanical looseness.</li>
      </ul>

      <h2>Safety Architecture &amp; Data Governance</h2>
      <ul>
        <li><strong>Dual-Gated Operator Authorization:</strong> No remediation can be deployed without explicit, two-factor operator sign-off bound to the exact patch specification SHA-256 digest.</li>
        <li><strong>Compute Budget Safeguards:</strong> Real-time GPU workloads are protected by visitor quotas and daily budget circuit breakers to guarantee continuous availability.</li>
        <li><strong>Zero-Trust Credential Security:</strong> Model API keys and credentials reside exclusively in the hardened backend gateway; client browsers interface strictly via scoped session cookies.</li>
        <li>
          <strong>Field Telemetry Ingestion (BYO):</strong> Dedicated edge media processors allow operators to submit field MP4/MOV recordings (up to 100 MB). The video is parsed, measured, and diagnosed with zero persistence—temporary buffers are wiped on session termination.
        </li>
        <li><strong>Deterministic Evaluation:</strong> Hosted instances provide instant replay of verified inspection runs with identical telemetry fidelity and full audit trails.</li>
      </ul>

      <h2>Hackathon Provenance</h2>
      <p>
        The ChronoSight application code and the ENCX-14 engineering knowledge corpus were authored for this project during the October 26–November 4, 2026 hackathon window. This covers project-authored material in the web app, run model, gateway, media worker, sandbox launcher, sandbox, and corpus; it does not claim ownership of third-party dependencies, SDKs, models, container images, or service infrastructure.
      </p>

      <p>
        <a href="/">Back to the inspection station</a>
      </p>
    </main>
  );
}
