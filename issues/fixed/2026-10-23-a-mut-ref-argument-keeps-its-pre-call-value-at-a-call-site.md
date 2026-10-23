# Verifier: a `&mut` argument keeps its pre-call value at a call site

**Severity:** S1 — `yo verify --strict` proves a false `ensures` in fully verified code, and a verify-mode `yo compile` erases the runtime check: a callee that writes through a `&mut` parameter leaves the caller's variable at its pre-call value in the proof.

- **Status:** fixed (filed and fixed 2026-10-23, found while triaging
  `issues/fixed/2026-10-23-the-call-site-frame-misses-a-list-reached-through-a-refcell-global.md`).
- **Component:** `src/verifier/vc.yo`, the call-site mutation model (`_callee_call_term`).

## Reproducer

`tests/spec/fixtures/negative/inout_call_frame.yo`:

```yo ignore
pragma(Pragma.Verify);
bump :: (fn(x : &mut i32, requires(x < i32(100)), ensures(true)) -> unit)({
  x = (x + i32(1));
});
after_bump :: (fn(n : i32, requires(n == i32(0)), ensures(r == i32(0))) -> (r : i32))({
  (mut(y) : i32) = n;
  bump(&mut y);
  y
});
```

Before the fix both functions reported `ok` under `--strict`, and a
verify-mode binary calling `after_bump(0)` printed `1`. The same holds for a
runtime-mode `bump`. When the callee's contract did say `old(v)`
(`ensures(v == old(v) + 1)`), the caller got a subset error instead:
"old(...) of 'v' — the name is not bound at function entry".

## Root cause

`_callee_call_term` rebound an argument only when its term had a list sort
and the contract mentioned `old(<param>)`. A `&mut` scalar argument was
never rebound, so the caller kept its pre-call term; and because nothing
was rebound, `ctx.call_pre` stayed unset and the callee's `old(v)` fell
through to the caller's function-entry snapshot. The callee-side check in
`verify_function_body` covers only list parameters, so neither side caught
it.

## Fix

At every call, an argument written through a `&mut` parameter (the
callee's `param_is_ref`, or a `&mut name` argument) is rebound to a fresh
term of its sort, the callee's parameter is bound to that term while the
ensures are assumed, and `old(<param>)` reads the pre-call term. A `&mut`
argument that is not a plain name is a subset error. The loop and branch
havoc scan (`_scan_assigned`) adds such names too.

## Test

- `tests/spec/fixtures/negative/inout_call_frame.yo`: `after_bump` is refuted.
- `tests/spec/fixtures/valid/inout_call_old.yo`: `twice_bumped` proves
  `r == n + 2` through `inc`'s `ensures(v == old(v) + 1)`.
- Both are pinned in `tests/internal/verifier_list_len.test.yo`.
