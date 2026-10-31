import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { GATEWAY_ORIGIN } from "../../../lib/config.ts";

export const metadata: Metadata = { title: "Audit report · Chronosight" };

interface Span {
  name: string;
  startedAt: string;
  ms: number | null;
  wait: boolean;
}

interface RunReport {
  runId: string;
  state: string;
  startedAt: string;
  endedAt: string | null;
  totalMs: number | null;
  machineMs: number | null;
  spans: Span[];
  diagnoses: { diagnosisId: string; lane: string; patchSpecHash: string }[];
  approvals: { step: number; channel: string; at: string }[];
  verdict: { verdict?: string } | null;
  runUsd: number | null;
  errors: { code: string; message: string; stage: string }[];
}

interface Report {
  sessionId: string;
  scenarioId: string;
  generatedAt: string;
  audit: { lines: number; headHash: string; chainOk: boolean; brokenAt?: number; reason?: string };
  runs: RunReport[];
}

const secs = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

// Server-rendered from the gateway's report endpoint (DESIGN §25.1). The cs_sid cookie the gateway
// set is forwarded as-is; the page never holds it beyond this request.
export default async function ReportPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  if (!/^ses_[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId)) notFound();
  const sid = (await cookies()).get("cs_sid")?.value;
  if (sid === undefined) notFound();

  const res = await fetch(`${GATEWAY_ORIGIN}/api/sessions/${sessionId}/report`, { headers: { cookie: `cs_sid=${sid}` }, cache: "no-store" });
  if (res.status === 404) notFound();
  if (!res.ok) {
    return (
      <main id="main" className="shell light">
        <div role="alert" className="alert">
          <h1>The report could not be built</h1>
          <p>The gateway answered {res.status}. Try again in a moment.</p>
        </div>
      </main>
    );
  }
  const report = (await res.json()) as Report;

  return (
    <main id="main" className="shell light report">
      <h1>Audit report</h1>
      <p>
        Session <code>{report.sessionId}</code> · scenario {report.scenarioId} · generated <time dateTime={report.generatedAt}>{report.generatedAt}</time>
      </p>
      <p role="status" className={report.audit.chainOk ? "verdict pass" : "verdict fail"}>
        {report.audit.chainOk ? "✓ Audit chain intact" : `✕ Audit chain broken at line ${report.audit.brokenAt ?? "?"}${report.audit.reason ? ` (${report.audit.reason})` : ""}`}
      </p>
      <p className="muted">
        {report.audit.lines} audit lines · head hash <code>{report.audit.headHash}</code>
      </p>

      {report.runs.length === 0 ? <p className="muted">No run was started in this session.</p> : null}
      {report.runs.map((r) => (
        <section key={r.runId} className="panel" aria-labelledby={`h-${r.runId}`}>
          <h2 id={`h-${r.runId}`}>
            Run <code>{r.runId}</code> · {r.state}
          </h2>
          <p>
            Total {secs(r.totalMs)} · machine time {secs(r.machineMs)} (approval waits excluded) · cost {r.runUsd === null ? "n/a" : `$${r.runUsd.toFixed(3)}`}
            {r.verdict?.verdict ? ` · visual test ${r.verdict.verdict}` : ""}
          </p>
          <table className="criteria">
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col">Entered</th>
                <th scope="col">Duration</th>
              </tr>
            </thead>
            <tbody>
              {r.spans.map((s, i) => (
                <tr key={`${s.name}-${i}`}>
                  <th scope="row">
                    {s.name}
                    {s.wait ? " (human wait)" : ""}
                  </th>
                  <td>{s.startedAt}</td>
                  <td>{secs(s.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.diagnoses.length > 0 ? (
            <>
              <h3>Diagnoses</h3>
              <ul>
                {r.diagnoses.map((d) => (
                  <li key={d.diagnosisId}>
                    <code>{d.diagnosisId}</code> · lane {d.lane} · patch spec <code>{d.patchSpecHash.slice(0, 16)}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {r.approvals.length > 0 ? (
            <>
              <h3>Approvals</h3>
              <ul>
                {r.approvals.map((a) => (
                  <li key={a.step}>
                    Step {a.step} via {a.channel} at {a.at}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {r.errors.length > 0 ? (
            <>
              <h3>Errors</h3>
              <ul>
                {r.errors.map((e, i) => (
                  <li key={i}>
                    {e.code} ({e.stage}): {e.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ))}
      <p className="muted no-print">
        <a href={`/s/${report.sessionId}`}>Back to the workbench</a> · print this page to save it
      </p>
    </main>
  );
}
