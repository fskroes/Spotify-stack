import test from "node:test";
import assert from "node:assert/strict";
import {
  UpstreamError,
  fetchFeed,
  fetchItems,
  resolveItems,
  searchItems,
} from "../src/lib/upstream.js";

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const ok = (body) => ({ ok: true, json: async () => body });

test("fetchItems returns the upstream results", async () => {
  globalThis.fetch = async () =>
    ok({ results: [{ id: "1", url: "https://example.com/1", title: "First" }] });

  const items = await fetchItems("test-key", "headlines");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "1");
});

test("searchItems returns matching items", async () => {
  globalThis.fetch = async () =>
    ok({
      results: [
        { id: "1", url: "https://example.com/1", title: "First" },
        { id: "2", url: "https://example.com/2", title: "Second" },
      ],
    });

  const items = await searchItems("test-key", "first");
  assert.equal(items.length, 2);
  assert.equal(items[1].title, "Second");
});

test("fetchFeed returns the items for a source", async () => {
  globalThis.fetch = async () =>
    ok({
      results: [
        { id: "1", url: "https://example.com/1", title: "First" },
        { id: "2", url: "https://example.com/2", title: "Second" },
      ],
    });

  const items = await fetchFeed("test-key", "daily");
  assert.equal(items.length, 2);
});

const fail = (status) => ({ ok: false, status });
const aborted = () => Object.assign(new Error("aborted"), { name: "AbortError" });

test("fetchItems classifies repeated aborts as UPSTREAM_TIMEOUT", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw aborted();
  };

  await assert.rejects(fetchItems("test-key", "topic"), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.code, "UPSTREAM_TIMEOUT");
    assert.equal(error.statusCode, 504);
    return true;
  });
  assert.equal(attempts, 2);
});

test("fetchFeed classifies repeated aborts as UPSTREAM_TIMEOUT", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw aborted();
  };

  await assert.rejects(fetchFeed("test-key", "daily"), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.code, "UPSTREAM_TIMEOUT");
    assert.equal(error.statusCode, 504);
    return true;
  });
  assert.equal(attempts, 2);
});

test("searchItems retries once after an abort and then succeeds", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) throw aborted();
    return ok({ results: [{ id: "1", url: "https://example.com/1", title: "First" }] });
  };

  const items = await searchItems("test-key", "first");
  assert.equal(items.length, 1);
  assert.equal(attempts, 2);
});

test("fetchItems retries once after a 500 and then succeeds", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return fail(500);
    return ok({ results: [{ id: "1", url: "https://example.com/1", title: "First" }] });
  };

  const items = await fetchItems("test-key", "headlines");
  assert.equal(items.length, 1);
  assert.equal(attempts, 2);
});

test("fetchItems does not retry a 4xx response", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return fail(422);
  };

  await assert.rejects(fetchItems("test-key", "headlines"), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.code, "UPSTREAM_4XX");
    assert.equal(error.upstreamStatus, 422);
    return true;
  });
  assert.equal(attempts, 1);
});

test("fetchFeed does not retry a 4xx response that is not a stale source", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return fail(422);
  };

  await assert.rejects(fetchFeed("test-key", "daily"), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.code, "UPSTREAM_4XX");
    assert.equal(error.upstreamStatus, 422);
    return true;
  });
  assert.equal(attempts, 1);
});

test("fetchItems rejects when the response body has no results", async () => {
  globalThis.fetch = async () => ok({});

  await assert.rejects(fetchItems("test-key", "headlines"), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.code, "UPSTREAM_NO_RESULT");
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test("searchItems rejects when the response body has no results", async () => {
  globalThis.fetch = async () => ok({});

  await assert.rejects(searchItems("test-key", "first"), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.code, "UPSTREAM_NO_RESULT");
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test("fetchFeed rejects when the source resolves to zero items", async () => {
  globalThis.fetch = async () => ok({ results: [] });

  await assert.rejects(fetchFeed("test-key", "daily"), (error) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.code, "UPSTREAM_EMPTY");
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test("resolveItems passes items through when their row is missing or unenriched", async () => {
  const items = [
    { id: "1", url: "https://example.com/1", title: "First" },
    { id: "2", url: "https://example.com/2", title: "Second" },
    { id: "3", url: "https://example.com/3", title: "Third" },
    { id: "4", url: "https://example.com/4", title: "Fourth" },
  ];
  globalThis.fetch = async () =>
    ok({
      results: [
        { enriched: { title: "First (enriched)", author: "Ada" } },
        { enriched: null },
        {},
        // no row for the fourth item at all
      ],
    });

  const resolved = await resolveItems("test-key", items);
  assert.equal(resolved.length, 4);
  assert.deepEqual(resolved[0], {
    id: "1",
    url: "https://example.com/1",
    title: "First (enriched)",
    author: "Ada",
  });
  assert.deepEqual(resolved[1], items[1]);
  assert.deepEqual(resolved[2], items[2]);
  assert.deepEqual(resolved[3], items[3]);
});
