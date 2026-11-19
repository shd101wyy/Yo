# A blanket over `&T` whose `where` mentions its binder is never judged at dispatch

**Severity:** S2 — a user blanket `impl(generic(T), where(T <: Tr(T)), &T, Tr(&T)(...))` answers `r.m(...)` on an
`r : Rc(C)` although `Rc(C)` does not meet `Tr(Rc(C))`, so a valid call is rejected with E0616 (decision 32's clash
check) instead of auto-dereferencing to the payload's `m`.

Found 2026-11-19 by the ToString lane while fixing
`issues/fixed/2026-11-13-a-blanket-tostring-impl-over-a-reference-answers-an-rc-receiver-whose-payload-has-the-method.md`,
which judges a reference blanket's clause only when its trait mentions none of the impl's binders. The prelude's own
`Eq(&T)` and `Ord(&T)` (`where(T <: Eq(T))`, `where(T <: Ord(T))`) are this shape; no std or compiler call site is known
to reach it.

## Reproducer

```yo
{ println } :: import("std/fmt");
Sh :: (fn(comptime(R) : Type) -> comptime(Trait))(
  trait(sh : (fn(self : &Self, other : &R) -> i32))
);
C :: struct(v : i32);
impl(C, Sh(C)(sh : (fn(self : &Self, other : &C) -> i32)(self.v + other.v)));
impl(
  generic(T : Type),
  where(T <: Sh(T)),
  &T,
  Sh(&T)(sh : (fn(self : &Self, other : &(&T)) -> i32)(T.sh(self.*, other.*) + i32(100)))
);
mk :: (fn() -> Rc(C))(Rc.new(C(v : i32(7))));
main :: (fn() -> unit)({
  r := mk();
  c := C(v : i32(1));
  println(r.sh(&c));
});
export(main);
```

```
error[E0616]: "sh" is a method of Rc(C) and of its payload C, so r.sh(...) could mean either
(plans/VALUES_BY_DEFAULT.md decision 32).
```

Expected: `8` (the payload's `sh` through auto-deref).

## Root cause

`try_match_generic_impl`'s where pass (`src/evaluator/values/impl.yo`) asks `type_implements_trait` with the clause's
trait as STORED at impl registration: `Sh(SomeT(T))`, a trait built for the impl's own binder with an `R`-specialized
id. Asked as-is, even `C <: Sh(SomeT(T))` at `T := C` is false (and `i32 <: Eq(SomeT(T))` is false for the prelude's
`Eq(&T)`: judging every clause made `rx == ry` on two `&i32` E0926), so such a clause cannot be enforced from what is
stored and the blanket is kept at every `T`, including `T := Rc(C)`. Closing it needs the clause's source expression
re-evaluated against the match's bindings (the same gap the trait-predicate mode documents for a constructed pattern).

## Test that will pin it

`tests/impl_ref.test.yo`: the reproducer's blanket beside an `Rc(C)` receiver; `r.sh(&c)` auto-derefs to the payload,
and `(&C).sh(&rc, &rc2)` still takes the blanket at `T := C`.
