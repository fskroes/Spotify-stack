/**
 * Read the final `result` envelope from `claude --output-format json` stdout.
 * A SessionStart hook or CLI notice can prepend its own output, so stdout is not
 * reliably one JSON value. Scan valid JSON lines from the end instead.
 */
export function extractCliEnvelope(stdout: string): Record<string, unknown> {
  const envelopes: unknown[] = [];
  try {
    envelopes.push(JSON.parse(stdout));
  } catch {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        envelopes.push(JSON.parse(trimmed));
      } catch {
        // Plain-text preamble — not the envelope we need.
      }
    }
  }

  for (let i = envelopes.length - 1; i >= 0; i--) {
    const envelope = envelopes[i];
    if (envelope && typeof envelope === "object" && typeof (envelope as { result?: unknown }).result === "string") {
      return envelope as Record<string, unknown>;
    }
  }
  throw new Error(`cli: no JSON result envelope in claude output: ${stdout.slice(0, 500)}`);
}

export function extractCliResult(stdout: string): string {
  return extractCliEnvelope(stdout).result as string;
}
