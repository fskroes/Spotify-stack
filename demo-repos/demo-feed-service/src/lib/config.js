/**
 * Server configuration derived from an environment object. Malformed values
 * silently fall back to the environment's default so a bad deploy variable
 * can never keep the service from booting.
 */

const LOG_LEVELS = ["debug", "info", "warn", "error"];
const LOG_FORMATS = ["pretty", "json"];

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * @param {Record<string, string | undefined>} env plain object — callers pass
 *   `process.env` at boot and literal objects in tests
 */
export function getServerConfig(env = {}) {
  const production = env.NODE_ENV === "production";
  return {
    port: integer(env.PORT, 3001),
    logLevel: oneOf(env.LOG_LEVEL, LOG_LEVELS, production ? "info" : "debug"),
    logFormat: oneOf(env.LOG_FORMAT, LOG_FORMATS, production ? "json" : "pretty"),
    trustProxy: integer(env.TRUST_PROXY, production ? 1 : 0),
    rateLimitMax: integer(env.RATE_LIMIT_MAX, production ? 200 : 0),
  };
}
