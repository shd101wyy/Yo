# yo-self: dyn vtable wrappers were abort() stubs — `*(Self)` missed by the Self-level finder

**Status: FIXED** (this commit). Flips `tests/dyn.test.yo` (5/8 → 8/8).

## Symptom

Every `dyn(box(<value>))` dispatch aborted at runtime (rc=134). The emitted C
showed ALL `__yo_wrap_*` vtable wrappers as
`abort(); /* dyn method unavailable: impl fn skipped (degraded type) */`
(codegen/functions/dyn.yo) — `should_skip_function_codegen` classified the
`impl(i32, TestDyn(...))` methods as hard-generic. Probe (PROBE-DYNSKIP):
the registered func type was `fn(self : *(Self)) -> i32` — `Self`
unsubstituted.

## Root

`_find_self_level_in_method_ty` (evaluator/values/impl.yo) scanned only
TOP-LEVEL `SomeT` params and the top-level return for a SomeT named "Self".
The standard by-ref trait method signature is `fn(self : *(Self))` — a
`Pointer(SomeT)` — so the finder returned `.None`, `_substitute_self_in_
method_ty` never built the substitution, the impl lambda was evaluated and
registered against the trait's abstract `*(Self)`, and the hard-generic skip
stubbed both the method and its vtable wrapper.

Same landmine family as `type_id_or_empty`'s missing Pointer case
(issues/fixed/yo-self-forward-ref-impl-pointer-receiver-uncollected.md): **any
type-shape dispatch that ignores `Pointer` silently no-ops for every
pointer-receiver method.** TS needs no finder — its `SelfType` context +
`substitute` walk the whole type by object identity.

## Fix

Add `Pointer(SomeT "Self")` cases to the finder's param loop and return
check. The existing `substitute()` already walks pointers once the level is
known, so all `Self` occurrences in the method type resolve.

## Verification

- Repro /tmp/dyn_repro.yo: `use_test_dyn(dyn(box(i32(42))))` → prints
  `i32 value: 42`, r=42 (was rc=134).
- dyn.test.yo 8/8 (was 5 passed / 3 failed).
- Full battery + STRICT_FIXPOINT — see commit.
