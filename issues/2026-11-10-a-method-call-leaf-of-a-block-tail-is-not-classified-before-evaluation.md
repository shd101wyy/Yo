# A method-call projection leaf of a block, `cond` or `match` tail is a value, not the reference R-TAIL binds

**Severity:** S3 — a rough edge: the chain still compiles and yields the referent's value (a copy for a `Copy` referent, E0901 for a move-only one), where VERDICTS-41 Q1's R-TAIL says it binds the reference.

Filed 2026-11-10 by the plane-c lane (P2, `&x` as an expression and R-TAIL).

## Symptom

```yo ignore
z := { w := i32(0); s.get() };       // s.get() : &i32, a method projection
```

R-TAIL (VERDICTS-41 Q1) binds `z` as a `&i32` into `s` when EVERY leaf of the result chain is a reference. The pre-evaluation classification (`ref_chain_leaves_of`, `src/evaluator/utils.yo`) recognizes a lend `&place`, a call of a NAMED function whose result is a reference, and (VERDICTS-44 PR 3) a reference-binding atom. A method call `s.get()` is not recognized: its callee is resolved only by evaluating the receiver, so the chain is classified as a value chain (the mixed chain of Q1 item 2) and `z` is the `i32` value.

## Root cause

`_ref_chain_collect` looks the callee up by name in the environment; a `.`-callee has no variable of that name, and the receiver-method dispatch runs inside evaluation. The leaves must be registered (`chain_ref_leaf_register`) BEFORE the chain is evaluated so that `reference_read_wanted` sees them.

## Fix direction

Evaluate the receiver's type first (a type-only pre-pass over the receiver atom/field path), or register a method leaf speculatively and retract it if the resolved callee's result is not a reference. The pinning test is `tests/origins/reference_read_rule.test.yo` ("A method-call projection leaf of a block tail reads as its value today"); flip it when the gap closes.
