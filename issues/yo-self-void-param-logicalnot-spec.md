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
