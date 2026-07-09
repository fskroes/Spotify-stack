import { describe, expect, it } from "vitest";
import { fetchJson } from "../src/http.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("fetchJson", () => {
  it("returns the parsed JSON body on success", async () => {
    const result = await fetchJson<{ ok: boolean }>(
      "https://example.test/thing",
      fakeFetch(200, { ok: true }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects on non-2xx responses", async () => {
    await expect(
      fetchJson("https://example.test/missing", fakeFetch(404, {})),
    ).rejects.toThrow("HTTP 404");
  });
});
