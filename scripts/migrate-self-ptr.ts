/**
 * Migrate `(self : *(Self))` method signatures to `(inout(self) : Self)`
 * inside `impl(...)` blocks, and rewrite `self.*` references in the
 * matching method bodies to `self`.
 *
 * Operates on a single file (passed as argv[2]). The script is
 * intentionally narrow:
 *  - Only rewrites function signatures of the exact shape
 *    `(self : *(Self), …) -> …` or `(self : *(Self)) -> …`.
 *  - Only rewrites `self.*` *inside the body* of one of those
 *    methods, found by walking balanced parens after the signature.
 *  - `self.*` outside any such method body — for example in helper
 *    functions that operate on a `*(SomeType)` parameter — is left
 *    alone.
 *
 * Patterns deliberately NOT rewritten (need manual review):
 *  - `(&(self.*.field))…` array-element mutation patterns
 *  - `(other : *(SomeType))` non-self pointer parameters
 *  - `self.*.field = …` writes (these are valid `self.field = …`
 *    after migration, but worth eyeballing the surrounding context)
 *
 * Usage:
 *   bun run scripts/migrate-self-ptr.ts <file>          # dry-run
 *   bun run scripts/migrate-self-ptr.ts <file> --write  # apply
 */

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

interface RewriteResult {
  result: string;
  sigsRewritten: number;
  derefRewrites: number;
}

function migrate(content: string): RewriteResult {
  const out: string[] = [];
  let i = 0;
  let sigsRewritten = 0;
  let derefRewrites = 0;

  // Match `(self : *(Self)` or `(self : *(Self),` — the signature
  // start. We need to be inside a function-type expression, but it's
  // hard to verify that without a real parser; rely on the literal
  // shape, which is uncommon outside this context.
  const sigStart = /\(self : \*\(Self\)/g;

  while (i < content.length) {
    sigStart.lastIndex = i;
    const m = sigStart.exec(content);
    if (!m) {
      out.push(content.slice(i));
      break;
    }
    const startIdx = m.index;
    out.push(content.slice(i, startIdx));

    // The match starts with `(` of the param list. Walk balanced parens
    // to find the end of the param-list `)`. We DON'T rewrite the
    // body's self.* until we find the method body, which is the
    // *following* parenthesized expression.
    let j = startIdx;
    let depth = 0;
    while (j < content.length) {
      const ch = content[j]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    // We've now consumed the `(self : *(Self), …)` param list. Emit
    // the rewritten signature.
    const sigText = content.slice(startIdx, j);
    const newSig = sigText.replace("(self : *(Self)", "(inout(self) : Self");
    out.push(newSig);
    sigsRewritten++;

    // After the param list, we expect ` -> ReturnType)( body )`.
    // We don't care to fully parse — we just keep walking until we
    // find the next top-level `)`, which closes the `fn(...)` type,
    // then the next `(` opens the body. Inside the body (balanced
    // parens) we rewrite `self.*` → `self`.
    //
    // Practically: keep emitting content unchanged until we hit a
    // matching close-paren depth at the level of the `fn` type
    // expression, then walk into the body.
    //
    // Simpler approach: find the next `)` from current position that
    // closes the surrounding fn-type expression. We know the
    // pattern: `(fn(self : *(Self), …) -> RETURN_TYPE)`. We've consumed
    // up through the params; now expect ` -> RETURN_TYPE)`.
    let k = j;
    // Walk past ` -> ReturnType)` — handle nested parens in the
    // return type.
    let returnDepth = 0;
    while (k < content.length) {
      const ch = content[k]!;
      if (ch === "(") returnDepth++;
      else if (ch === ")") {
        if (returnDepth === 0) {
          k++;
          break;
        }
        returnDepth--;
      }
      k++;
    }
    // Emit ` -> RETURN_TYPE)` unchanged.
    out.push(content.slice(j, k));

    // Now the body. Skip whitespace.
    while (k < content.length && /\s/.test(content[k]!)) {
      out.push(content[k]!);
      k++;
    }
    // The body should start with `(`. If not, give up rewriting this
    // method's `self.*` references (signature still flipped, but
    // body left alone — manual review needed).
    if (content[k] !== "(") {
      i = k;
      continue;
    }
    // Walk balanced parens for the body.
    const bodyStart = k;
    let bodyDepth = 0;
    while (k < content.length) {
      const ch = content[k]!;
      if (ch === "(") bodyDepth++;
      else if (ch === ")") {
        bodyDepth--;
        if (bodyDepth === 0) {
          k++;
          break;
        }
      }
      k++;
    }
    const body = content.slice(bodyStart, k);
    // Rewrite `self.*` → `self` inside this method's body only.
    const rewrittenBody = body.replace(/self\.\*/g, () => {
      derefRewrites++;
      return "self";
    });
    out.push(rewrittenBody);

    i = k;
  }

  return { result: out.join(""), sigsRewritten, derefRewrites };
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error(
      "Usage: bun run scripts/migrate-self-ptr.ts <file> [--write]"
    );
    process.exit(1);
  }
  const abs = path.resolve(file);
  const content = readFileSync(abs, "utf-8");
  const { result, sigsRewritten, derefRewrites } = migrate(content);
  if (result === content) {
    console.log(`no changes: ${file}`);
    return;
  }
  console.log(
    `${write ? "migrated" : "would migrate"}: ${file} ` +
      `(${sigsRewritten} signatures, ${derefRewrites} self.* rewrites)`
  );
  if (write) writeFileSync(abs, result, "utf-8");
}

main();
