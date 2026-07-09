import { createServer } from "node:http";
import { getServerConfig } from "./src/lib/config.js";
import { buildFeed } from "./src/lib/feed.js";
import { DEFAULT_SOURCE, fetchFeed, resolveItems } from "./src/lib/upstream.js";

const config = getServerConfig(process.env);
const apiKey = process.env.UPSTREAM_API_KEY ?? "";

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);
  if (req.method !== "GET" || url.pathname !== "/feed") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  const source = url.searchParams.get("source") ?? DEFAULT_SOURCE;
  try {
    const items = await resolveItems(apiKey, await fetchFeed(apiKey, source));
    res.writeHead(200, { "content-type": "application/atom+xml; charset=utf-8" });
    res.end(buildFeed({ title: `demo-feed-service: ${source}`, items }));
  } catch (error) {
    res.writeHead(error.statusCode ?? 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message, code: error.code ?? "INTERNAL" }));
  }
});

server.listen(config.port, () => {
  console.log(`demo-feed-service listening on :${config.port} (log: ${config.logLevel}/${config.logFormat})`);
});
