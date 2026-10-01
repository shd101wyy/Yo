# A generic `extern("Yo")` function called from a generic impl member fails the member's trial

**Severity:** S3. The member's definition-time trial failed and the error was swallowed. Every
specialization worked, so nothing was reported. Phase 6 steps 3–4 of
`plans/TYPE_SYSTEM_SOUNDNESS.md` (re-raise a swallowed trial error, or make a stub an error)
would have turned it into a false error on the prelude.

**Status:** FIXED 2026-10-01 on branch `tss/generic-extern-trial`. Found the same day while
tracing `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md` with
`YO_DEBUG_SWALLOW=1`: the prelude's `GcTracer.visit` (`std/prelude.yo`) failed its trial on
every `check`.

## Reproducer (measured, v0.2.47)

```rust
pragma(Pragma.AllowUnsafe);
Tr :: newtype(_cb : *(u8));
extern("Yo", __yo_my_take : (fn(generic(T : Type), tracer : Tr, slot : *(T)) -> unit));
impl(Tr, visit : (fn(generic(T : Type), self : Self, slot : *(T)) -> unit)(__yo_my_take(self, slot)));
export(Tr);
```

```
$ YO_DEBUG_SWALLOW=1 yo check repro.yo
[swallow] error[E0605]: Type mismatch for parameter "slot":
- Expected: *(T)
- Got     : *(T)
These are two different declarations with the same name.
```

## What the original table got wrong

The first version of this doc listed three cases. Re-measured with `YO_DEBUG_SWALLOW=1
YO_DEBUG_PARAMCHECK=1` (v0.2.47), the variable that decides the outcome is the
pointer-nested binder. Whether the caller is an impl member does not matter:

| caller | callee parameter | `[param-check]` | trial |
| --- | --- | --- | --- |
| generic impl member, binder `T` | extern `slot : *(T)` | `final=*(T) arg=*(T) compat=false` | fails |
| generic free fn, binder `T` | extern `slot : *(U)` | `final=*(U) arg=*(T) compat=false` | fails |
| generic free fn, binder `T` | extern `slot : U` | `final=T arg=T compat=true` | passes |
| generic free fn, binder `T` | extern `slot : *(T)` | `final=*(T) arg=*(T) compat=true` | passes only because both `T`s have the same name and frame level, so they compare equal |
| generic impl member, binder `T` | generic Yo fn `slot : *(T)` | no `[param-check]` line | passes |

The Yo-function callee never reaches this check. A `FuncVal` callee goes through the
`evaluate_function_call` FuncVal arm, which binds the parameters itself and specializes on the
abstract `T` (`[abstract-spec] … trial=true`). Only a callee without a FuncVal goes through
`try_to_call_function_with_arguments` → `check_if_function_parameter_matches_argument`, and
an `extern` is one.

## Root cause

Step 6 of `check_if_function_parameter_matches_argument` (`calls/helper.yo`) did bind the
callee's binder. `synthesize_types` walks `*(U)` against `*(T)`, reaches the both-SomeT case
with both sides unbound, and writes `U := T` into the callee env. Step 7 then lost that binding.
`evaluate_function_parameter_type_again` → `_resolve_some_types_deep`
(`evaluator/types/function.yo`) handles a bare SomeT by returning whatever the env resolves it
to. That is why `slot : U` became `T`. For a SomeT nested inside another type, though, it only
substituted CONCRETE resolutions:

```rust
if(!is_some_type(resolved), { subst_add(s, st_name, st_lvl, resolved); ... });
```

A slot rebound to another SomeT (`_env_rebound_to_another_some`) with no concrete resolution
was dropped. `*(U)` therefore stayed `*(U)` and Step 8 compared it against the argument's
`*(T)`. The same gap affected return types: an extern `-> *(U)` called with `*(T)` returned
`*(U)`, leaking the callee's binder into the caller.

## Fix

`_resolve_some_types_deep` now treats a nested slot the same way it already treated a bare
one. When the env rebinds a nested slot to a different SomeT, the slot is substituted with that
SomeT even when it has no concrete resolution. No caller or callee is special-cased.

## What the trial does not catch

The trial treats distinct unresolved binders leniently, and this fix does not change that.
`synthesize_types` lets a later argument rebind the callee's binder, so a body that unifies two
of the caller's binders passes its trial with no swallowed error:

```rust
pragma(Pragma.AllowUnsafe);
extern("Yo", __yo_two : (fn(generic(U : Type), a : *U, b : *U) -> unit));
extern("Yo", __yo_id : (fn(generic(U : Type), a : *U) -> *U));
two_diff :: (fn(generic(T : Type, S : Type), a : *T, b : *S) -> unit)(__yo_two(a, b));
conv :: (fn(generic(T : Type, S : Type), a : *T, b : *S) -> *S)(__yo_id(a));
```

Measured 2026-10-01 with `YO_DEBUG_SWALLOW=1 check`. On the seed, both bodies swallowed `Type
mismatch for parameter "a": Expected *(U) Got *(T)`. That was the false error this doc fixes,
reached here only by accident. After the fix, neither body records an error. The seed already
behaved this way for the same shapes without a pointer: a bare `U` extern called with `T` and
`S`, and a direct `(a)` returned as `*S` from `fn(generic(T, S), a : *T, b : *S) -> *S`, both
pass the trial with no swallow on the seed and on the fixed build. Instantiation still rejects a
concrete mismatch: the same bodies called with `i32` and `i64` fail with E0601 `Cannot unify
incompatible types` on both binaries. That fits the monomorphizing model
(`plans/TYPE_SYSTEM_SOUNDNESS.md` §1): Phase 6 step 3 cannot re-raise a rigid-binder mismatch,
because the trial never records one. A concrete specialization reports it.

## Verification

- `tests/cli-cases/check-generic-extern-called-with-a-callers-binder`: `check` under
  `YO_DEBUG_SWALLOW=1` of an impl member calling an extern with `slot : *(T)` (the prelude
  shape), plus a free fn calling an extern with a differently named binder that returns
  `*(U)`. The golden pins that no `Type mismatch for parameter` swallow is printed, whether
  from the prelude or from `main.yo`. The trial failure is swallowed, so this debug channel
  is the only way to observe it; `comptime_expect_error` does not surface definition-time
  trial errors.
  - Red before: the seed (v0.2.47) fails the golden with three `Type mismatch for parameter
    "slot"` lines (prelude, `main.yo:9:95`, `main.yo:12:74`). The same-tree build with the
    fix disabled by a temporary knob also fails it.
  - Green after: the fixed build passes.
- Swallow census, `YO_DEBUG_SWALLOW=1 check ./std` on one binary with the fix disabled vs
  enabled: 253 → 247 swallowed errors. Removed: 3 × `Type mismatch for parameter "slot"`
  (prelude `GcTracer.visit`), 3 × `Incompatible types for field "_pairs_ptr"`
  (`std/imm/map.yo:832`, where `new_ptr` typed as `*(MapEntry(K, V))` instead of
  `*(MapEntry(K, U))`), and 1 × `Incompatible types for field "value"`
  (`std/imm/sorted_map.yo:647`). Added: 1 × `Incompatible type with expected type …
  Actual: unit` at `std/imm/map.yo:1042` (`Map(K, U).new()` in `map_values`). This is not a
  new defect. The trial now gets past `_map_values_node` and reaches a later statement that
  hits the existing `issues/generic-trial-degrades-a-failed-evaluation-to-unit.md` family;
  the same message is already swallowed at `map.yo:1018` and `1026` (`List(K).new()`).
- Hello-world `check` (prelude + `std/fmt`): 110 → 108 swallows. The two removed lines are
  both `GcTracer.visit`.
