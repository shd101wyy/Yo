# A quantified `ensures` was spliced as a runtime assert, and its callers failed to compile

**Severity:** S2 — a valid program was rejected. A function whose `ensures` uses
`forall`/`exists` (or calls a `ghost_fn`) could not be called from an ordinary,
non-verified file. Every such program failed with
`ghost-only builtin (legal only inside contract clauses, ...)`.

**Status:** FIXED 2026-10-01 (`feat/verifier-lemmas`).

## Symptom (measured: the released v0.2.48 compiler)

```rust
positive_floor :: (fn(x : i32, requires(x > i32(0)), ensures(forall(k : i32, (k <= i32(0)) ==> (k < r)))) -> (r : i32))(x);
main :: (fn() -> unit)({ println(positive_floor(i32(3)).to_string()); });
```

`yo compile` exits 1 with `ghost-only builtin`. In a `Pragma.Verify` file the
`ensures` splice is suppressed, so only the verified case worked.

## Cause

`wrap_function_body_with_contracts` (`src/evaluator/builtins/contracts.yo`)
spliced every `ensures` clause as an `assert` after the body. The `requires`
side already had a filter, `requires_is_runtime_checkable`; `ensures` had none.
A quantifier evaluated in runtime code is the ghost-only error.

## Fix

`ensures_is_runtime_checkable` follows the `requires` rule, except that
`old(...)` is allowed, since the splice snapshots it at entry. Only those clauses
are spliced, in every mode. A quantified clause is proof-only, as a quantified
`requires` already was.

This is what lets std state `ArrayList.push`'s elements inside a `forall`
(R2 slice 2). Spelled as a plain `==` on `T`, the clause was spliced and failed
for every `T` without that `==`.

## Regression test

`tests/spec/contracts_phase0.test.yo`, "a quantified ensures is proof-only; a
checkable ensures beside it still asserts".
