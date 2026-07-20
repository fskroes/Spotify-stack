/**
 * Output summarizers — part 3 of Spotify's Honk series: "Verifiers parse test
 * output ... to extract only critical error messages, reducing context window
 * noise." Each summarizer takes raw combined stdout+stderr and returns only
 * the lines an agent needs to fix the failure, capped in size.
 */

const MAX_LINES = 40;
const MAX_BYTES = 4096;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Remove ANSI color/style codes so regexes see plain text. */
function stripAnsi(text) {
  return text.replace(ANSI, "");
}

/** Cap a list of lines to MAX_LINES / MAX_BYTES with a truncation marker. */
function cap(lines) {
  let out = lines.slice(0, MAX_LINES);
  const dropped = lines.length - out.length;
  let text = out.join("\n");
  if (text.length > MAX_BYTES) {
    text = text.slice(0, MAX_BYTES) + "\n… (output truncated)";
  } else if (dropped > 0) {
    text += `\n… (${dropped} more lines omitted)`;
  }
  return text;
}

/** ESLint "stylish" output: keep file headers and their error lines. */
export function summarizeEslint(output) {
  const lines = stripAnsi(output).split("\n");
  const kept = [];
  let currentFile = null;
  let filePrinted = false;
  for (const line of lines) {
    if (/^\S.*\.[cm]?[jt]sx?$/.test(line.trim()) && !line.startsWith(" ")) {
      currentFile = line.trim();
      filePrinted = false;
      continue;
    }
    const m = line.match(/^\s+(\d+:\d+)\s+(error|warning)\s+(.*)$/);
    if (m && m[2] === "error") {
      if (currentFile && !filePrinted) {
        kept.push(currentFile);
        filePrinted = true;
      }
      kept.push(`  ${m[1]}  error  ${m[3].trim()}`);
    }
    if (/^✖ \d+ problems?/.test(line.trim())) {
      kept.push(line.trim());
    }
  }
  return cap(kept.length > 0 ? kept : fallbackErrorLines(output));
}

/** tsc output: keep `file(line,col): error TSxxxx: message` lines. */
export function summarizeTsc(output) {
  const kept = stripAnsi(output)
    .split("\n")
    .filter((l) => /error TS\d+/.test(l))
    .map((l) => l.trim());
  return cap(kept.length > 0 ? kept : fallbackErrorLines(output));
}

/**
 * npm-test output (vitest or node:test, TAP and spec reporters): keep
 * failed-test names and assertion messages.
 */
export function summarizeVitest(output) {
  const lines = stripAnsi(output).split("\n");
  const kept = [];
  // Inside the YAML diagnostic block that follows a TAP `not ok` line
  // (delimited by `---` / `...`) — keep it whole, it holds the assertion.
  let inTapDiagnostic = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inTapDiagnostic) {
      kept.push(line);
      if (line === "...") {
        inTapDiagnostic = false;
      }
      continue;
    }
    if (/^not ok \d+/.test(line)) {
      kept.push(line);
      inTapDiagnostic = true;
      continue;
    }
    if (
      line.startsWith("FAIL ") ||
      /^[×✗✘✖]/.test(line) ||
      /^(AssertionError|Error|TypeError|ReferenceError)[:(]/.test(line) &&
        !line.includes("node:internal") ||
      /^[-+] (Expected|Received)/.test(line) ||
      /^(expected|Expected).*(to (be|equal|throw|match)|but)/.test(line) ||
      /^Tests\s+\d+ failed/.test(line) ||
      /^Test Files\s+\d+ failed/.test(line) ||
      /^Serialized Error/.test(line) ||
      /^[#ℹ] fail [1-9]\d*$/.test(line)
    ) {
      kept.push(line);
    }
  }
  return cap(kept.length > 0 ? kept : fallbackErrorLines(output));
}

/** swift build output: keep `file:line:col: error:` lines plus one context line. */
export function summarizeSwiftBuild(output) {
  const kept = stripAnsi(output)
    .split("\n")
    .filter((l) => /error:/.test(l))
    .map((l) => l.trim());
  return cap(kept.length > 0 ? kept : fallbackErrorLines(output));
}

/** swift test / XCTest output: keep failure lines and the summary counts. */
export function summarizeSwiftTest(output) {
  const kept = stripAnsi(output)
    .split("\n")
    .filter(
      (l) =>
        /: error:/.test(l) ||
        /XCTAssert\w* failed/.test(l) ||
        /Executed \d+ tests?, with (?!0 failures)\d+ failures?/.test(l) ||
        /✘|Test .* failed/.test(l),
    )
    .map((l) => l.trim());
  return cap(kept.length > 0 ? kept : fallbackErrorLines(output));
}

/** Last resort: last lines mentioning error/fail, else the output tail. */
function fallbackErrorLines(output) {
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  const errorish = lines.filter((l) => /error|fail/i.test(l));
  // Keep a generous tail; cap() enforces the final limit and marks omissions.
  return (errorish.length > 0 ? errorish : lines).slice(-200);
}

/** Generic summarizer for checks without a dedicated parser. */
export function summarizeGeneric(output) {
  return cap(fallbackErrorLines(stripAnsi(output)));
}

export const summarizers = {
  eslint: summarizeEslint,
  tsc: summarizeTsc,
  test: summarizeVitest,
  "swift-build": summarizeSwiftBuild,
  "swift-test": summarizeSwiftTest,
  // xcodebuild output is clang/XCTest-flavored — same shapes the swift parsers
  // already match (`error:`, `XCTAssert… failed`, `Executed N tests, with M …`).
  "xcodebuild-build": summarizeSwiftBuild,
  "xcodebuild-test": summarizeSwiftTest,
};
