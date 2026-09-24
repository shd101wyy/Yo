# Variable-bound combinator receivers fail generic-impl matching — `m := xs.map(f); m.for_each(g)` never worked

**Status: FIXED.** The cell-chain recovery below (2026-08-24) fixed the variable-bound
`map`/`filter_map`/`chain` cases. The `flat_map` residual recorded here next — a doubly-derived
`B` whose `F` cell was empty — no longer reproduces: std never shipped `flat_map` (it was deferred
in #242), and a user-written blanket `flat_map` combinator bound to a variable and consumed by
`for_each` works on the v0.2.41 seed and on develop `b03c8b741` (re-measured 2026-09-25, see the
end). The original residual repro, kept for history:

```rust
it := my_range(i32(1), i32(4)).flat_map((x) => my_range(i32(0), x));
it.for_each((x) => { out.push(x); });   // still: "does not implement Iterator"
```

The full fix needs the STAMPING side to populate the cells (or substitute
where-derived foralls) for the multi-derived-param family — the same
under-resolution the rre adoption notes in calls/function.yo deliberately
work around for the per-call closure-F identity.

Found 2026-08-24 implementing the S1
iterator chunk (plans/archive/STD_API_AUDIT.md D3.4): `for_each` on the new
`IterFilterMap`/`IterFlatMap` combinators failed, and reduction showed the
same failure on plain `.map(f)` — pre-existing on `develop`, latent because
nothing in tree ever bound a `B`-carrying combinator to a variable before
consuming it with a closure-taking method.

## Symptom

```rust
m := my_range(i32(1), i32(4)).map((x) => (x * i32(2)));
m.for_each((x) => { out.push(x); });   // ERROR
```

```
Error: Type <struct:struct_yo_id_NNNN> does not implement required trait Iterator.
  std/prelude.yo (for_each's where clause)
```

The DIRECTLY CHAINED form `.map(f).for_each(g)` works. `fold`/`count` on the
same variable also work (`fold` recovers accidentally — see below). The
failing shape: a combinator struct with a type param that does not appear
structurally in its fields (`B` in `IterMap(I, B, F)` — fields are
`_inner : I, _f : F`), bound to a VARIABLE, then consumed by a
closure-taking blanket method.

## Root cause (measured with YO_DEBUG_DISPATCH / YO_DEBUG_BIND probes)

1. `.map(f)`'s stamped return type `IterMap(MyRange, i32, F)` DELIBERATELY
   keeps `F` as a SomeT (adopting the name-resolved value would clobber the
   per-call `F → <capture>` identity — the recorded iter_filter_closure
   hazard in calls/function.yo's rre adoption notes). The concrete capture
   lives in the SomeT's RESOLUTION-CHAIN CELL (`resolved_concrete`).
2. A chained receiver is re-specialized on demand at the next call and
   presents a fully-resolved instance. A variable-bound receiver keeps the
   stamped type: `type_arguments = [MyRange][i32][F<SomeT>]`.
3. Inside `for_each`'s `Self <: Iterator(Item := A)` where-check,
   `try_match_generic_impl` unifies the IterMap pattern structurally
   (I, A bind), leaves B/F abstract, and falls to
   `_bind_forall_from_type_args`. B recovers (`type_arguments[1] = i32`),
   but F's slot is the unresolved SomeT and the recovery only consulted the
   `g_some_resolved_concrete` REGISTRY (the async bridge) — never the
   SomeT's own cell. `all_bound=false` → impl rejected → "does not
   implement required trait Iterator".
4. `fold` on the same receiver survives by ACCIDENT: its name-based
   fallback (`_resolve_one_forall_binding`) finds the method's own
   concrete `F` (fold's closure — the WRONG closure, but concrete), so
   `all_bound=true`.

## Fix

`_bind_forall_from_type_args` (src/evaluator/values/impl.yo): when a
`type_arguments` slot holds a SomeT, walk its resolution-chain cell (same
walk as `type_somes_all_resolve_concrete` / compatibility.yo's
`_resolve_cell_chain`) and bind the terminal concrete type; the registry
lookup stays as the second channel (async outputs).

Regression coverage: tests/iterator_combinators.test.yo — the chunk-3
variable-bound `for_each`-on-`chain`/`filter_map`/`flat_map` tests plus the
minimal `map`+`for_each` case, which fail without the cell walk.

## Closed 2026-09-25

Re-measured for `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 2.4: a user-level `FlatMap(I, J, F)`
combinator with `impl(generic(I, A, J, B, F), where(I <: Iterator(Item := A), J <: Iterator(Item :=
B), F <: (Fn(item : A) -> J)), FlatMap(I, J, F), Iterator(Item : B, …))` and a blanket
`flat_map` method, bound to a variable and consumed by `for_each`, yields all 6 items on the
v0.2.41 seed, on develop and on the Phase 2.4 branch. Pinned by
`tests/iterator_combinators.test.yo` ("a variable-bound doubly-derived combinator (user flat_map)
is still an Iterator"). The same combinator written as a FREE function (`flat_map(src, f)` with
`where(I <: Iterator(Item := A))`) is rejected with E0602 — that is
`plans/backlog/ASSOC_TYPE_BINDING_IN_FREE_FN_WHERE.md` (Phase 2.6), not this issue.
