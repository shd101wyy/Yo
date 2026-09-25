# `arc(k)` of a capture-free closure still emits two `Arc` instantiations, so clang rejects a valid program

**Found:** 2026-09-25, while probing `issues/function-values-bypass-the-d1-reach-walk.md`.
**Status:** OPEN. **Class:** valid code fails to compile (codegen). The residual of
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

## Mechanism

To be read with a trace. P-26's fix in `create_specialized_function_inline` adopts the return
type's re-evaluation when every SomeT it carries is one of the call's closure-typed forall
arguments (`_somes_are_closure_forall_args`). With no captures, the argument's recorded type is
not that SomeT (see `final_lambda_ty` in `values/anonymous_function.yo`), so the adoption does
not fire.

## Regression test

The repro as a runtime test in `tests/parallelism_soundness.test.yo` next to the P-26 canary.
