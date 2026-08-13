> **RETIRED (2026-08-13).** This doc's subject — the `_trial_eval_fn_body`
> swallow and whether un-swallowing is feasible — was resolved wholesale by
> the def-eval swallow campaign
> (`issues/fixed/def-eval-swallow-remaining-roots.md`): every root was fixed
> (minimal repro 19 → 0, corpus 5 → 0; self-compile 3607 trials / 0 swallows)
> and the handler is now FATAL on the concrete path (exact TS parity —
> deferred-generic trials keep discarding, as TS's own `catch {}` at
> function-type.ts:112 does). The 104-category inventory below is the
> historical sizing that framed that campaign. What remains of the surface is
> a DIFFERENT mechanism — per-node silent degrades that never throw — tracked
> in `issues/fixed/yo-self-method-miss-degrades-to-unit.md`.

> **STATUS UPDATE (2026-08-06).** The std/string usize-vs-u8 swallow noise this doc's
> surface included is fixed — it was an index-trait expected-type mis-port, not a std
> error (`issues/fixed/yo-self-std-string-swallowed-unify-noise.md`, commit
> `fa6505b48`). The post-fix swallow baseline for a string-importing file is identical
> to the no-import baseline.

# Def-time body eval: the swallow hides a BROAD gap surface (104 categories)

## Context

To pass the 7 remaining `check`-failing `tests/` (all `comptime_expect_error`
gates that don't fire — `ref_flowability`, `ref_local_binding`,
`ref_closure_capture`, `slice_flowability`, `algebraic_effects`,
`extern_unsafe_wrap`, `sync/mutex`), the **in-body** gate rejections must reach
`comptime_expect_error`. They don't today because `function_type.yo`'s
`_trial_eval_fn_body` runs def-time body eval through a **swallowing** handler
(`inner_exn` → `unwind(())`). Un-swallowing (the TS-faithful behavior —
`function-type.ts:499` propagates) would let those gate rejections surface.

## Measurement (log-and-swallow diagnostic, 2026-06)

Instrumented the swallow to `println` each caught error, rebuilt, ran
`check` over all of `std/` + `tests/`, and normalized the messages:

- **~30,000 raw swallowed errors** (inflated ~670× because the prelude is
  re-evaluated per file).
- **104 DISTINCT normalized error categories.**

Top categories (normalized counts):

| count                  | category                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 3324                   | `while loop condition is compile-time known but the 'comptime' modifier is missing` (a comptime-while gate mis-firing under type-check mode) |
| 2695×2                 | `Expected type for trait field, got fn(lhs : Self, rhs : Rhs) -> (Self.Output)` (+ comptime variant) — trait-field type eval                 |
| 1827                   | `Incompatible types:`                                                                                                                        |
| 1686                   | `Type mismatch for parameter "X":`                                                                                                           |
| 1471 / 806 / 490 / 247 | `Expected type for element, got I / T / V / A` — **generic type params unbound at def-time**                                                 |
| 1174                   | `Return type mismatch`                                                                                                                       |
| 1046                   | `Cannot unify incompatible types`                                                                                                            |
| 1028                   | `Failed to infer enum variant type`                                                                                                          |
| 980 / 490              | `Failed to evaluate, got fields.get(fi).name` — comptime field iteration                                                                     |
| 735 / 245×8            | `__yo_type_*: expected a TypeVal, got a non-type value` — type-builtins on unresolved generic params                                         |
| 649                    | `Cannot create a pointer to a value`                                                                                                         |
| 379                    | `panic message must be a comptime_string or str`                                                                                             |

## Conclusion

Un-swallowing is **NOT a small fix**. The body eval hits 104 distinct
incidental-failure categories when run in type-check mode (`is_executing=false`,
`is_validating_function_definition=true`). The dominant root causes:

1. **Generic type parameters unbound at def-time** (`T`/`I`/`V`/`A`/`Self`) →
   "expected type for element, got T", "\__yo_type_\*: expected TypeVal", "Cannot
   unify". This is the `parametersFrame`-consumption gap (infra landed in
   `95945b1f`/`8d700447`, but wiring it regressed — see memory
   `yo-self-defeval-wall`).
2. **Trait-field type evaluation** ("Expected type for trait field, got fn(...)").
3. **Comptime reflection** (`fields.get(fi).name`, `__yo_type_*`).
4. **Type unification under validation mode** (mismatch/incompatible/return-type).

This **confirms** the memory's standing assessment: def-time body eval
robustness is a _broad multi-layer feature_, not an incremental chain. Making
it robust enough to un-swallow = faithfully completing the def-time evaluation
that TS does natively — a sustained project tackled by root category (biggest
lever: generic-param resolution at def-time), not a quick gate-wire.

## Progress (2026-06, commit 2b91e5e4)

**~60% of the surface drained — option (A) is underway and tractable.** The
single largest category ("expected type for element, got T", field.yo:293) was
root-caused (via a location-tagged swallow diagnostic) to PRELUDE comptime
type-constructor functions (Box/Arc/IterPair/IterSkip/IterZip) whose
`comptime(T):Type` params were bound as `create_unknown_val(Type)` (unknown
VALUE) instead of `TypeVal(SomeT)` (type value) in `_build_def_time_body_env`.
Fix: bind `is_type_0` params as `create_type_value(t_some_t(...))` (mirrors
function.yo:1169) + flipped should_defer's Self check to the deep predicate.
MEASURED: element-typevar category 14→0; TOTAL swallows roughly halved
(array_list 85→26, hash_map 87→25, string 122→63). Zero regression (std 151/0,
tests 171/11, yo-self 228/0). The remaining categories (trait-field eval,
unification, comptime reflection) are the next draining targets; once the surface
is near-empty, un-swallowing becomes safe and the 7 in-body gate tests surface.
LESSON: don't guess the lever — two hypotheses (params-frame, deep-Self-alone)
were ~no-ops; the location diagnostic found the real one.

## Options

- **(A) Faithful robustness push** — close the gap categories (params-frame
  consumption first, then trait-field eval, comptime reflection, unification).
  Large, regression-prone, multi-cycle. The only path that keeps the swallow
  removable and matches TS.
- **(B) Distinguished error channel** — route intentional gate rejections past
  the swallow (e.g. a dedicated error kind) while incidental gaps stay
  swallowed. Cheaply unblocks the 7 gates, but DIVERGES from TS's single
  propagation channel ("making our own logic").
- **(C) Accept current state** — the 7 gates stay red under `check` but are
  enforced by the TS compiler today; they pass naturally once (A) lands. The
  evaluator-check milestone is otherwise green (std 151/0, tests 171/11,
  yo-self 228/0).
