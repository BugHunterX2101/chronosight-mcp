"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { createSession, listScenarios, startPerceive } from "../lib/session/api.ts";
import { findModelContext, refusal, registerTools, type ToolHost } from "../lib/webmcp/tools.ts";

// Registers the page's WebMCP tools when the browser has the API and renders nothing either way (FR-MCP-2). The
// host is read through a ref, so the tools are registered once and always see the page as it is now.
export function WebMcpTools({ host }: { host: ToolHost }) {
  const latest = useRef(host);
  latest.current = host;
  useEffect(() => {
    const proxy: ToolHost = {
      view: () => latest.current.view(),
      startInspection: (s) => latest.current.startInspection(s),
      openApproval: () => latest.current.openApproval(),
      runVisualTest: () => latest.current.runVisualTest(),
      report: () => latest.current.report(),
    };
    return registerTools(findModelContext(document, navigator), proxy) ?? undefined;
  }, []);
  return null;
}

// On the home page there is no session yet: the agent can open one and start it, and the workbench takes over.
export function HomeWebMcp() {
  const router = useRouter();
  const host = useMemo<ToolHost>(
    () => ({
      view: () => ({ sessionOpen: false, scenario: null, mode: null, run: undefined, canRunVisualTest: false }),
      startInspection: async (scenario) => {
        const id = scenario ?? (await listScenarios())[0]?.id;
        if (id === undefined) throw refusal("NOT_FOUND", "no scenarios are configured");
        const { sessionId } = await createSession(id, "live");
        const { runId } = await startPerceive(sessionId);
        router.push(`/s/${sessionId}`);
        return { sessionId, runId };
      },
      openApproval: () => null,
      runVisualTest: async () => {
        throw refusal("NO_SESSION", "open an inspection first");
      },
      report: async () => {
        throw refusal("NO_SESSION", "open an inspection first");
      },
    }),
    [router],
  );
  return <WebMcpTools host={host} />;
}
