/**
 * CLI argument parsing shared by every entry point (feed generation,
 * publishing). Pure functions — no process.argv access here.
 */

/**
 * Parse `--key value` style arguments. A `--flag` followed by another
 * `--option` (or by nothing) becomes `true`; repeated keys collect into an
 * array; tokens that are neither flags nor flag values are skipped.
 *
 * @param {string[]} argv
 * @returns {Record<string, string | true | Array<string | true>>}
 */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    let value;
    if (next === undefined || next.startsWith("--")) {
      value = true;
    } else {
      value = next;
      i += 1;
    }
    if (key in args) {
      args[key] = asArray(args[key]);
      args[key].push(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

/**
 * Normalize a parsed value to an array: `undefined` becomes `[]`, a scalar
 * becomes a one-element array, an array is returned as-is.
 *
 * @template T
 * @param {T | T[] | undefined} value
 * @returns {T[]}
 */
export function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
