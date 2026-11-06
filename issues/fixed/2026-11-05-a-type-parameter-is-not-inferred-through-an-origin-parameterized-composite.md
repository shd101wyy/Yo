# A type parameter is not inferred through an origin-parameterized composite (E0613)

**Severity:** S2: a valid program is rejected. A generic function whose `T` is
reachable only through a parameter of type `C(T, p)` cannot be called when
`C` is a type constructor that takes an `Origin`. This holds whether the
parameter is passed by value, as `&`, or as `&mut`. The call fails with E0613
as soon as `T` appears in the result. VERDICTS-25's cursor
(`next :: (fn(generic(T : Type, p : Origin), self : &mut Cursor(T, p)) -> Option(&(T, p)))`)
type-checks but cannot be called.

> Found 2026-11-05 while writing N1e-2b PR 2b's acceptance test (decision 43
> step 2). Reproduced on develop `f531eabec`, so N1e-2b did not cause it.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
Cursor :: (fn(comptime(T) : Type, comptime(p) : Origin) -> comptime(Type))(struct(xs : &(ArrayList(T), p), i : usize));
first :: (fn(generic(T : Type, p : Origin), self : &mut Cursor(T, p)) -> Option(T))(.None);
main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  mut(c) := Cursor(i32, xs)(xs : &xs, i : usize(0));
  o := first(&mut c);
  ()
});
export(main);
```

```text
error[E0613]: Cannot infer the type parameter "T" of this call: it appears in the result type Option(T), and neither an argument nor the expected type determines it.
```

An annotation on the result's binding does not help either
(`(o : Option(&(i32, xs))) = next(&mut c)` is still E0613). A function whose result does not mention `T`
(`len :: (fn(generic(T : Type, p : Origin), self : &mut Cursor(T, p)) -> usize)`)
is accepted, which shows that the argument check never binds `T` from
`Cursor(i32, xs)`. The same shape with a concrete element type,
`IntCursor(p)`, works.

## Root cause

The argument-driven structural inference (`_funcval_bind_foralls`' scratch-env
fallback, `src/evaluator/calls/function.yo`) synthesizes the parameter's
instantiated pointee `Cursor(T, p)` against the argument's place type
`Cursor(i32, xs)`. The Struct+Struct walk recurses into the field pair
`xs : &(ArrayList(T), p)` vs `xs : &(ArrayList(i32), xs)` — a
Reference+Reference pair. `_synthesize_types_impl`
(`src/evaluator/types/synthesizer.yo`) had NO case for a Reference+Reference
pair: the pair fell through every arm and bound nothing, so `T` never bound
and any result mentioning `T` failed with E0613. A `T` in a plain field (`v : T`)
bound through the Struct+Struct field walk, and a result annotation bound `T`
through the expected-type channel (`are_types_compatible` has a Reference arm),
which is exactly the isolation the reproducer showed. The Origin parameter
itself was never the divergence: any `T` reachable only through a reference
type was unbindable, and an origin-parameterized composite is simply the first
place decision 43's model puts a `T` under a reference.

## Fix

Fixed by #1794 (4c9b51d1c, N1f-2, landed 2026-11-05 23:51 — four hours after
this issue was filed against f531eabec, 19:23): its `impl(generic(T), &T, Tr)` receiver work added
the synthesizer's Reference+Reference case — "the pointees synthesize ... the
origin is not part of the match (O1)" — which as a side effect binds any `T`
under a reference, in any origin-parameterized composite instance, by value,
`&` or `&mut`, and through nesting (an `Inner(T, p)` field) and
origin-parameterized enums. No cursor-specific code is involved.

Verified on develop `8d475cd81`: the reproducer above, a `&mut(T, p)` field, a
nested `Inner(T, p)` field and an origin-parameterized enum all infer `T`; the
seed v0.2.75 fails all four with E0613 (deterministically, 5/5 on the first
shape), which pins the fix between the two trees.

## Test

`tests/origins/reference_read_rule.test.yo` calls the generic `rr_next_at` on a
`RrCursor(i32, xs)` (the N1e-2b acceptance test, VERDICTS-25 §2 item 3) instead
of the `i32` cursor `rr_int_at`: the switched file fails on the v0.2.75 seed
(E0613-era inference) and passes on develop, check and runtime both.
