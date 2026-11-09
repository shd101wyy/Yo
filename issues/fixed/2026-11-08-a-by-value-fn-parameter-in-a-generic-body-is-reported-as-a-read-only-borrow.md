# A by-value `fn` parameter in a generic body is reported as a read-only borrow

**Severity:** S3: a wrong diagnostic. The program is rightly rejected, but the
message names the wrong cause and suggests repairs that do not apply.

`&mut Impl(FnMut(...))` callback slots turned `tests/higher_kinded_types.test.yo`
red with this message.

## Reproduction

```yo
apply :: (fn(generic(A : Type, B : Type), x : &Option(A), f : (fn(a : &A) -> B)) -> Option(B))(
  x.map(generic(B), f)
);
main :: (fn() -> unit)({
  o := Option(i32).Some(i32(1));
  r := apply(generic(i32, i32), &o, (fn(a : &i32) -> i32)(a.* + i32(1)));
});
export(main);
```

`yo check` on develop `2c794f1c9`:

```text
error[E0908]: Cannot pass `f` as the `&mut` parameter `f`: `f` is a `&T` parameter, a read-only borrow of the caller's value, and the callee writes it. To change it, declare it `f : &mut T` to write the caller's value, take it by value (`f : T`, without `&`) to own and write a copy, or copy it into a local first (`q := f.*;`) and write the copy.
```

`f` is a by-value parameter, not a `&T` one, and "take it by value" is what it
already does. Spelling the argument `&mut f` gives the same E0908.

The same body without `generic(...)` (`x : &Option(i32)`, `f : (fn(a : &i32) -> i32)`)
reports the right rules: a bare `f` is E0914 ("lend `f` with `&mut f`"), and
`&mut f` is E0917 ("a parameter is immutable", decision 47). The working form
in both bodies is a mutable local: `mut(g) := f; x.map(generic(B), &mut g)`.

## Likely cause

A function with `generic(...)` parameters checks its body at call time, and
that binding site marks a `fn`-typed parameter as a `&T` parameter. AGENTS.md
lists this family: a parameter is bound in three places, and the call-time
binder must mirror the definition-time binder's flags.

## Fixed

The per-specialization re-bind of a closure-typed parameter (`calls/helper.yo`, `_rbc`) binds it non-owning and sets `is_imm_borrow` for ownership bookkeeping; `_mark_value_rebind` records that a by-value slot's re-bind is not a reference (`is_value_rebind`, read by `variable_is_reference_binding`), but two readers of `is_imm_borrow` did not honor it: `shared_borrow_param_root_of_place` (the E0908 "write through a `&T` parameter" check, `exprs/assignment.yo`) and `_marker_place_of` (which classified the name as a borrow that passes bare, so E0914/E0917 never ran). Both now ignore a value re-bind, so a by-value `fn` parameter in a generic body gets the diagnostics its concrete twin gets: a bare `f` to a `&mut` slot is E0914, `&mut f` is E0917 (a parameter is immutable). Test: "a by-value fn parameter in a generic body is not reported as a read-only borrow" in `tests/parameter_modes.test.yo`.
