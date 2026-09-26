# The flow relation is called with its arguments reversed

**Status:** OPEN
**Found:** 2026-09-26, Type-system soundness Phase 3.8 (extern opaque types)
**Repro:** `issues/repros/the-flow-relation-is-called-with-its-arguments-reversed.yo`

## Symptom

A `Dyn(A)` value reassigned into a `Dyn(A, Bt)` variable passes `yo check`.
The variable's type silently becomes `dyn(A)`, and the program fails only in
the C compiler:

```
error: assigning to '__yo_t_13886500896652449876' from incompatible type '__yo_t_14921912196355361050'
```

A second shape, found while writing the extern-opaque gates: an extern opaque
value is accepted for a scalar parameter.

```rust
{ atomic_ullong } :: import("std/libc/stdatomic");
sink :: (fn(x : u64) -> u64)(x);
f :: (fn(a : atomic_ullong) -> u64)(sink(a));   // checks clean
```

## Root cause

`are_types_compatible :: (fn(actual, expected) -> bool)` is directional: the
comptime widenings, the `Dyn` trait-set subset rule, `never`, the anonymous
record into a named struct and the C scalar into an extern opaque all read
"`actual` flows into `expected`". `Type.is_compatible_with(A, B)` calls it that
way round (`src/evaluator/builtins/type_fns.yo`).

Several call sites pass `(expected, actual)` instead. At least:

| site | call |
| --- | --- |
| `src/evaluator/exprs/assignment.yo` (reassignment) | `are_types_compatible(variable.ty, rhs_type)` |
| `src/evaluator/exprs/assignment.yo` (property assignment) | `are_types_compatible(expected_ty, prop_rhs_type)` |
| `src/evaluator/exprs/initialization_assignment.yo` (typed binding) | `are_types_compatible(pre_type, synth.ty)` |
| `src/evaluator/calls/helper.yo` (argument check) | `are_types_compatible(final_pt, arg_type)` |
| `src/evaluator/calls/function.yo` (two argument checks) | `(_ac_pty, _ac_aty)`, `(resolved_decl_pt, etc_arg_ty)` |
| `src/evaluator/types/function.yo` (a parameter's default value) | `(pt, dv_ty)` |
| `src/evaluator/types/trait.yo` (a trait field's value and default) | `(fet, av_ty)`, `(fet, dv_ty)` |
| `src/evaluator/builtins/as.yo` | `(target_type, source_type)` |

Before extern opaque types were nominal the extern half was invisible: an
extern was a bound-less `SomeT`, which every rule accepted in both directions.

## Fix direction

Audit all 81 call sites for orientation and pass `(actual, expected)`
everywhere; a directional relation called both ways is not one relation. Each
directional rule then needs an over-acceptance canary in
`tests/type_soundness.test.yo` in the flipped direction (the `Dyn` downcast,
an extern into a scalar parameter).

## Resolution

**Fixed 2026-09-26** (branch `tss/flow-orientation`, Type-system soundness Phase 3 step 8).

- All thirteen reversed sites flipped to `(actual, expected)`: the argument
  check and its debug line plus the explicit-`using` and implicit-param checks
  (`calls/helper.yo`), the C19 concrete/concrete check and the etc-argument
  check (`calls/function.yo`), a parameter's default value
  (`types/function.yo`), a trait field's value and default (`types/trait.yo`),
  property assignment and reassignment (`exprs/assignment.yo`), the typed
  binding (`exprs/initialization_assignment.yo`), `as` (`builtins/as.yo`) and
  the Fn-trait check (`trait_checking.yo`). The other ~68 sites were
  classified as correctly oriented or symmetric (joins, cross-case merges,
  value equality); the classification is in the commit message.
- `Dyn` flow is now the exact trait set in every mode (`compatibility.yo`'s
  DynT arm), per Phase 2.7's recorded decision: no upcast, no downcast. The
  element comparison inside the set-equality loop keeps the ambient relation
  (flow in flow), so a generic `Dyn(Fn(A) -> B)` parameter still accepts
  `Dyn(Fn(i32) -> i32)` — Invariant there broke `_sound_apply_dyn`
  (`tests/type_soundness.test.yo`) and was the branch's one build fix.
- Canaries in `tests/type_soundness.test.yo`: the extern-into-scalar
  parameter, the `Dyn` downcast by call and by reassignment, the upcast
  (rejected, with the "Yo does not upcast Dyn" note), and the relation itself
  in both directions.
- The flip exposed that the extern-opaque C-scalar coercion composed into
  compound types (`Option(u64)` flowed into `Option(FILE)`), which the
  reversed argument check had been masking; that is
  `issues/fixed/the-extern-opaque-scalar-coercion-composes-into-compound-types.md`,
  fixed in the same branch.
