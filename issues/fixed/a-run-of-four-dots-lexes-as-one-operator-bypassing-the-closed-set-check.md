# A run of four or more dots lexes as ONE Operator token, bypassing the closed-set check

> **FIXED 2026-10-02.** The dot branch counts the run before its suffix
> checks (`dot_run_len`) and throws the closed-set lex error — the same
> diagnostic the operator-run branch gives — when the run exceeds three dots
> (src/lexer.yo). `...#` still lexes: the count is of DOTS, taken before the
> `#` widens the consumed span. Pinned by "A run of four dots is a
> closed-set lex error" in `tests/internal/lexer.test.yo`.

**Severity:** S3 — diagnostics quality: `x .... x` surfaces as an evaluator
E0610 "No matching call found for operator ...." instead of the lexer's
closed-set lex error that docs/en-US/GRAMMAR.md promises

Found 2026-10-02 by the post-#1092 lexer/parser/formatter audit workflow.

## Reproducer (pre-fix)

```rust
main :: (fn() -> unit)({
  x := 1;
  y := (x .... x);   // error[E0610]: No matching call found for operator "...."
});
export(main);
```

## Root cause

The dot branch consumed the ENTIRE dot run and pushed one token with
`kind := cond(((j - i) == 1) => Dot, true => Operator)` — no membership or
length validation, unlike the operator-run branch, which checks every split
against the three/two/one-char tables and throws "unknown operator … Yo has
a closed operator set". A four-dot run therefore became a single `....`
Operator token that only died much later, in the evaluator. Identical on
seed v0.2.48 (pre-existing).
