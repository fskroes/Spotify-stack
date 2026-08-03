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

test("getServerConfig falls back on an invalid LOG_LEVEL", () => {
  const config = getServerConfig({ LOG_LEVEL: "verbose" });
  assert.equal(config.logLevel, "debug");
});

test("getServerConfig falls back on an invalid LOG_LEVEL in production", () => {
  const config = getServerConfig({ LOG_LEVEL: "verbose", NODE_ENV: "production" });
  assert.equal(config.logLevel, "info");
});

test("getServerConfig falls back on an invalid LOG_FORMAT", () => {
  const config = getServerConfig({ LOG_FORMAT: "xml" });
  assert.equal(config.logFormat, "pretty");
});

test("getServerConfig falls back on a non-numeric PORT", () => {
  const config = getServerConfig({ PORT: "not-a-port" });
  assert.equal(config.port, 3001);
});

test("getServerConfig falls back on a non-numeric RATE_LIMIT_MAX", () => {
  const config = getServerConfig({ RATE_LIMIT_MAX: "lots" });
  assert.equal(config.rateLimitMax, 0);
});

test("getServerConfig falls back on a non-numeric RATE_LIMIT_MAX in production", () => {
  const config = getServerConfig({ RATE_LIMIT_MAX: "lots", NODE_ENV: "production" });
  assert.equal(config.rateLimitMax, 200);
});

test("getServerConfig returns production defaults without overrides", () => {
  const config = getServerConfig({ NODE_ENV: "production" });
  assert.equal(config.trustProxy, 1);
  assert.equal(config.rateLimitMax, 200);
  assert.equal(config.logFormat, "json");
});
