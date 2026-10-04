# A generic `Dispose`/`Trace` impl on a value type is accepted, and its `dispose` never runs

**Severity:** S2 — an invalid program is accepted: a generic `Dispose` impl on a value-struct type constructor compiles, `Type.impls(...)` says the type is `Dispose`, and the destructor silently never runs (a resource it was meant to release leaks).

**Status:** fixed on `feat/vbd-v1-rc-marker` (2026-10-04).

## Repro

`issues/repros/generic-dispose-impl-on-a-value-type.yo`:

```rust
Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(a : T, b : T));
impl(
  generic(T : Type),
  Pair(T),
  Dispose(
    dispose : (fn(self : Self) -> unit)({
      g_disposed = (g_disposed + i32(1));
    })
  )
);
```

With the v0.2.50 seed and develop's std (`cd3454b0e`), this compiles and prints
`0` for the dispose count. The non-generic form, `impl(V, Dispose(...))` on a
value struct, has always been rejected (then by `where(Self <: Rc)`).

## Root cause

The trait's `where(Self <: X)` clauses were enforced only on the CONCRETE impl
path (`evaluate_impl` Case 3, through `g_check_self_constraints_fn` in
`src/evaluator/values/impl.yo`). The generic path (Case 2) never ran that
check, so `Dispose`'s `where(Self <: Rc)` — and, once the `Rc` marker trait
was deleted (`plans/VALUES_BY_DEFAULT.md` §3.6), its replacement reference-type
gate — did not apply to `impl(generic(...), Pattern, Dispose(...))`.

A blanket `impl(generic(T), T, Dispose(...))` was already rejected in practice,
by coherence against std's own `Dispose` impls (E0612), so the hole was the
constructed receiver pattern.

## Fix

`cell_only_trait_violation_msg` (`src/evaluator/trait_checking.yo`) is the one
reference-type gate for `Dispose`/`Trace`. It is installed into `impl.yo` as
`g_cell_only_trait_fn` (impl.yo cannot import trait_checking.yo) and now
also runs on a generic impl's receiver pattern: a value pattern or a bare type
parameter is an error, pointed at the trait constructor.

That one check covers every instantiation. A pattern's ref-ness cannot depend
on its type arguments: a type constructor such as
`cond((sizeof(T) == usize(4)) => struct(...), true => ref(struct(...)))` is
rejected when the pattern is evaluated over an unbound `T` ("This condition is
only known at runtime, but the `cond` selects a compile-time-only value",
measured 2026-10-04 with the tree stage-1).

The full selfConstraint check is not applied to generic patterns: a pattern
over unbound type parameters cannot answer an arbitrary `where(Self <: X)`.

## Test

`tests/prelude.test.yo`, "Test a generic 'Dispose'/'Trace' impl needs a
reference receiver": the generic `Dispose` and `Trace` on `GenericValuePair(T)`
and the blanket `Dispose` on `T` are compile errors, `GenericValuePair(i32)` is
not `Dispose`, and a generic `Dispose` on `GenericRefPair(T)` runs once.
