# A by-argument method specialization shares its `self` slot across the static and the elided instances

**Severity:** S3 (latent: after `fix/p12-t6-static-store` no accepted unsound program is known. Every reader the
p12-t6 lane found that judged origins by this slot now reads the argument instead, but a new reader would inherit the
wrong instance).

**Status:** OPEN. Found 2026-11-25 by the p12-t6 lane on develop `1175c046c`.

## What happens

```yo
X :: struct(n : i32);
Box2 :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(v : Option(T))
);
impl(
  generic(T : Type),
  Box2(T),
  put : (fn(self : &mut Self, v : T) -> unit)({
    self.v = .Some(v);
  })
);
G := X(n : i32(7));
main :: (fn() -> unit)({
  mut(a) := Box2(&(X, static))(v : .None);
  a.put(&G);
  x := X(n : i32(1));
  mut(b) := Box2(&X)(v : .None);
  b.put(&x);
  _ := a;
  _ := b;
});
export(main);
```

P12 (VERDICTS-74 rule 1) made `Box2(&X)` and `Box2(&(X, static))` two instances. Even so, `b.put(&x)` calls the
specialization `a.put(&G)` created, and the slots recorded for the call (`lookup_method_callee_value` →
`fn_param_slots`, which `lend_through` reads through `_method_slots`) give `self : &mut Box2(&(X, static))`. In the
other order, the static receiver gets the elided instance's slot. `v`'s slot is typed from the argument (`&X` both
times). This holds with the method-lookup cache bypassed (`YO_DEBUG_WARM=1`), so the sharing comes from where the
method is specialized on its arguments, not from `find_methods_from_generic_impls`' cache. That cache keyed by
`type_key` alone too (`issues/fixed/2026-11-25-a-generic-containers-method-result-is-typed-by-whichever-instance-looked-it-up-first.md`),
and is fixed.

## What it caused, and what reads it now

- `lend_through` step 1c (the static store check) and step 3's by-type-argument decision read this slot's pointee.
  That gave two S1s: `issues/fixed/2026-11-24-a-generic-containers-method-stores-a-local-reference-into-a-static-instantiated-receiver.md`
  and `issues/fixed/2026-11-25-a-generic-containers-elided-instance-skips-its-store-check-after-the-static-instance-specialized-the-method.md`.
  Both now read the lent argument's own type (`_lent_argument_pointee`).
- Steps 1 and 2 match origin names the slot spells. A specialized slot spells none, so they are unaffected.
- Step 1b asks `type_spells_checked_static` of each slot. A `&mut` over a non-static origin is false whatever its
  pointee spells, so the shared `self` slot never triggers it.
- Step 3's nested form (a `&mut` inside a by-value parameter, `_nested_mut_pointees` over the slot) still reads the
  slot. A free generic function specializes per binding of its type parameter, so the probe that reaches it
  (`fill(generic(T : Type), w : W(T), v : T)` with `W(T) :: struct(inner : &mut Box2(T))`, the static call first,
  then the elided one storing a block-local's reference) is E0911 as it should be.
- `fn_param_is_ptr_borrow` (the C ABI of a static slot) reads the specialized function's own slots, and the call
  site calls that same function, so the two agree.

## Where the fix belongs

The specialization of a generic impl's method should key on the receiver's instance with its static bits, as the
CTFE memo does since P12 (`static_origin_marks_differ` in `_ctfe_args_equal`). Then each instance gets its own
`self` slot. Whether the method body is checked against the shared `Self` or once per instance was not traced
here.
