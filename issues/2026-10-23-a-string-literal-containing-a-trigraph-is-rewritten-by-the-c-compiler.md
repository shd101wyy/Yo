# A string literal containing a trigraph is rewritten by the C compiler

**Severity:** S2 — silently wrong program output: `println("??=")` prints `#`,
and the length taken from the Yo literal then overruns the shorter C literal
(ASan `global-buffer-overflow`).

**Status:** open. Found 2026-10-23 by the adversarial review of branch
`fix/derive-early-return-drop`. Present with the v0.2.68 seed and a
develop-built binary (`6dee22187`).

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  println("what??/ is ??= this??!");
});
export(main);
```

Prints `what is # this|` instead of the literal text. Under
`--sanitize address --allocator system` the run also reports
`AddressSanitizer: global-buffer-overflow` (`'.str.1' is ascii string 'what is # this|'`).

## Root cause

The C string-literal emitters escape `"`, `\` and control bytes but not `?`,
and the driver compiles with `-std=c11`, under which clang and gcc both
replace the nine trigraphs (`??=`, `??/`, `??'`, `??(`, `??)`, `??!`, `??<`,
`??>`, `??-`) inside string literals. `??/` becomes a backslash that escapes
the next character, so a `??/` before a closing quote breaks the C.

## Fix direction

Escape `?` as `\?` in every C string-literal emitter (user strings and
`_idx_c_string_literal` in `src/codegen/utils/index.yo`); it is portable,
unlike `-fno-trigraphs`. Add a test that a literal containing each trigraph
round-trips.
