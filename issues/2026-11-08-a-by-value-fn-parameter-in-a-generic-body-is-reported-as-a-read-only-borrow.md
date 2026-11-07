# A by-value `fn` parameter in a generic body is reported as a read-only borrow

**Severity:** S3: a wrong diagnostic. The program is rightly rejected, but the
message names the wrong cause and suggests repairs that do not apply.

**Status:** OPEN. Filed 2026-11-08 while fixing develop after #1824 (G1), whose
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
