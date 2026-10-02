# An underscore in a float literal silently truncates the value — `1_000.5` compiles to `1.0`

> **FIXED 2026-10-02.** `parse_raw_float` strips `_` before the `atof` call,
> exactly as `parse_raw_int` always did (`raw.replace_all(`_`, ``)` — one
> line in `src/evaluator/utils.yo`). Pinned by "an underscore in a float
> literal is a digit separator" in `tests/float_non_finite_constants.test.yo`
> (`1_000.5 == 1000.5`, `1_0e5 == 100000`, at runtime and comptime) and the
> token-level companion in `tests/internal/lexer.test.yo`.

**Severity:** S1 — silently wrong results: a float literal with `_` separators
compiles to a different number than its text says, with no diagnostic

Found 2026-10-02 by the post-#1092 lexer/parser/formatter audit workflow
(confirmed independently by a second pass: comptime equality plus the emitted C).

## Reproducer (pre-fix)

```rust
main :: (fn() -> unit)({
  v := 1_000.5;      // parses as 1.0
  e := 1_0e5;        // parses as 1.0
  i := 1_000;        // parses as 1000 — the INTEGER form was always correct
});
export(main);
```

## Root cause

The lexer's digit loops accept `_` in all three positions — integer
(`src/lexer.yo`, the number-literal branch), fraction and exponent — so
`1_000.5` lexes as ONE Float token with raw text `1_000.5`. Integer literals
were fine because `parse_raw_int` (src/utils.yo) strips `_` before parsing.
`parse_raw_float` (src/evaluator/utils.yo) did not: it handed the raw text to
C `atof`, which stops at the first `_` and returns what it parsed so far —
`1`. Every float literal flows through this one function (the Float token's
evaluation, `f64(x)`/`f32(x)` casts of raw literals, and the comptime numeric
builtins), so the truncation was uniform, and silent: the folded constant,
the emitted C and runtime comparisons all carried `1.0`.

Identical on seed v0.2.48 (pre-existing, not a #1092 regression).
