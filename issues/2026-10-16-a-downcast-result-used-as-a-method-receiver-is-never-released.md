# A downcast result used as a method receiver is never released

**Severity:** S2 — `downcast(d, T).is_some()` (any method called directly on a `downcast` result) leaks the reference the downcast took on the payload, once per evaluation; a check in a loop grows without bound.

**Found:** 2026-10-16, the last leak verdicts of the family in `issues/fixed/local-leak-verdicts-fail-28-async-tests-ci-cannot-see.md`, after the async classes were fixed. `tests/dyn.test.yo` with leak verdicts on fails "Test downcast type check via is_some" and "Test downcast to a value type that no dyn() in the program wraps" (72 bytes in 3 allocations each) and "Dyn: upcast drops traits and keeps each payload's impls" (24 bytes). All three call `.is_some()`/`.is_none()` on a `downcast(...)` directly. Reproduces on develop `b0c4630d3` (`fix/async-capture-leaks`'s build too: nothing there touches it).

## Reproducer

```yo
{ assert } :: import("std/assert");
{ ToString } :: import("std/fmt");
Cat :: ref(struct(n : i32));
impl(Cat, ToString(to_string : (self -> `cat`)));
main :: (fn() -> unit)({
  (animal : Dyn(ToString)) = dyn(Cat(n : i32(1)));
  assert(downcast(animal, Cat).is_some(), "a cat");
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system -o r && ./r`: `SUMMARY: AddressSanitizer: 12 byte(s) leaked in 1 allocation(s)` (the `Cat`). Binding the result first (`d := downcast(animal, Cat); assert(d.is_some(), …)`) does not leak: the local's scope-end drop releases it.

## Root cause

Not traced yet. The `.Some(payload)` a `downcast` returns owns a +1 on the payload; as a method receiver it is a temporary whose drop is missing (the receiver path of the method-call emitter, or the `downcast` builtin's result temp not being registered as an owning temp).

## Fix

TBD. The regression test is the three `tests/dyn.test.yo` tests above with leak verdicts on, plus a `Drop`-counter version (a `ref` payload whose `Drop` counts) so CI sees it.
