#!/usr/bin/env node
// Generate Atom documents for one or more sources:
//   node src/cli.js --source daily --source weekly [--dry-run]
import { asArray, parseArgs } from "./lib/args.js";
import { buildFeed } from "./lib/feed.js";
import { DEFAULT_SOURCE, fetchFeed, resolveItems } from "./lib/upstream.js";

const args = parseArgs(process.argv.slice(2));
const apiKey = process.env.UPSTREAM_API_KEY ?? "";
const sources = asArray(args.source);
if (sources.length === 0) sources.push(DEFAULT_SOURCE);

for (const source of sources) {
  const items = await resolveItems(apiKey, await fetchFeed(apiKey, source));
  const document = buildFeed({ title: `demo-feed-service: ${source}`, items });
  if (args["dry-run"]) {
    console.log(`--- ${source}: ${items.length} items (dry run, not published) ---`);
  } else {
    process.stdout.write(document);
  }
}
