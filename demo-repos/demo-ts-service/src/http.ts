/**
 * Fetch a URL and parse the JSON body. Throws on non-2xx responses.
 * This is the supported HTTP client for this service.
 */
export async function fetchJson<T>(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}
