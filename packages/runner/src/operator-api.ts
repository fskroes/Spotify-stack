/** Read-only HTTP surface consumed by the optional desktop operator shell. */
import { type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { REVIEW_ARTIFACTS } from "./artifacts.js";
import { readLiveInflight, type InflightRecord } from "./inflight.js";
import { readLedger, type LedgerEntry } from "./ledger.js";
import type { Cosign } from "./ledger-html.js";
import { loadTask } from "./task.js";

export const OPERATOR_API_PREFIX = "/api";

/** The served allowlist is exactly the per-run archive set. */
const SAFE_ARTIFACTS = REVIEW_ARTIFACTS;

export interface OperatorApiOptions {
  ledgerPath: string;
  controlRepo: string;
  artifactsRoot?: string;
  /**
   * Live PR co-sign state keyed by PR URL, when the serve was started with
   * polling (`--cosign`). Undefined = offline; the API then omits co-sign
   * fields entirely rather than serving an empty map that reads as "nothing
   * is merged".
   */
  getCosigns?: () => Record<string, Cosign>;
}

export interface ArtifactMetadata {
  name: string;
  size: number;
  modifiedAt: string;
  url: string;
  contentType: string;
}

export interface OperatorTask {
  id: string;
  title: string;
  targets: string[];
  risk: string;
}

export interface OperatorRepo {
  name: string;
  language: string;
  defaultBranch: string;
}

interface RepoFile {
  repos?: Array<{ name?: unknown; language?: unknown; default_branch?: unknown }>;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function decodeSegment(raw: string, label: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw new ApiError(400, `invalid ${label}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new ApiError(400, `invalid ${label}`);
  }
  return value;
}

function artifactDir(opts: OperatorApiOptions, task: string, repo: string): string {
  const root = path.resolve(opts.artifactsRoot ?? path.join(opts.controlRepo, "artifacts"));
  const candidate = path.resolve(root, task, repo);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new ApiError(400, "invalid artifact path");
  return candidate;
}

function checkedArtifact(
  opts: OperatorApiOptions,
  task: string,
  repo: string,
  name: string,
): { file: string; contentType: string } {
  const contentType = SAFE_ARTIFACTS.get(name);
  if (!contentType) throw new ApiError(404, "artifact not found");
  const root = path.resolve(opts.artifactsRoot ?? path.join(opts.controlRepo, "artifacts"));
  const file = path.join(artifactDir(opts, task, repo), name);

  let info;
  try {
    info = lstatSync(file);
  } catch {
    throw new ApiError(404, "artifact not found");
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new ApiError(404, "artifact not found");

  // lstat rejects a symlink at the file itself; realpath also rejects a symlink
  // in either parent directory that escapes the configured artifact root.
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const realFile = realpathSync(file);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
    throw new ApiError(404, "artifact not found");
  }
  return { file: realFile, contentType };
}

export function listArtifacts(
  opts: OperatorApiOptions,
  task: string,
  repo: string,
): ArtifactMetadata[] {
  const dir = artifactDir(opts, task, repo);
  let dirInfo;
  try {
    dirInfo = lstatSync(dir);
  } catch {
    throw new ApiError(404, "artifact set not found");
  }
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    throw new ApiError(404, "artifact set not found");
  }

  const taskPart = encodeURIComponent(task);
  const repoPart = encodeURIComponent(repo);
  const artifacts: ArtifactMetadata[] = [];
  for (const [name, contentType] of SAFE_ARTIFACTS) {
    try {
      const { file } = checkedArtifact(opts, task, repo, name);
      const stat = statSync(file);
      artifacts.push({
        name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        url: `${OPERATOR_API_PREFIX}/artifacts/${taskPart}/${repoPart}/${encodeURIComponent(name)}`,
        contentType,
      });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
  }
  return artifacts;
}

function taskCatalog(controlRepo: string): OperatorTask[] {
  const root = path.join(controlRepo, "tasks");
  const dirs = [root, path.join(root, "examples"), path.join(root, "onramp"), path.join(root, "private")];
  const tasks = new Map<string, OperatorTask>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files.sort()) {
      if (!name.endsWith(".md") || name === "README.md" || name === "TEMPLATE.md") continue;
      try {
        const task = loadTask(path.join(dir, name));
        tasks.set(task.id, { id: task.id, title: task.title, targets: task.targets, risk: task.risk });
      } catch {
        // A malformed task should fail dispatch when selected, not the read-only catalog.
      }
    }
  }
  return [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function repoCatalog(controlRepo: string): OperatorRepo[] {
  const files = [path.join(controlRepo, "fleet", "repos.yaml"), path.join(controlRepo, "fleet", "repos.local.yaml")];
  const repos = new Map<string, OperatorRepo>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    let parsed: RepoFile;
    try {
      parsed = YAML.parse(readFileSync(file, "utf8")) as RepoFile;
    } catch {
      continue;
    }
    for (const repo of parsed.repos ?? []) {
      if (typeof repo.name !== "string") continue;
      repos.set(repo.name, {
        name: repo.name,
        language: typeof repo.language === "string" ? repo.language : "unknown",
        defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "main",
      });
    }
  }
  return [...repos.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function entriesWithoutDuplicateInflight(
  entries: LedgerEntry[],
  inflight: InflightRecord[],
): InflightRecord[] {
  const completed = new Set(entries.flatMap((entry) => (entry.runId ? [entry.runId] : [])));
  return inflight.filter((record) => !completed.has(record.runId));
}

/**
 * Handle an operator API request. Returns false when the URL does not belong to
 * the API, allowing the caller to continue with HTML/SSE routing.
 */
export function handleOperatorApi(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OperatorApiOptions,
): boolean {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!parsed.pathname.startsWith(`${OPERATOR_API_PREFIX}/`)) return false;

  try {
    if (req.method !== "GET") throw new ApiError(405, "method not allowed");
    const segments = parsed.pathname.split("/").filter(Boolean);
    const entries = (): LedgerEntry[] => readLedger(opts.ledgerPath);

    if (segments.length === 2 && segments[1] === "ledger") {
      const daysRaw = parsed.searchParams.get("days");
      const days = daysRaw === null ? undefined : Number.parseInt(daysRaw, 10);
      if (daysRaw !== null && (!Number.isFinite(days) || (days as number) < 1 || (days as number) > 3650)) {
        throw new ApiError(400, "days must be between 1 and 3650");
      }
      const cutoff = days === undefined ? undefined : Date.now() - days * 86_400_000;
      const filtered = cutoff === undefined ? entries() : entries().filter((entry) => Date.parse(entry.ts) >= cutoff);
      json(res, 200, {
        generatedAt: new Date().toISOString(),
        entries: filtered,
        ...(opts.getCosigns ? { cosigns: opts.getCosigns() } : {}),
      });
      return true;
    }

    if (segments.length === 2 && segments[1] === "inflight") {
      const ledger = entries();
      const runs = entriesWithoutDuplicateInflight(ledger, readLiveInflight(opts.ledgerPath));
      json(res, 200, { generatedAt: new Date().toISOString(), runs });
      return true;
    }

    if (segments.length === 2 && segments[1] === "catalog") {
      json(res, 200, { tasks: taskCatalog(opts.controlRepo), repos: repoCatalog(opts.controlRepo) });
      return true;
    }

    if (segments.length === 3 && segments[1] === "runs") {
      const runId = decodeSegment(segments[2], "run id");
      const ledger = entries();
      const completed = ledger.find((entry) => entry.runId === runId);
      if (completed) {
        // The per-run archive (artifacts/runs/<runId>) is exact attribution:
        // those files can belong to no other run. To the artifact routes it is
        // just another task/repo pair, so its URLs need no new endpoints.
        let artifacts: ArtifactMetadata[] = [];
        let superseded = false;
        try {
          artifacts = listArtifacts(opts, "runs", runId);
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
        }
        if (artifacts.length === 0) {
          const hasInflightForTarget = entriesWithoutDuplicateInflight(ledger, readLiveInflight(opts.ledgerPath))
            .some((record) => record.task === completed.task && record.repo === completed.repo);
          const latestForTarget = ledger
            .filter((entry) => entry.task === completed.task && entry.repo === completed.repo)
            .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
          // The flat artifact set is latest-run-wins. Never attach a newer
          // run's files to an older ledger record merely because task and repo
          // happen to match.
          if (latestForTarget === completed && !hasInflightForTarget) {
            try {
              artifacts = listArtifacts(opts, completed.task, completed.repo);
            } catch (err) {
              if (!(err instanceof ApiError) || err.status !== 404) throw err;
            }
          } else if (completed.mode === "local") {
            // A local run that predates the per-run archive: a later run of
            // the same task replaced the shared set, so this run's evidence is
            // gone — say so instead of implying it never existed.
            superseded = true;
          }
        }
        const cosign = completed.prUrl && opts.getCosigns ? opts.getCosigns()[completed.prUrl] : undefined;
        json(res, 200, {
          state: "completed",
          run: completed,
          artifacts,
          ...(superseded ? { artifactsSuperseded: true } : {}),
          ...(cosign ? { cosign } : {}),
        });
        return true;
      }
      const live = entriesWithoutDuplicateInflight(ledger, readLiveInflight(opts.ledgerPath)).find(
        (record) => record.runId === runId,
      );
      if (!live) throw new ApiError(404, "run not found");
      json(res, 200, { state: "inflight", run: live, artifacts: [] });
      return true;
    }

    if (segments.length === 4 && segments[1] === "artifacts") {
      const task = decodeSegment(segments[2], "task");
      const repo = decodeSegment(segments[3], "repo");
      json(res, 200, { task, repo, artifacts: listArtifacts(opts, task, repo) });
      return true;
    }

    if (segments.length === 5 && segments[1] === "artifacts") {
      const task = decodeSegment(segments[2], "task");
      const repo = decodeSegment(segments[3], "repo");
      const name = decodeSegment(segments[4], "artifact");
      const artifact = checkedArtifact(opts, task, repo, name);
      res.writeHead(200, {
        "Content-Type": artifact.contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(readFileSync(artifact.file));
      return true;
    }

    throw new ApiError(404, "not found");
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    const message = err instanceof ApiError ? err.message : "internal server error";
    json(res, status, { error: message });
    return true;
  }
}
