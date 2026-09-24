# Generic call type variables re-resolve per argument — cross-argument consistency is never enforced

**Found**: 2026-08-27, root-causing the io.await effect-bundle memcpy overflow
(`issues/fixed/io-await-effect-arg-not-checked-memcpy-overflow.md`). **Status**: FIXED 2026-09-24 (Phase 2.4 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Related: C18
(`issues/fixed/struct-literal-missing-field-silently-accepted.md`) supplies the
second half (lenient struct compatibility).

## Repro (accepted today, should be errors)

```rust
pair_same :: (fn(generic(A : Type), x : A, y : A) -> A)(x);
_a := pair_same(String.from("hello"), i32(2));  // A = String AND A = i32
_b := pair_same(i32(3), String.from("world"));
```

`yo check`: zero errors.

## Mechanism (measured with YO_DEBUG_PARAMCHECK / YO_DEBUG_BIND)

- Each argument runs `check_if_function_parameter_matches_argument`
  independently: Step 6 synthesizes bindings FROM that argument, Step 7
  re-resolves the declared param type, Step 8 checks compatibility — so each
  argument is only ever compared against a resolution influenced by ITSELF.
- The signature's several mentions of one type variable do not share a
  resolution channel by the time they are checked: for
  `fn(fut : Impl(Future(T, E)), e : E)`, the deep-resolve of `fut`'s declared
  type reports `E = IoExn` while the deep-resolve of `e`'s reports
  `E = {io}` IN THE SAME CALL — separate SomeT lineages (separate
  `resolved_concrete` cells / registry entries), each self-consistent.
  An env-level post-loop recheck therefore CANNOT see the conflict (tried;
  reverted).
- `_bind_some_type`'s in-place update deliberately replaces an existing
  binding's value ("last-wins like TS", synthesizer.ts:274-277), and trial
  matching (tryMatchGenericImpl) depends on rebinding freedom, so a blanket
  first-bind-wins guard in the synthesizer is not safe to bolt on (also
  tried; reverted).

## What a real fix needs

Per-call unification state where every mention of a signature type variable
resolves through ONE channel (one fresh lineage per call, shared across the
whole signature — the C21 freshening did this for RETURN-position SomeTs
only), plus a conflict = error rule at the second concrete resolution.
That is a unification-architecture change; scoped out of the CI-repair PR.

## Containment

The memory-safety face (io.await/io.spawn effect bundles — the one place a
wrong binding turns into an out-of-bounds memcpy rather than a wrong value)
is closed by the Step-7c layout gate. Wrong-value faces (`pair_same` above)
remain reachable.

## Fix (2026-09-24)

A per-call binding check on both call paths, E0601 naming both arguments:

```
error[E0601]: Incompatible types for generic parameter "A": it is String from argument 1 but i32 from argument 2. Every mention of a type parameter in one call stands for one type.
```

- The inline FuncVal path (`_funcval_bind_foralls`, `src/evaluator/calls/function.yo`) used to
  bind a binder from the FIRST parameter spelled with it and never looked at the rest. It now
  compares every later bare-name parameter's inferred type, every structurally reached binding
  (`x : Option(A), y : Option(A)`, read after each parameter's synthesis), and every composite
  parameter against the name-bound binders (value arguments only — a function literal's type is
  provisional before it is checked against the solved signature).
- The `try_to_call` path (`src/evaluator/calls/helper.yo`, Step 7) snapshots each binder's
  concrete binding after every argument (`_check_forall_bindings_after_arg`); method calls were
  already caught there by unification.

Two bindings conflict when neither is compatible with the other under the lenient relation, so a
literal's `comptime_int` and the `i32` it adopts are one binding. This is not the "one lineage per
call" architecture the doc asked for — the shared resolution cell still exists (the remaining
Phase 2.4 item) — but every binder of a call is now held to one type.

## Verification

`tests/type_soundness.test.yo`: `_pair_same(String.from("hello"), i32(2))` and the reverse are
rejected; the canaries (same type, a literal adopting the binder, a closure agreeing) run.
