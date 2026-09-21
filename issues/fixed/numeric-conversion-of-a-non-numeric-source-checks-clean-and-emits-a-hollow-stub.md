# `usize(x)` with a non-numeric `x` checks clean and compiles to an abort() stub

**Status:** FIXED 2026-09-22. Found while looking for a pointer-identity
primitive for the memory plan (F5): `usize(p)` on a raw pointer passed
`yo check` and the compiled program aborted at the call.

## Repro (v0.2.38 and develop before the fix)

```rust
{ String } :: import("std/string");
as_len :: (fn(s : String) -> usize)(usize(s));   // String → usize?
```

- `yo check` → rc=0, `evaluator OK`.
- `yo compile` → rc=0; the emitted C carries
  `__attribute__((error("yo: the body of … failed to transpile — its
  definition-time evaluation failed and was swallowed …")))` on `as_len`, and
  the binary prints `yo: FATAL: reached …` and aborts when it is called. With
  the conversion in `main` itself: `internal compiler error: Failed to
  transpile part of main's body`.
- Same for a `bool` source (`usize(flag)`) and a raw pointer (`usize(p)`
  under `unsafe`). A numeric source in the same shape (`usize(i32(7))`)
  emits clean.

## Root cause

`try_to_convert_to_numeric_type` (`src/evaluator/calls/numeric_type.yo`)
validated the SOURCE type after the enum-discriminant case and, for anything
non-numeric, took a "soft fallback": an `UnknownVal` of the target type with
no `__yo_as` lowering, so that prelude/std operator forms the BOOTSTRAP
evaluator could not yet resolve (a `t_unit()` placeholder) would type-check.
The bootstrap is long gone, but the fallback still swallowed every concrete
non-numeric source: the call had a type, `check` was green, and codegen —
which only knows how to emit the `__yo_as` node — found nothing and left a
`// Failed to transpile` marker that the stub rewrite turns into `abort()`.
A `codegen_fatal` reachable from user source is a missing evaluator check
(AGENTS.md).

## Fix

The fallback is reserved for sources the evaluator has genuinely not
resolved yet — the unit placeholder and an open type variable (`SomeT`) in a
definition-time trial, which the resolving specialization converts for real.
A CONCRETE non-numeric source throws at check time:

```
Cannot convert a value of type String to usize: `usize(x)` converts integers,
floats, enum discriminants and C-compatible values only
```

Pointer → integer conversion is NOT added here: today no spelling of it
exists (`usize(p)` now errors instead of aborting), and adding one is a
design decision for the pointer-operations family
(`plans/archive/POINTER_OPERATORS_TO_TRAITS_AND_METHODS.md`), recorded as
the open need in plans/EVALUATOR_MEMORY_REDUCTION.md F5 (type-variable cell
identity wants an address).

## Gate

`tests/cli-cases/check-numeric-conversion-rejects-non-numeric-source`: the
String-source fixture under `yo check`; the seed passes it (rc=0, the bug),
the fixed compiler rejects it (rc=1, the diagnostic is the kept substring).
Plus `yo check ./src` and `./std` (no real site relied on the fallback — the
extern-C opaque case has its own arm), the language suite and `gates_fast`.
