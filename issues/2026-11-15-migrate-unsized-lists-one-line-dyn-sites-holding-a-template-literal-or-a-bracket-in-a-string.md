# `yo fix --migrate unsized` lists one-line `dyn(...)` sites that hold a template literal or a bracket inside a string

**Severity:** S3: no code is changed wrongly, but the migration rewrites far fewer sites than it could, and its message is wrong for the sites it skips. In the S2 sweep of std and src, 178 of the 211 sites listed as "does not print back on one line" sit on one line: 177 hold a template literal, and one (`std/net/addr.yo`) holds a `[` inside a string. The suggested replacement shows the desugared template (`begin(__yo_tpl_8225195 := …)`), so it cannot be pasted back.

**Status:** OPEN. Found 2026-11-15 by the unsized-sweep lane while auditing the S2 sweep of std and src (`vbd/unsized-sweep`).

## Reproducer

`issues/repros/2026-11-15-migrate-unsized-lists-one-line-dyn-sites-holding-a-template-literal-or-a-bracket-in-a-string.yo` has three one-line `dyn(...)` sites:

```yo
a :: (fn() -> Box(Dyn(Show)))(dyn(`hi`));
b :: (fn() -> Box(Dyn(Show)))(dyn(String.from("a[b")));
c :: (fn() -> Box(Dyn(Show)))(dyn(String.from("ab")));
```

`yo fix <file> --migrate unsized`, run with a pre-flip v0.2.78 tree binary, rewrites only `c`. It lists the other two:

```text
fix: <file>:4:31: `dyn(("hi".to_string)())` does not print back on one line; write it `dyn(Box.new(("hi".to_string)()))` by hand; left as written
fix: <file>:5:31: `dyn((String.from)("a[b"))` does not print back on one line; write it `dyn(Box.new((String.from)("a[b")))` by hand; left as written
```

## Root cause

A recorded `dyn(<arg>)` site is applied only when `_expr_span_end` (`src/main.yo`) finds a span of the source line that parses to an expression printing exactly as the recorder's text. Two things defeat that search:

1. **Template literals.** The recorder prints the argument as the evaluator saw it, after the template literal has been desugared (`("hi".to_string)()`, or a `begin(__yo_tpl_N := …)` block for an interpolating one, whose gensym never matches). The source span parses to the template node, which prints differently.
2. **Brackets inside string literals.** `_expr_span_end`'s depth counter counts `(`, `[` and `{` without skipping string or template literal contents. `"a[b"` leaves the depth at 1, so no candidate end is tried.

The `Dyn(...)` type path uses the same helper, but a type spelling rarely holds a string literal.

## Fix direction

- Skip string and template literal contents in `_expr_span_end`'s depth scan.
- Locate a recorded `dyn(...)` site by its token position instead of matching printed text: the recorder already knows the call's row and column. The argument span is then the bracket-balanced text up to the matching `)`. Alternatively, compare against a print of the parse rather than of the evaluated expression.
- When a site is listed, word the message by the real reason, and quote the source text, not the desugared print.

The repro then becomes a test: all three sites rewritten, a second run a no-op.
