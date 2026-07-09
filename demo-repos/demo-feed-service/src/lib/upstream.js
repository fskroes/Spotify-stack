/**
 * Client for the upstream content API that every feed refresh flows through.
 * Failure handling policy:
 *   - timeouts and 5xx responses are retried once, then classified;
 *   - 4xx responses fail immediately (they will not get better on retry) —
 *     except in `fetchFeed`, where a 400/404 source is routinely stale config
 *     and is retried once against the default source;
 *   - "successful" responses with no usable payload are classified too, so
 *     callers always see an UpstreamError with a stable `code`.
 */

const BASE_URL = "https://upstream.example.test/v1";
const TIMEOUT_MS = 4000;
const MAX_ATTEMPTS = 2;

export const DEFAULT_SOURCE = "featured";

export class UpstreamError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, statusCode: number, upstreamStatus?: number }} details
   */
  constructor(message, { code, statusCode, upstreamStatus }) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.statusCode = statusCode;
    if (upstreamStatus !== undefined) this.upstreamStatus = upstreamStatus;
  }
}

async function request(path) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (error.name === "AbortError" || error.name === "TimeoutError") {
        if (attempt === MAX_ATTEMPTS) {
          throw new UpstreamError(`upstream timed out after ${attempt} attempts`, {
            code: "UPSTREAM_TIMEOUT",
            statusCode: 504,
          });
        }
        continue;
      }
      throw error;
    }

    if (response.ok) return response.json();

    if (response.status >= 500) {
      if (attempt === MAX_ATTEMPTS) {
        throw new UpstreamError(`upstream failed with ${response.status} after ${attempt} attempts`, {
          code: "UPSTREAM_5XX",
          statusCode: 502,
          upstreamStatus: response.status,
        });
      }
      continue;
    }

    throw new UpstreamError(`upstream rejected the request with ${response.status}`, {
      code: "UPSTREAM_4XX",
      statusCode: 502,
      upstreamStatus: response.status,
    });
  }
}

function requireResults(body) {
  if (!Array.isArray(body?.results)) {
    throw new UpstreamError("upstream response has no results", {
      code: "UPSTREAM_NO_RESULT",
      statusCode: 404,
    });
  }
  return body.results;
}

/**
 * Fetch the items for a topic.
 *
 * @param {string} apiKey
 * @param {string} topic
 * @returns {Promise<Array<{ id: string, url: string, title: string }>>}
 */
export async function fetchItems(apiKey, topic) {
  const body = await request(`/items?${new URLSearchParams({ key: apiKey, topic })}`);
  return requireResults(body);
}

/**
 * Full-text search across items.
 *
 * @param {string} apiKey
 * @param {string} query
 * @returns {Promise<Array<{ id: string, url: string, title: string }>>}
 */
export async function searchItems(apiKey, query) {
  const body = await request(`/search?${new URLSearchParams({ key: apiKey, q: query })}`);
  return requireResults(body);
}

async function fetchSourceItems(apiKey, source) {
  const body = await request(
    `/feeds/${encodeURIComponent(source)}/items?${new URLSearchParams({ key: apiKey })}`,
  );
  return requireResults(body);
}

/**
 * Fetch the items that make up a named feed source. A 400/404 source is
 * routinely stale config, so it is retried once against DEFAULT_SOURCE; a
 * source that resolves to zero items is an error — publishing an empty feed
 * would wipe subscribers' readers.
 *
 * @param {string} apiKey
 * @param {string} source
 * @returns {Promise<Array<{ id: string, url: string, title: string }>>}
 */
export async function fetchFeed(apiKey, source) {
  let results;
  try {
    results = await fetchSourceItems(apiKey, source);
  } catch (error) {
    const staleSource =
      error instanceof UpstreamError &&
      error.code === "UPSTREAM_4XX" &&
      (error.upstreamStatus === 400 || error.upstreamStatus === 404) &&
      source !== DEFAULT_SOURCE;
    if (!staleSource) throw error;
    results = await fetchSourceItems(apiKey, DEFAULT_SOURCE);
  }
  if (results.length === 0) {
    throw new UpstreamError(`source "${source}" has no items`, {
      code: "UPSTREAM_EMPTY",
      statusCode: 404,
    });
  }
  return results;
}

/**
 * Enrich items with upstream metadata. Enrichment is best-effort: an item
 * whose row is missing or has no `enriched` object passes through unchanged —
 * a degraded feed beats no feed.
 *
 * @param {string} apiKey
 * @param {Array<{ id: string, url: string, title: string }>} items
 * @returns {Promise<Array<{ id: string, url: string, title: string }>>}
 */
export async function resolveItems(apiKey, items) {
  if (items.length === 0) return [];
  const ids = items.map((item) => item.id).join(",");
  const body = await request(`/resolve?${new URLSearchParams({ key: apiKey, ids })}`);
  const rows = Array.isArray(body?.results) ? body.results : [];
  return items.map((item, index) => {
    const row = rows[index];
    if (!row || typeof row.enriched !== "object" || row.enriched === null) return item;
    return { ...item, ...row.enriched };
  });
}
