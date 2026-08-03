import test from "node:test";
import assert from "node:assert/strict";
import { buildFeed } from "../src/lib/feed.js";

test("buildFeed emits one entry per item with matching id and link", () => {
  const feed = buildFeed({
    title: "News",
    items: [
      { id: "1", url: "https://example.com/1", title: "First" },
      { id: "2", url: "https://example.com/2", title: "Second" },
    ],
  });

  const entryCount = feed.match(/<entry>/g)?.length ?? 0;
  assert.equal(entryCount, 2);

  assert.ok(feed.includes("<id>1</id>"));
  assert.ok(feed.includes("<id>2</id>"));
  assert.ok(feed.includes('<link href="https://example.com/1"/>'));
  assert.ok(feed.includes('<link href="https://example.com/2"/>'));
});

test("buildFeed escapes XML special characters in the feed and entry titles", () => {
  const feed = buildFeed({
    title: 'News & <Updates> "daily"',
    items: [
      { id: "1", url: "https://example.com/1", title: 'Hot & <Fresh> "now"' },
    ],
  });

  assert.ok(feed.includes("News &amp; &lt;Updates&gt; &quot;daily&quot;"));
  assert.ok(feed.includes("Hot &amp; &lt;Fresh&gt; &quot;now&quot;"));
  assert.ok(!feed.includes('<title>News & <Updates>'));
  assert.ok(!feed.includes('<title>Hot & <Fresh>'));
});

test("buildFeed produces a well-formed Atom document", () => {
  const feed = buildFeed({
    title: "News",
    items: [{ id: "1", url: "https://example.com/1", title: "First" }],
  });

  assert.ok(feed.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
  assert.ok(feed.includes('xmlns="http://www.w3.org/2005/Atom"'));
  assert.ok(feed.includes("<updated>"));
});

test("buildFeed produces a feed element and no entries for an empty item list", () => {
  const feed = buildFeed({ title: "Empty", items: [] });

  assert.ok(feed.includes("<feed"));
  assert.ok(!feed.includes("<entry>"));
});
