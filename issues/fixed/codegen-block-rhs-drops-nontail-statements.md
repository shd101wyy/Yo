# Codegen: block-RHS initialization drops non-tail statements

**Status: FIXED** (2026-06-11). Root cause: a runtime-condition `cond` whose
arms are all unit-typed annotates itself with a typed UNKNOWN value
(`createUnknownValue`), and the begin evaluator's fold check
(`hasRuntimeSideEffects`) treated any non-undefined value — including
UnknownValue — as compile-time, folding the block to its tail value;
codegen then emitted only the constant. Fix: only a CONCRETELY known value
proves a non-tail statement effect-free (`isUnknownValue` now also marks
runtime side effects) — src/evaluator/exprs/begin.ts, mirrored 1:1 in
yo-self/evaluator/exprs/begin.yo. Regression tests:
tests/block_rhs_nontail_statements.test.yo (early return + conditional
mutation both preserved; repro now prints 10).

Originally: OPEN (discovered 2026-06-11 while testing the shadowed-binding
double-drop fix; reproduced on the committed compiler `85c56747`, so it was
pre-existing and unrelated to that fix).

## Symptom

A begin-block used as the RHS of an initialization loses its non-tail
statements in the generated C — only the tail value expression survives.
Control flow (an early `return` inside a `cond`) is silently eliminated.

## Minimal reproducer

```rust
open(import("std/fmt"));

f :: (fn(flag : bool) -> i32)({
  inner := {
    cond(
      flag => {
        return(i32(10));
      },
      true => ()
    );
    i32(20)
  };
  inner
});

main :: (fn() -> unit)({
  println(`${f(true)}`);  // prints 20 — MUST print 10
});

export(main);
```

`f(true)` must take the `return(i32(10))` path; the compiled program prints
`20`. Generated C for `f` contains no trace of the `cond`:

```c
static inline int32_t fn_..._f(bool flag) {
  int32_t _yo..._temp = 20;     // ← cond/return gone entirely
  int32_t inner = _yo..._temp;
  return inner;
}
```

The evaluator accepts the program (no diagnostic); this is a codegen-side
(or evaluator-annotation-side) elimination of statements preceding the tail
expression of a block-RHS.

## Notes

- The same statements emit correctly when they appear directly in a
  function body or match-arm begin block; the trigger is specifically
  `name := { stmt; ...; value }`.
- Suspect: the initialization-assignment path treats the begin-RHS as a
  value expression and emits only its tail/`variableName` result without
  walking the leading args (compare `generateCaseBody`'s begin handling in
  `src/codegen/exprs/match.ts`, which iterates `beginArgs` explicitly).
- Severity: silent wrong-code (skipped side effects, skipped control flow).
