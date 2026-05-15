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

// Parse all test("name", () => { ... }); blocks
type TestCase = { name: string; source: string; expected: string };
const cases: TestCase[] = [];

let i = 0;
while (i < source.length) {
  const idx = source.indexOf('test("', i);
  if (idx === -1) break;

  // Extract test name
  const nameStart = idx + 6;
  const nameEnd = source.indexOf('"', nameStart);
  if (nameEnd === -1) {
    i = idx + 1;
    continue;
  }
  const name = source.slice(nameStart, nameEnd);

  // Skip past ", () => {"
  let p = source.indexOf("=> {", nameEnd);
  if (p === -1) {
    i = idx + 1;
    continue;
  }
  p += 4;

  // Find `const source = `...`;`
  const srcMarker = "const source = ";
  const srcIdx = source.indexOf(srcMarker, p);
  if (srcIdx === -1) {
    i = idx + 1;
    continue;
  }
  const srcLitStart = srcIdx + srcMarker.length;
  const srcLit = findStringLiteral(source, srcLitStart);
  if (!srcLit) {
    i = idx + 1;
    continue;
  }

  // Find `expect(formatYoSource(source)).toBe(`
  const expMarker = ".toBe(";
  const expIdx = source.indexOf(expMarker, srcLit.end);
  if (expIdx === -1) {
    i = idx + 1;
    continue;
  }
  let expLitStart = expIdx + expMarker.length;
  // Skip whitespace after `(`
  while (/\s/.test(source[expLitStart])) expLitStart++;
  const expLit = findStringLiteral(source, expLitStart);
  if (!expLit) {
    i = idx + 1;
    continue;
  }

  // eval the literals (template-strings with embedded vars: those aren't used
  // in our test cases except for backslash-escaped backticks)
  let srcValue: string, expectedValue: string;
  try {
    srcValue = eval(srcLit.value);
    expectedValue = eval(expLit.value);
  } catch (e) {
    console.error(`Failed to eval literals for ${name}: ${e}`);
    i = expLit.end;
    continue;
  }
  cases.push({ name, source: srcValue, expected: expectedValue });

  i = expLit.end;
}

console.log(`Extracted ${cases.length} test cases.\n`);

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
