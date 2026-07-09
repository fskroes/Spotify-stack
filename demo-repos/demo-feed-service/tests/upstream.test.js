import test from "node:test";
import assert from "node:assert/strict";
import { fetchFeed, fetchItems, searchItems } from "../src/lib/upstream.js";

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
