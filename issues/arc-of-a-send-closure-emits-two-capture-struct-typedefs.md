# `arc(f)` of a closure emits two capture-struct typedefs for the one closure, so the C compiler rejects it

**Found:** 2026-09-25, while writing the D4 over-rejection canary for
`tests/parallelism_soundness.test.yo` (`plans/PARALLELISM_SOUNDNESS.md` Phase 0).
**Status:** OPEN. **Class:** valid code fails to compile (codegen). It is ALSO the accident
that currently keeps `issues/a-capturing-closure-type-satisfies-a-send-bound-so-arc-and-channel-accept-it-at-check.md`
from being a runtime hole: the non-Send case fails in clang for the same reason the Send case
does.
**Measured:** yo 0.2.41 seed against the develop tree's `std`, macOS arm64.

## Repro

`issues/repros/arc-of-a-send-closure-emits-two-capture-struct-typedefs.yo`: a closure whose
only capture is an `AtomicI32` (so it IS `Send`), wrapped with `arc(bump)`, read back as
`f := a.*` inside a `Thread.spawn` closure and called.

```
error: incompatible pointer types returning '__yo_t_… *' (aka 'struct __yo_t_…_struct *')
       from a function with result type '__yo_t_… *' (aka 'struct __yo_t_…_struct *')
```

`yo check` is green. The same shape through `Channel(typeof(f))` fails identically.

## Mechanism (not yet read)

The `arc` specialization at `V = <closure type>` and the `Arc(V)` constructor emit the closure's
capture struct under two different C type names (one per resolution of the closure's SomeT, it
appears), and the `__yo_new_`/getter of the `Arc` returns one while the caller expects the
other. Where the two names come from — `resolve_some_type_to_concrete` on the `Impl(Fn)`
wrapper vs the registered capture struct — is the thing to read first
(`src/codegen/exprs/closures.yo`, `src/codegen/types/collection.yo`).

## Why it matters for the parallelism plan

D4 (`plans/reference/PARALLELISM_RULES.md`) makes a closure type `Send` iff its captures are, so
`arc(closure_over_atomic)` becomes the canonical LEGAL shape and must compile; the D4 canary in
`tests/parallelism_soundness.test.yo` is written against a generic `where(T <: Send)` call
instead until this is fixed, and Phase 4 of the plan carries this fix as a prerequisite.

## Regression test

The repro as a runtime test (`hits=1`) in `tests/arc.test.yo` once fixed, plus the D4 canary in
`tests/parallelism_soundness.test.yo` switched to the `arc` form.
