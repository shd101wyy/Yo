// Probe: for each .yo file in tests/ and yo-self/, parse via TS and check
// if yo-self's parser via `yo-self compile --emit-c --skip-c-compiler` also
// succeeds (or fails for the same reason).
//
// We don't actually compile — we just lex+parse+evaluate enough to detect
// parser errors. But yo-self's `compile` subcommand runs the full pipeline
// which includes evaluation. So we use a lighter probe: try compiling
// from a tiny stub `main.yo` that imports each file.
//
// Simpler: just use the TS parser. If any file fails to TS-parse, log it.
// Then optionally compare with yo-self by running yo-self-bin and seeing
// if it also fails.
import Parser from "../src/parser";
import * as fs from "fs";
import * as path from "path";

function walk(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  const stat = fs.statSync(dir);
  if (stat.isFile() && dir.endsWith(".yo")) {
    files.push(dir);
    return files;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(dir)) {
      if ([".git", "node_modules", "out", "yo-out"].includes(entry)) continue;
      walk(path.join(dir, entry), files);
    }
  }
  return files;
}

const files = [
  ...walk("tests"),
  ...walk("yo-self"),
];

console.log(`Found ${files.length} .yo files\n`);
let tsOk = 0, tsFail = 0;
const tsFailures: { file: string; err: string }[] = [];

for (const f of files) {
  const src = fs.readFileSync(f, "utf-8");
  try {
    const p = new Parser({ inputString: src, modulePath: f });
    p.getProgram();
    tsOk++;
  } catch (e) {
    tsFail++;
    tsFailures.push({ file: f, err: String(e).split("\n")[0].slice(0, 120) });
  }
}

console.log(`TS parser: ${tsOk} OK, ${tsFail} fail`);
if (tsFailures.length > 0 && tsFailures.length < 30) {
  console.log("\nTS failures:");
  for (const f of tsFailures.slice(0, 20)) {
    console.log(`  ${f.file}`);
    console.log(`    ${f.err}`);
  }
}
