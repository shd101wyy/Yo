# An impl `where` bound whose left side is not one of the impl's binders is silently dropped

**Severity:** S2 — `impl(generic(T : Type), where(W(T) <: Probe), W(T), Marker())` registers the impl with no bound, so `W(i32)` is a `Marker` though `W(i32)` implements no `Probe`; nothing says the bound was ignored.

Filed 2026-11-26 by the `bound-s1` lane while fixing the colon-spelled form
(`issues/fixed/2026-11-25-a-colon-spelled-where-bound-on-an-impl-or-derive-is-silently-dropped.md`).
Reproduced with a stage 1 of `fix/bound-forms-and-send-gate` (develop `030d63040` merged).

## Reproducer

```yo
Probe :: trait(probe : (fn(self : &Self) -> i32));
Marker :: trait();
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), where(W(T) <: Probe), W(T), Marker());
comptime_assert(Type.impls(W(i32), Marker) == false, "W(i32) has no Probe, so the bounded impl must not hold");
main :: (fn() -> unit)({
  ()
});
export(main);
```

```text
error: W(i32) has no Probe, so the bounded impl must not hold
  --> h-impl-where-nonbinder.yo:5:1
```

## Root cause

`_collect_impl_where_constraints` (`src/evaluator/values/impl.yo`) looks the bound's left side up among the impl's
`generic(...)` binder names. An application (`W(T)`), a projection (`T.Item`) or `Self` matches none, and the `.None` arm of
that lookup does nothing, so the entry contributes no constraint to the `GenericImplEntry`. The form check
(`check_where_clause_form`) passes it because it is a well-formed `L <: R`.

## Fix

Either read the bound (a constraint on the instantiated left side, as a function's `where` does through
`parse_where_clause_constraints`) or reject it at the impl's definition with a coded error naming the binders the impl
can bound. With `Send` as the trait, a pragma'd impl relying on such a bound is a data race, so the silent arm has to go
either way.

## Resolution (2026-11-26, lane `v81-v84-pr2`)

The coordinator adopted the second option: a coded rejection at the impl's definition. The `.None` arm of the binder
lookup in `_collect_impl_where_constraints` (`src/evaluator/values/impl.yo`) now raises E0624
(`_impl_bound_not_on_a_binder_error`), and the lookup only matches a bare identifier, so `W(T)` no longer matches a
binder named `W`:

```text
error[E0624]: An impl's `where(...)` bounds the impl's own `generic(...)` binders, and `W(T)` is not one of them (its binders are `T`). Bound a binder, as in `where(T <: Trait)`.
```

No impl or derive header in std, src, tests, docs or the pack has such a bound (a scan over balanced `impl(...)` and
`derive(...)` groups found none), so nothing that compiled before is rejected.

Test: `tests/where-clause-fn-inference.test.yo` (the `where(FormBox(T) <: FormProbe)` case).
