# A template string inside another template string's `${…}` fails, and the error points at line 1

> **FIXED — closed 2026-10-01, fixed by the 2026-09-23 interpolation-body
> rescan** (`issues/fixed/template-interpolation-body-is-not-scanned-as-code.md`;
> documented at `.github/instructions/yo-syntax.instructions.md` "An
> interpolation body is code"). Verified 2026-10-01 on yo 0.2.47: the
> repro's shapes all check clean — `` `outer ${`inner ${x}`} end` ``, a
> nested template without interpolation, and two nesting levels. The
> sibling backslash case is a DIFFERENT defect and stays open
> (`template-string-backslash-before-interpolation-eats-both.md`, reproduced
> 2026-10-01: `` `path \\${x} end` `` prints `path ${x} end`). Doc frozen
> below.

**Severity:** S2 — a valid nested template inside `${...}` is rejected with a misleading line-1 `to_string` error

**Status: FIXED.** (stale header read OPEN; the doc sits in fixed/) Found 2026-09-05 while writing a `std/path` reproducer
(`issues/fixed/path-drops-dotdot-and-destroys-unc-prefix.md`). Sibling of
`issues/template-string-backslash-before-interpolation-eats-both.md` — the same
"the template-string lexer stops looking at the right place" family.

## Symptom

An interpolation hole may not contain another backtick string. The whole file
is rejected with an error that names neither the construct nor the line:

```rust
{ println } :: import("std/fmt");
open(import("std/string"));
id :: (fn(s : String) -> String)(s);
main :: (fn() -> unit)({
  println(`outer ${id(`inner`)}`);
});
export(main);
```

```
$ yo compile tmp/probe2.yo --optimize 2 -o tmp/probe2
error[E0403]: Module field "to_string" not found in module type
  --> ./tmp/probe2.yo:1:1
  |
1 | { println } :: import("std/fmt");
  | ^^^^^^^^^
help: run `yo explain E0403` for more information
```

Expected: `outer inner`.

The diagnostic is the worst part. It points at the file's first line — the
`import` — and blames a missing `to_string`, so the reader goes looking at the
import or at whatever they are calling `to_string` on. Nothing in it says
"template string", and nothing points at line 5. Measured on v0.2.24.

## Why it looks like this

The inner backtick almost certainly terminates the OUTER template literal at
the lexer level, leaving the rest of the line as stray tokens; the surviving
expression then has some module in `to_string` position, which is the error
that surfaces. The location is lost because the recovered expression no longer
carries the real span.

## Workaround

Hoist the inner string into a local — this is what the `std/path` reproducer
and `tests/path.test.yo` do:

```rust
inner := id(`inner`);
println(`outer ${inner}`);
```

## Where to look

`src/lexer.yo`'s template-string scanner: the `${` … `}` hole needs to lex a
full expression (tracking nested backticks and brace depth) rather than
scanning forward for the next backtick. The two known bugs in this family are
both "the hole's extent is computed by scanning bytes rather than by lexing".
