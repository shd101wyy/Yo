# `arc(k)` of a capture-free closure still emits two `Arc` instantiations, so clang rejects a valid program

**Found:** 2026-09-25, while probing `issues/function-values-bypass-the-d1-reach-walk.md`.
**Status:** FIXED 2026-09-25. Was: OPEN. **Class:** valid code fails to compile (codegen). The residual of
`issues/fixed/arc-of-a-send-closure-emits-two-capture-struct-typedefs.md` (P-26).
**Measured:** tree-built compiler at `ps/phase2-iso` `d8280ec37`, macOS arm64.

## Repro

`issues/repros/arc-of-a-capture-free-closure-emits-two-arc-typedefs.yo`: a closure that
captures nothing (its body is `println("ran")`), bound to `(k : Impl(Fn() -> unit))`, wrapped
with `arc(k)`, read back as `f := a.*` on a spawned thread and called. `yo check` is green;
`yo compile --optimize 2` fails:

```
error: incompatible pointer types returning '__yo_t_17335061386286930355 *' from a function
       with result type '__yo_t_1628345691991984787 *'
```

The emitted `arc` specialization declares one `Arc` instantiation as its return type and
constructs another in its body, which is P-26's shape exactly. The P-26 canary, a closure that
captures an `AtomicI32`, compiles and runs.

## Mechanism (traced 2026-09-25, struct ids at every stage)

`Arc(...)` instances are keyed by their type-argument slots (`type_key`: a SomeT argument hops
through its resolution cell unless it is an `Impl`/nameless wrapper). The body's `Arc(V)(value)`
built `Arc[k's Impl SomeT]`. Three places produced a DIFFERENT instance for the specialization's
registered return, and all three had to be fixed:

1. **The mint's binder.** `create_specialized_function_inline`'s declared-param bridge
   (`src/evaluator/calls/helper.yo`) rebinds `V` to the closure argument's capture struct. A
   capture-free closure has none, so `V` stayed the signature's own SomeT and the return
   re-evaluation built `Arc(V)`. It now binds `V` to the closure's `Impl` SomeT, the type the
   body binds it to, and the re-evaluated `Arc[k's SomeT]` is adopted (P-26's existing rule).
2. **The mint's positional substitution.** It then re-substituted the DECLARED return
   (`V := <param type>`) and overwrote the adopted one. An adopted return is kept now.
3. **The FuncVal arm's re-registration** (`src/evaluator/calls/function.yo`). It re-registered
   the specialization with its own substitution-based `resolved_ret`, which was `Arc` over a
   capture struct. The call site and the prototype used that, while the body built the mint's
   instance, and clang rejected the return. The arm adopts the mint's return when every SomeT
   it carries (type arguments included) is one of the call's closure-typed forall arguments.

Found on the way (`src/evaluator/types/function.yo`): the call-time where-clause re-application
pushed `Send` and `Acyclic` onto the caller's closure SomeT after judging them, so the closure's
own type mutated mid-call (`Impl : (Fn() -> unit)` became `... + Send + Acyclic`) and afterwards
DECLARED markers nothing proved. A bound the type's values discharged is no longer pushed.

## Fix

The three changes above, plus the where-clause one. The capturing case, P-26's own canary, is
unaffected: its `V` was already bound to the capture struct.

## Regression test

"D4/D9 canary: arc() of a capture-free closure runs on a thread" in
`tests/parallelism_soundness.test.yo`: clang rejected its batch before the fix.
