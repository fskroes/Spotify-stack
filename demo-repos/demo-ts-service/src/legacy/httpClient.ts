/**
 * @deprecated Use `fetchJson` from `../http.js` instead. This callback-based
 * client is scheduled for removal.
 */
export type JsonCallback<T> = (err: Error | null, data: T | null) => void;

/**
 * @deprecated Use `fetchJson` from `../http.js` instead.
 */
export function getJson<T>(
  url: string,
  callback: JsonCallback<T>,
  fetchImpl: typeof fetch = fetch,
): void {
  fetchImpl(url)
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      callback(null, (await res.json()) as T);
    })
    .catch((err: unknown) => {
      callback(err instanceof Error ? err : new Error(String(err)), null);
    });
}
