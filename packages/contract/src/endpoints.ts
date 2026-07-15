/**
 * The endpoint registry — each operator API route bound to its response
 * schema, so a caller cannot pair a URL with the wrong shape without visibly
 * typing the wrong property.
 *
 * `load(get, …)` is sugar over an injected transport: the contract performs
 * no I/O itself, it only closes over the caller's `get` to collapse
 * fetch-then-parse into one call. Parse failures throw WireParseError with
 * the endpoint name already attached.
 */
import type { z } from "zod";
import { parseWire, safeParseWire, type WireResult } from "./parse.js";
import {
  ArtifactListResponseSchema,
  CatalogResponseSchema,
  InflightResponseSchema,
  LedgerResponseSchema,
  RunDetailResponseSchema,
  type ArtifactListResponse,
  type CatalogResponse,
  type InflightResponse,
  type LedgerResponse,
  type RunDetailResponse,
} from "./schemas.js";

/** The caller's transport: fetch `path`, return the decoded JSON body. */
export type WireGet = (path: string) => Promise<unknown>;

export interface Endpoint<T> {
  /** Banner-ready route name, e.g. "GET /api/ledger". */
  readonly name: string;
  readonly path: string;
  parse(json: unknown): T;
  safeParse(json: unknown): WireResult<T>;
  load(get: WireGet): Promise<T>;
}

export interface ParamEndpoint<A extends string[], T> {
  readonly name: string;
  /** Builds the route; arguments are URI-encoded internally — don't pre-encode. */
  path(...args: A): string;
  parse(json: unknown): T;
  safeParse(json: unknown): WireResult<T>;
  load(get: WireGet, ...args: A): Promise<T>;
}

function endpoint<T>(name: string, path: string, schema: z.ZodType<T>): Endpoint<T> {
  return {
    name,
    path,
    parse: (json) => parseWire(schema, json, { endpoint: name }),
    safeParse: (json) => safeParseWire(schema, json, { endpoint: name }),
    load: async (get) => parseWire(schema, await get(path), { endpoint: name }),
  };
}

function paramEndpoint<A extends string[], T>(
  name: string,
  path: (...args: A) => string,
  schema: z.ZodType<T>,
): ParamEndpoint<A, T> {
  return {
    name,
    path,
    parse: (json) => parseWire(schema, json, { endpoint: name }),
    safeParse: (json) => safeParseWire(schema, json, { endpoint: name }),
    load: async (get, ...args) => parseWire(schema, await get(path(...args)), { endpoint: name }),
  };
}

export const Endpoints = {
  ledger: endpoint<LedgerResponse>("GET /api/ledger", "/api/ledger", LedgerResponseSchema),
  inflight: endpoint<InflightResponse>("GET /api/inflight", "/api/inflight", InflightResponseSchema),
  catalog: endpoint<CatalogResponse>("GET /api/catalog", "/api/catalog", CatalogResponseSchema),
  run: paramEndpoint<[runId: string], RunDetailResponse>(
    "GET /api/runs/:runId",
    (runId) => `/api/runs/${encodeURIComponent(runId)}`,
    RunDetailResponseSchema,
  ),
  artifacts: paramEndpoint<[task: string, repo: string], ArtifactListResponse>(
    "GET /api/artifacts/:task/:repo",
    (task, repo) => `/api/artifacts/${encodeURIComponent(task)}/${encodeURIComponent(repo)}`,
    ArtifactListResponseSchema,
  ),
} as const;
