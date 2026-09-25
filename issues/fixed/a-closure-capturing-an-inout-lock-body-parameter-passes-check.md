# A closure that captures the `inout(v)` parameter of a `with_lock` body passes `yo check`

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-4).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 4, rule D8 of `plans/reference/PARALLELISM_RULES.md`). Was: **Class:** `yo check` accepts what the memory-safety rules forbid ("closures
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

## Root cause and fix (2026-09-26, rule D8)

The rule was already there: `_check_anon_fn_captures` (`src/evaluator/values/anonymous_function.yo`)
throws "Cannot capture inout binding 'v' in a closure" for the inner closure `k`. But `k` is
created while the ENCLOSING closure (the `with_lock` body) is trial-evaluated at definition time,
and that trial swallows every throw — `YO_DEBUG_SWALLOW=1` shows it as `[anon-swallow]`. The body
came out hollow, `check` stayed green, and codegen died on the never-emitted specialization.
(On current develop the repro as written stops earlier, at E0613 — `with_lock`'s `R` cannot be
inferred from a `unit` body — so the regression fixture annotates the result: `(_u : unit) =
m.with_lock(...)`.)

Fix: the two closure-capture rejections (the `inout`/`ref` binding and the control-bound value)
go through `_raise_capture_rejection`, which flags the message on the flow-violation channel
before throwing, the same pattern as the Send-capture check (`_raise_capture_trait_violation`).
The enclosing trial's Channel 1 then re-raises it through the real `exn`; because that re-raise
lands on the enclosing definition's token, the flagged message carries the capture site:
`… (captured at main.yo:10:16)`.

Tests: `tests/cli-cases/check-closure-captures-lock-inout-rejected` (check-level: a
`comptime_expect_error` observes the def-time error even while `check` swallows it, so it could
not have been red before the fix), plus a corpus block and the existing D8 canary (a closure over
a local COPY of `v` stays legal) in `tests/parallelism_soundness.test.yo`.
