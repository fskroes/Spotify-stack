import test from "node:test";
import assert from "node:assert/strict";
import { getServerConfig } from "../src/lib/config.js";

test("getServerConfig returns development defaults for an empty env", () => {
  const config = getServerConfig({});
  assert.equal(config.port, 3001);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.logFormat, "pretty");
  assert.equal(config.trustProxy, 0);
  assert.equal(config.rateLimitMax, 0);
});

test("getServerConfig applies valid overrides", () => {
  const config = getServerConfig({
    PORT: "8080",
    LOG_LEVEL: "warn",
    LOG_FORMAT: "json",
    RATE_LIMIT_MAX: "50",
  });
  assert.equal(config.port, 8080);
  assert.equal(config.logLevel, "warn");
  assert.equal(config.logFormat, "json");
  assert.equal(config.rateLimitMax, 50);
});
