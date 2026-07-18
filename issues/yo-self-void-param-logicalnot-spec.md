# yo-self: specialized LogicalNot with unresolved Self emits `void self` param (collections/\* batch family)

## Symptom

`s2 test tests/collections/array_list.test.yo` (and siblings) fails whole-batch:

```
error: argument may not have 'void' type
static inline bool yo_id_122__Self____LogicalNot__id_212_ret_bool(void self);
```

A call-site specialization of `yo_id_122` (bool's `LogicalNot` impl method)
was minted with `Self` bound to the **LogicalNot trait shape** (`id_212`)
instead of `bool`; the param lowers to C `void`, and a call site consumes
the bad spec, so the whole batch C fails to compile → every test in the
file FAILs. Also emitted alongside is the CORRECT spec
(`yo_id_122_bool_id_bool_rtparam0_bool_ret_bool`).

## Status / evidence

- PRE-EXISTING: identical signature in round-5, round-6 and round-6b sweeps
  (pre- and post- the 2026-07-18 type-identity + supersession fixes; only
  the C line number shifts).
- A minimal `not_it :: (fn(forall(T : Type), v : T) -> bool)(!(v))` with
  bool args is GREEN under s1 — the repro needs the batch/derive context
  from the collections tests (likely a derived-trait method body containing
  `!` where the receiver is the derive's Self, or trait-typed dispatch of
  `!` under the batch's comptime-io shape).

## Hunt plan

1. After the sweeps release `tests/`, run
   `YO_SELF_BIN=... s1 test tests/collections/array_list.test.yo` with the
   batch KEPT (skip cleanup) and extract the failing spec's mint site:
   probe `create_specialized_function_inline` (calls/helper.yo) to log
   when a specialized param type renders as unit/void or a TraitT — the
   caller context identifies the call shape.
2. TS mirror: TS either never mints this spec (its `createSpecialized...`
   guards on unresolved params) or skips emission. Check TS helper.ts's
   specialization guards for trait-typed/unresolved `Self` args and port.
3. Alternative cheap guard (non-faithful, last resort): in yo-self's
   create_specialized_function_inline, refuse to mint when any specialized
   param type lowers to `void` (fall back to the generic path) — the
   call site then keeps the original dispatch.

## Affected sweep files (round-6b, first observed)

tests/collections/array_list.test.yo — plus, by signature match, the other
collections/\* rc=1 batch files (btree_map, deque, hash_map, …) — exact
membership pending the round-6b summary.

## ROOT CAUSE LOCALIZED (2026-07-18, 13-line repro)

Repro (/tmp/ne_repro.yo): `a != b` on `ArrayList(i32)` (any derived-Eq
receiver). Emitted C:

```c
bool _t = yo_id_122__Self____LogicalNot__id_212_ret_bool((void)(// Failed to transpile a != b));
```

The chain:

1. `!=` on a derived-Eq type dispatches the Eq trait's DEFAULT method body
   (std/prelude.yo:632): `(lhs, rhs) -> not(Self.(==)(lhs, rhs))`.
2. A trait-DEFAULT FuncVal carries NO forall of its own and no injected
   impl captures, so `_evaluate_funcval_runtime_call`'s for-codegen
   specialization trigger (`forall_names.len() > 0 || soft-generic`) does
   not fire → no specialized `!=` body is minted with Self := receiver;
   the abstract body's `Self.(==)` cannot transpile → the whole `a != b`
   FTTs.
3. Inside the abstract default body, the `not(...)` call (prelude `not`,
   generic over `T <: LogicalNot`) DID get call-site-specialized — but
   with T bound to the CONSTRAINT trait (`LogicalNot`, id in fid render),
   not a concrete type → its `self` param lowers to C `void` — the
   "argument may not have 'void' type" batch breaker.

So this is the TRAIT-DEFAULT-METHOD sibling of the (fixed) SortedSet
impl-generic case: SortedSet's `new` worked because its FuncVal carries the
impl forall (nf=1) so the existing trigger fired; trait defaults carry
nothing.

## Fix plan (next iteration)

1. Extend the for-codegen specialization trigger to trait-default methods:
   when the callee FuncVal is a trait-field default (detectable at
   dispatch: the resolved candidate came from a trait's default value —
   thread a marker the way `_inject_forall_captures` marks impl methods),
   bind `Self` from the first Self-typed arg's concrete type (lhs) and run
   the same create_specialized_function_inline block. TS equivalent: trait
   defaults are evaluated per-dispatch with Self bound (the default's env).
2. ALSO gate specialization on CONCRETE bindings — refuse to mint when any
   forall binding is a TraitT or unresolved SomeT (TS
   `hasUnresolvedTypeParams`): that alone turns the void-param spec into a
   no-spec fallback (still FTT, but no longer corrupts sibling arms).
3. Supersession (ef8344537) then hides the dead abstract original once
   every dispatch specializes.

Watch the gates: corpus has derived-Eq `!=` on concrete types passing via
OTHER routes — find the passing route first (e.g. tests/codegen-bootstrap's
eq tests) and compare its dispatch to the ArrayList one before changing the
trigger.
