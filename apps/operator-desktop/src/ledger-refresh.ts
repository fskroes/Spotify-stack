interface CompletedRunRevision {
  runId?: string;
  ts: string;
  task: string;
  repo: string;
  status: string;
}

interface InflightRunRevision {
  runId: string;
  stage: string;
  pass: number;
  stageSince: string;
}

export function fleetRevision(
  completed: CompletedRunRevision[],
  inflight: InflightRunRevision[],
): string {
  return JSON.stringify({
    completed: completed.map(({ runId, ts, task, repo, status }) => ({ runId, ts, task, repo, status })),
    inflight: inflight.map(({ runId, stage, pass, stageSince }) => ({ runId, stage, pass, stageSince })),
  });
}

export function ledgerRefreshDecision(previousRevision: string, nextRevision: string): boolean {
  return previousRevision !== "" && previousRevision !== nextRevision;
}

export function refreshedLedgerUrl(baseUrl: string, token: number): string {
  const url = new URL(baseUrl);
  url.searchParams.set("fleet-refresh", String(token));
  return url.toString();
}
