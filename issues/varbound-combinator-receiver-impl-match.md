# Variable-bound combinator receivers fail generic-impl matching — `m := xs.map(f); m.for_each(g)` never worked

**Status: PARTIALLY FIXED 2026-08-24 (branch s1-iterators).** The cell-chain
recovery below fixes the variable-bound `map`/`filter_map`/`chain` cases
(measured: the chunk-3 iterator suite arms flip). **REMAINING OPEN:** a
variable-bound `flat_map` receiver still fails — `IterFlatMap`'s stamped `F`
marker has an EMPTY resolution cell (`F : (Fn(A) -> MyRange)`, constraint
still raw `A`), so no recovery channel reaches the concrete capture; the
`B` slot is likewise a bare SomeT. The chained form works (on-demand
receiver re-specialization). Repro:

```rust
it := my_range(i32(1), i32(4)).flat_map((x) => my_range(i32(0), x));
it.for_each((x) => { out.push(x); });   // still: "does not implement Iterator"
```

The full fix needs the STAMPING side to populate the cells (or substitute
where-derived foralls) for the multi-derived-param family — the same
under-resolution the rre adoption notes in calls/function.yo deliberately
work around for the per-call closure-F identity.

Found 2026-08-24 implementing the S1
iterator chunk (plans/STD_API_AUDIT.md D3.4): `for_each` on the new
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
