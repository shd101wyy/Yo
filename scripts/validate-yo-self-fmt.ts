// One-off validation: extract each test() block from src/tests/formatter.test.ts,
// run yo-self-bin fmt on the source, compare to the inline expected output.
//
// Usage: bun /tmp/validate-yo-self-fmt.ts
import { spawnSync } from "child_process";
import * as fs from "fs";

const BIN = "/tmp/yo-self-fmt-bin";
const TEST_FILE = "src/tests/formatter.test.ts";

const source = fs.readFileSync(TEST_FILE, "utf-8");

// Match each `test("name", () => { ... });` block at the top level.
// Within: extract `const source = (template-literal);` and the final
// `expect(formatYoSource(source)).toBe(template-literal);`.
//
// Template literals may contain newlines, embedded ${...}, and escaped backticks.
// We use a state-machine over the source to find balanced backtick-delimited
// template literals starting at a given position.
function findTemplateLiteral(
  s: string,
  start: number
): { value: string; end: number } | null {
  if (s[start] !== "`") return null;
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      // Closing backtick.
      return { value: s.slice(start, i + 1), end: i + 1 };
    }
    if (c === "$" && s[i + 1] === "{") {
      // Skip the ${...} interpolation balanced by curlies.
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return null;
}

function findStringLiteral(
  s: string,
  start: number
): { value: string; end: number } | null {
  if (s[start] !== '"' && s[start] !== "'" && s[start] !== "`") return null;
  if (s[start] === "`") return findTemplateLiteral(s, start);
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === quote) return { value: s.slice(start, i + 1), end: i + 1 };
    i++;
  }
  return null;
}

// Parse all test("name", () => { ... }); blocks.
//
// Anchor matching on `test("name", () => {` so we don't mistake
// `test("name", { … })` substrings that appear inside test source/expected
// template literals (e.g. test 7's source includes a literal
// `test("format effect", { … })`). The `() =>` arrow distinguishes a real
// top-level `test()` call from the inner content.
type TestCase = { name: string; source: string; expected: string };
const cases: TestCase[] = [];
const skipped: { name: string; reason: string }[] = [];

const testStartRe = /test\("([^"]+)",\s*\(\s*\)\s*=>\s*\{/g;
let m: RegExpExecArray | null;
while ((m = testStartRe.exec(source)) !== null) {
  const name = m[1];
  const p = m.index + m[0].length;

  // Find `const source = `...`;`
  const srcMarker = "const source = ";
  const srcIdx = source.indexOf(srcMarker, p);
  if (srcIdx === -1) {
    skipped.push({ name, reason: "no `const source = `" });
    continue;
  }
  const srcLitStart = srcIdx + srcMarker.length;
  const srcLit = findStringLiteral(source, srcLitStart);
  if (!srcLit) {
    skipped.push({ name, reason: "source is not a string literal" });
    continue;
  }

  // Find the first `.toBe(` after the source declaration. Most tests use
  // `expect(formatYoSource(source)).toBe(`<literal>`)` but some use the
  // intermediate `const once = formatYoSource(source); expect(once).toBe(`<literal>`)`
  // form — both are caught here because the first `.toBe(` carries the
  // literal. Tests that compare two identifiers (e.g. `expect(twice).toBe(once)`
  // for idempotency-only checks) have no literal to compare and are skipped.
  const expMarker = ".toBe(";
  const expIdx = source.indexOf(expMarker, srcLit.end);
  if (expIdx === -1) {
    skipped.push({ name, reason: "no `.toBe(` after source" });
    continue;
  }
  let expLitStart = expIdx + expMarker.length;
  while (/\s/.test(source[expLitStart])) expLitStart++;
  const expLit = findStringLiteral(source, expLitStart);
  if (!expLit) {
    skipped.push({
      name,
      reason:
        "`.toBe(` argument is not a string literal (idempotency-only test?)",
    });
    continue;
  }

  // eval the literals (template-strings with embedded vars: those aren't used
  // in our test cases except for backslash-escaped backticks)
  let srcValue: string, expectedValue: string;
  try {
    srcValue = eval(srcLit.value);
    expectedValue = eval(expLit.value);
  } catch (e) {
    skipped.push({ name, reason: `eval failed: ${e}` });
    continue;
  }
  cases.push({ name, source: srcValue, expected: expectedValue });
}

console.log(
  `Extracted ${cases.length} test cases; skipped ${skipped.length}.\n`
);
if (skipped.length > 0) {
  console.log("Skipped:");
  for (const s of skipped) {
    console.log(`  - ${s.name}: ${s.reason}`);
  }
  console.log();
}

// Run each through yo-self-bin
let pass = 0,
  fail = 0;
const failures: { name: string; expected: string; actual: string }[] = [];

for (const tc of cases) {
  const tmpPath = `/tmp/yo_fmt_${Date.now()}_${Math.floor(Math.random() * 1e9)}.yo`;
  fs.writeFileSync(tmpPath, tc.source);
  spawnSync(BIN, ["fmt", tmpPath], { encoding: "utf-8" });
  const actual = fs.readFileSync(tmpPath, "utf-8");
  fs.unlinkSync(tmpPath);

  if (actual === tc.expected) {
    console.log(`✓ ${tc.name}`);
    pass++;
  } else {
    console.log(`✗ ${tc.name}`);
    failures.push({ name: tc.name, expected: tc.expected, actual });
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} total\n`);

if (failures.length > 0) {
  console.log("=== first 5 failures ===\n");
  for (const f of failures.slice(0, 5)) {
    console.log(`--- ${f.name} ---`);
    console.log("expected:");
    console.log(JSON.stringify(f.expected));
    console.log("actual:");
    console.log(JSON.stringify(f.actual));
    console.log();
  }
}
