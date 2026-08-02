# yo-self: 3-deep chained combinators — repeat trait checks lose the `Item := A` binding

State as of 2026-08-03 (the closure-F fix stack landed). This is the ONLY
root left behind `tests/iterator_combinators.test.yo` (arms 16, 17, 18 —
each hollows its batch standalone); arms 0–15 are real.

## Repro

`/tmp/m16.yo` shape (standalone, 2 markers):

```rust
n := my_range(i32(0), i32(100)).skip(usize(20)).take(usize(15)).count();
```

- `skip(20).count()` (2-deep) WORKS; `skip(20).take(15).next()` (3-deep,
  pattern-scoped method) WORKS; 3-deep + a BARE-`I`-blanket method
  (`count`/`any`/`fold`) fails: the method call types `unit` (soft
  fallback) and everything after it FTTs.

## Measured mechanism (probe log, m16p6)

`validate_where_constraints_for_call` → `IterTake(IterSkip(MyRange)) <:
Iterator` (full check):

1. FIRST check: step 8 → `try_match_generic_impl` on the bare-`I` blanket →
   where-pass binds `A` via the full check → **result=true** (probe W).
2. LATER checks of the SAME pair: `try_match_generic_impl` leaves forall
   **`A` unbound** (probe P2 `unbound forall=A`) → `all_bound=false` → no
   match → **result=false**.

So the first success registers/derives state (marker registry /
type-trait-methods) that makes REPEAT checks take a short-circuit path
which satisfies the enforcement but does NOT re-bind the impl's `A`
(`Iterator(Item := A)`), and the binding extraction in the where-pass
comes back empty. The step-4 registered path DOES run
`_check_associated_type_constraints` — the gap is between its
resolution channels for the just-registered nested record (the
`find_associated_type_from_generic_impls` recursion on the 3-deep record).

## Two fixes already landed in this area (keep!)

- trait_checking.yo guard key: `type_key(target)` (was `""` for structs —
  every struct-vs-trait check shared one key; nested same-trait checks
  self-collided). This alone flipped the FIRST check to true.
- The closure-F stack (see issues/fixed/yo-self-closure-f-identity-split.md).

## Next step for whoever picks this up

Probe `_check_associated_type_constraints(2939, Iterator(Item := A))` on the
repeat path: which channel resolves `Item` for the nested record on run 1
but not on runs 2–3, and whether the FIRST run's on-demand registration
writes an entry that makes `find_associated_type_from_generic_imples`'
recursion hit the recursion guard. TS never faces this: its
typeImplementsTrait memo returns the FULL result (bindings included) —
consider registering the resolved `Item` in the type-trait-methods registry
alongside the marker at first success, so repeat checks resolve it from
step 1 of the assoc check.

Canaries for this work: iterator_combinators arms 16/17/18 subsets
(`python3 scratchpad/subset_arms.py tests/iterator_combinators.test.yo 16 …`),
plus the full TIER 1 battery (the trait-check guard is global).

---

## 2026-08-03 UPDATE — arms 16/17 FIXED (17a8192ae); arm 18's root isolated

Arms 16 and 17 flip via (a) the pure-id trait-check guard key
(`_type_id_for_trait_check`, NOT type_key — type_key registers
g_struct_cfid_keys entries and poisoned the imm family's C identities) and
(b) DURABLE assoc-type registration at tmgi success + a registry-first
third forall-recovery channel in the bindings loop.

**Arm 18 (still hollow) is a DIFFERENT root** — a name-keyed forall
resolution leak between sibling blanket methods:
`.filter(p => …).fold(0, (acc, x) => …)` — fold's closure receives
FILTER's `F : (Fn(*(i32)) -> bool)` as its expected type
("Anonymous function: expected 1 regular parameters, got 2").
Probe-measured chain hops (env_lookup `_do_chain_resolve`):
`F 1204 -> 1250` and `F 1272 -> 1250` — fold's/other Fs name-resolve to
FILTER's F(1250), whose `F := TypeVal(F-1250)` binding sits in a frame
that stays visible to the SIBLING call's param resolution (in one hop the
env had nvars=1 — ONLY filter's binding visible, i.e. a PERSISTENT shared
frame, not fold's own callee frame). yo-self's ownership check
(`_was_self_bound`) passes because fold's F WAS self-bound elsewhere, and
the LAST-binding-wins name lookup picks the leaked entry. TS never faces
it: per-call forall freshening (helper.ts:1047) makes the callee's own
binding the last one.

Next step: find which write puts filter's `F := TypeVal(F)` into the
persistent frame (Step-6 synthesis add_variable_to_env frame targeting, or
the where-pass adapter's env.frames swap), and scope it to the call frame —
the same class as the "call-scoped rebinds (67acb7390) + lineage-identity
gate (92b27f68b)" fixes.
