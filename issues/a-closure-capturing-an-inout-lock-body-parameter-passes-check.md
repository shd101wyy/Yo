# A closure that captures the `inout(v)` parameter of a `with_lock` body passes `yo check`

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-4).
**Status:** OPEN. **Class:** `yo check` accepts what the memory-safety rules forbid ("closures
cannot capture ctl-typed or ref-bound values", `plans/reference/MEMORY_SAFETY.md` Phase B,
relied on by `plans/archive/THREAD_SAFETY.md` vector 15 for the lock-escape argument). The C
compiler rejects the emitted code (`call to undeclared function '__yo_fs_…'`), so there is no
runtime hole today; the rule is simply not enforced by the evaluator.
**Measured:** yo 0.2.41 seed against the develop tree's `std`, macOS arm64.

## Repro

`issues/repros/closure-captures-inout-lock-parameter.yo`:

```rust
Counter :: struct(n : i32);
main :: (fn() -> unit)({
  m := Mutex(Counter).new(Counter(n : i32(0)));
  (keep : Option(Impl(Fn() -> unit))) = Option(Impl(Fn() -> unit)).None;
  m.with_lock((v) => {
    (k : Impl(Fn() -> unit)) = (
      () => {
        v.n = (v.n + i32(1));        // captures the second-class `inout(v)`
      }
    );
    k();
    keep = Option(Impl(Fn() -> unit)).Some(k);   // and escapes it past the unlock
  });
  match(keep, .Some(k2) => k2(), .None => ());
});
```

`yo check`: green. `yo compile`: `error: call to undeclared function '__yo_fs_17495593113544445200'`
(the `with_lock` specialization is never emitted).

## Why it matters for parallelism

`Mutex(T).with_lock` has no guard type; the ONLY thing that keeps the protected value inside the
critical section is that `inout(v)` cannot be stored, returned or captured. If a closure may
capture it, the closure can be stored (as above) or sent (through a `Channel` of a Send closure)
and run after the unlock, or on another thread — a write to `Mutex`-protected state with no lock
held. Today codegen happens to fail; the evaluator is the gate that should fail.

## Fix direction

Wherever the capture set of a closure is enriched (`enrich_captured_variables`,
`src/evaluator/utils/closure.yo`), a captured variable whose binding is an `inout`/`ref`
parameter (or any control-bound binding) is an error at the capture token: "closure cannot
capture the second-class parameter 'v'". Regression: this repro as a `comptime_expect_error` in
`tests/sync/mutex.test.yo`, plus the canary that a closure INSIDE the body that captures a
plain local copy (`c := v; (k) = (() => c.n)`) is accepted.
