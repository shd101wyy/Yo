# `yo verify` fails on an `ArrayList.push` of an element type without `Eq`

**Severity:** S2 — `yo verify` rejected every program that pushes a struct without `Eq` into an `ArrayList`, with a type error inside std; the compiler's own front-end verify sweep went red on develop.

**Status: FIXED** (branch `fix/push-ensures-needs-eq`). Found 2026-10-03: develop's
"Self-verification sweep (front end, ratcheted)" job failed on every run since
#1128 (first seen on `d2069148e`).

## Reproducer

```rust
{ ArrayList } :: import("std/collections/array_list");
_P :: struct(a : i32);
build :: (fn() -> usize)({
  xs := ArrayList(_P).new();
  xs.push(_P(a : i32(1)));
  xs.len()
});
export(build);
```

`yo verify main.yo --std-path ./std`:

```
error[E0610]: No matching call found for operator "==" with receiver type "_P"
yo: error: verify: 1 file(s) failed evaluation
```

In the sweep, the same error came from `src/parser.yo`'s
`ArrayList(_TemplateBodyOrigin)`.

## Root cause

#1128 gave `ArrayList.push` a proof-only element clause,
`forall(k, (k < self.len()) ==> (self(k) == …))`. `T` has no `Eq` bound, and
none can be added there. At a monomorphized call site, the verifier evaluates
CLONES of the callee's contracts with the concrete types bound (V6 task 2,
`_stash_callsite_contracts` in
`src/evaluator/builtins/contracts.yo`). That evaluation propagated the
evaluator's `==` error as a hard failure. The definition-time trial swallows
the same failure for generic bodies.

## Fix

A callee ENSURES clause that does not evaluate at a call site is dropped for
that call. Assuming less about the callee is sound, and the length clause is
a separate clause that still proves. REQUIRES clauses keep the propagating
handler: dropping one would skip a precondition. The unwound evaluation's
ghost flag and environment frames are restored. `YO_DEBUG_SWALLOW=1` prints
each dropped clause.

A std-only guard (`cond(Type.impls(typeof(value), Eq(typeof(value))) => …,
true => true)`) was tried first and rejected. The verifier sees the guard as
an untyped expression, so #1128's four proofs (`dml_append_seq`,
`dml_sorted_insert`, `for_produced`, `lemma_member_frame`) and their negative
twins became subset errors.

## Test

`tests/spec/fixtures/invalid/push_non_eq_element.yo`, driven by
`tests/internal/verifier_list_len.test.yo` ("push of an element type without
Eq"): two pushes of a struct without `Eq`; the file now loads and
the function gets its own outcome (a struct parameter is outside the verifier subset).
