# A block result that is not moved is never released

**Severity:** S1. Every value-producing block expression whose owning result is not moved into a binding, a `sink` parameter or a return leaked one reference per evaluation. That covers a call argument, a method receiver, `&{...}`, a discarded statement, and every quote-block constructor macro used as a temporary (`array_list(...)` expands to such a block).

**Status:** FIXED 2026-10-14. Isolated by the 2026-10-14 S1 triage of `issues/self-hosted-emit-leaks-remaining-classes.md`, as one class that was still live.

## Symptom

On seed v0.2.62, with a `Dispose` counter on a `ref` struct:

```yo ignore
_n := at_read({ t := ArgTemp(n : i32(20)); t });   // released 0 times, want 1
{ t := ArgTemp(n : i32(21)); t };                   // released 0 times, want 1
_m := { t := ArgTemp(n : i32(22)); t }.n;           // released 0 times, want 1
b := { t := ArgTemp(n : i32(24)); t };              // released once (correct)
```

`leaks --atExit` on `len_of(array_list(i32(5)))` in a 100-iteration loop reports 200 leaks.

## Root cause

This is the same class as `issues/fixed/match-or-cond-call-argument-result-is-never-released.md` (#893), whose fix covered `match` and `cond` but not `begin`.

- The evaluator is correct: it attaches an owning temp to the block's result, and `_schedule_scope_end_drops` schedules the drop (`YO_DEBUG_SCOPE_DROPS=1` shows `owning=true … e7=true`).
- `generate_begin` (`src/codegen/exprs/begin.yo`) declared the result temp bare, as `T temp;`. It never called `declare_c_var_name`, and the emitter's line scanner records only `T temp = …` declarations.
- All three drop flush points then classified the scheduled drop as `undeclared_temp` and skipped it silently.

## Fix

- `generate_begin` registers the bare declaration with `declare_c_var_name`, as cond does.
- Once the block is closed, it puts the temp on the block-scope stack (`mark_declared_in_scope`), as match and cond do, so an explicit `return` or escape after the block also releases it.

## Verification

`tests/rc.test.yo`:
- "a block result that is not moved is released once" covers the argument, discarded-statement and receiver shapes. All three fail on seed v0.2.62.
- "a block that yields an outer local or is bound does not over-release" is the over-release canary: the outer-frame share path keeps `ref_count == 1`, and the bound block is released once.
