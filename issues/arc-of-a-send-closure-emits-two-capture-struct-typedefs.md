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

## Mechanism (READ 2026-09-26, tree-built compiler at develop 848fc09c4 + Phase 1)

Not a capture-struct problem at all: the two typedefs are two instantiations of `Arc`. In the
emitted C the `arc` specialization is declared

```c
static inline __yo_t_7166924921173181532* yo_id_…_Impl____Fn______unit___Send___Acyclic__…(…)
//                 ^ struct __yo_t_7166924921173181532_struct { … } // Arc(V : (Send + Acyclic))
  __yo_t_6030970656195994572* tmp = __yo_new___yo_t_6030970656195994572(value);
//                 ^ struct __yo_t_6030970656195994572_struct { … } // Arc(Impl : (Fn() -> unit + Send + Acyclic))
  __yo_t_7166924921173181532* __yo_scope_ret = tmp;   // clang: incompatible pointer types
```

The specialization's RETURN type is `Arc(V)` evaluated with `V` still the unresolved bound
variable (`V : (Send + Acyclic)`), while the body's constructor call evaluates `Arc(V)` with `V`
resolved to the closure's `Impl` SomeT — and `Arc` is a nominal type constructor, so the two
evaluations mint two struct ids. For a nominal argument (`arc(i32(1))`) both evaluations resolve
`V` the same way; a closure-typed argument is the case where the bound variable's identity
differs between the signature and the body. This is the "one notion of type identity for
resolved type variables" problem of `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 3, not a parallelism
one; handed over to that plan (2026-09-26), and `plans/PARALLELISM_SOUNDNESS.md` Phase 4 keeps
only the D4 consequence (the legal `arc(closure_over_atomic)` canary waits on it).

## Why it matters for the parallelism plan

D4 (`plans/reference/PARALLELISM_RULES.md`) makes a closure type `Send` iff its captures are, so
`arc(closure_over_atomic)` becomes the canonical LEGAL shape and must compile; the D4 canary in
`tests/parallelism_soundness.test.yo` is written against a generic `where(T <: Send)` call
instead until this is fixed, and Phase 4 of the plan carries this fix as a prerequisite.

## Regression test

The repro as a runtime test (`hits=1`) in `tests/arc.test.yo` once fixed, plus the D4 canary in
`tests/parallelism_soundness.test.yo` switched to the `arc` form.
