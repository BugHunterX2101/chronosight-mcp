"use client";

import type { RunView } from "@chronosight/run-model/browser";
import { useEffect, useRef, useState } from "react";

// Two-step approval (DESIGN §17.2, §25.5). Step 1 approves the scope; step 2 confirms the patch and
// its button sits in a different place, and ignores a click for 400 ms after it appears, matching the
// gateway's debounce. The dialog is a native <dialog>, so focus is trapped and Escape closes it
// without deciding anything.
const DEBOUNCE_MS = 400;

interface Props {
  run: RunView;
  busy: boolean;
  onApprove: (step: 1 | 2) => void;
  onReject: () => void;
  /** Bumped when something other than the person asks for the dialog (a WebMCP `request_approval`): it re-opens. */
  reviewTick?: number;
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function ApprovalDialog({ run, busy, onApprove, onReject, reviewTick = 0 }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const required = run.approval.required;
  const key = required === null ? "" : `${required.approvalId}:${required.step}`;
  // Both flags name the offer they apply to, so a new step starts disarmed and undismissed on its
  // very first render instead of inheriting the previous step's state for one frame.
  const [dismissedKey, setDismissedKey] = useState("");
  const [armedKey, setArmedKey] = useState("");
  const dismissed = dismissedKey === key;
  const armed = armedKey === key;

  useEffect(() => {
    if (reviewTick > 0) setDismissedKey("");
  }, [reviewTick]);

  useEffect(() => {
    if (key === "") return;
    const t = setTimeout(() => setArmedKey(key), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [key]);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (required !== null && !dismissed) {
      if (!d.open) d.showModal();
    } else if (d.open) {
      d.close();
    }
  }, [required, dismissed]);

  if (required === null) return null;
  const risk = run.approval.risk;
  const level = typeof risk?.risk_level === "string" ? risk.risk_level : run.diagnosis.final?.diagnosis.riskLevel ?? "unknown";
  const concerns = asStrings(risk?.concerns);
  const diagnosis = run.diagnosis.final?.diagnosis;
  const expires = new Date(required.expiresAt).toISOString().slice(11, 19);
  const step2 = required.step === 2;
  const canApprove = required.approveEnabled && !busy;

  return (
    <>
      {dismissed ? (
        <p role="status" className="banner">
          An approval is waiting for you.{" "}
          <button type="button" onClick={() => setDismissedKey("")}>
            Review approval
          </button>
        </p>
      ) : null}
      <dialog ref={ref} className="approval" aria-labelledby="ap-h" onCancel={() => setDismissedKey(key)}>
        <h2 id="ap-h">{step2 ? "Step 2 of 2: confirm the patch" : "Step 1 of 2: approve the scope"}</h2>
        <p>
          Risk <strong>{level}</strong> · expires {expires} UTC · spec hash <code>{required.patchSpecHash.slice(0, 12)}</code>
        </p>
        {diagnosis !== undefined ? (
          <p>
            Fix proposed for: <strong>{diagnosis.hypotheses[0]?.title ?? "the top hypothesis"}</strong>
          </p>
        ) : null}
        {concerns.length > 0 ? (
          <>
            <h3>Review concerns</h3>
            <ul>
              {concerns.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        ) : null}
        {diagnosis !== undefined && diagnosis.safetyPreconditions.length > 0 ? (
          <>
            <h3>Safety preconditions</h3>
            <ul>
              {diagnosis.safetyPreconditions.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        ) : null}
        {!required.approveEnabled ? <p role="alert">The safety review does not allow approval of this scope. Reject it, or ask again.</p> : null}
        <div className={step2 ? "approval-actions confirm" : "approval-actions"}>
          <button type="button" onClick={onReject} disabled={busy}>
            Reject
          </button>
          <button type="button" onClick={() => setDismissedKey(key)}>
            Decide later
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canApprove}
            aria-disabled={!canApprove || (step2 && !armed)}
            onClick={() => {
              if (step2 && !armed) return;
              onApprove(required.step);
            }}
          >
            {step2 ? "Confirm patch" : "Approve scope"}
          </button>
        </div>
      </dialog>
    </>
  );
}
