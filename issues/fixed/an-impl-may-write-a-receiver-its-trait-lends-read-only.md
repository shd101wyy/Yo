# An impl member may take `self : &mut Self` where its trait declares `self : &Self`, and a call through `&Dyn(Trait)` then writes through the read-only borrow

**Severity:** S2 — an invalid impl is accepted: a trait method that promises
a read-only receiver can write its receiver through a `&Dyn(Trait)` borrow,
and a generic `T <: Trait` body that relies on the promise fails at
instantiation, far from the impl.

Found 2026-10-13 while switching `Clone.clone` and `ToString.to_string` to
`self : &Self`
(`issues/fixed/clone-and-to-string-take-their-receiver-mutably.md`). That
question assumed "a user impl that keeps `&mut Self` gets the existing
mode-mismatch error". It did not get one.

## Reproducer

```yo
{ println } :: import("std/fmt");
Foo :: struct(n : i32);
M :: trait(m : (fn(self : &Self) -> i32));
impl(Foo, M(m : (fn(self : &mut Self) -> i32)({
  self.n = (self.n + i32(1));
  self.n
})));
read_only :: (fn(f : &Dyn(M)) -> i32)(f.m());
main :: (fn() -> unit)({
  a := Foo(n : i32(1));
  (d : Dyn(M)) = dyn(a);
  r := read_only(&d);
  r2 := read_only(&d);
  println(`returned ${r} then ${r2}`);
});
export(main);
```

Before the fix this compiled and printed `returned 2 then 3`: two calls
through a read-only borrow changed the value behind it. With the `Dyn`
replaced by a generic `read_only(generic(T : Type), f : &T, where(T <: M))`,
the impl is still accepted and the error (E0908) appears at the call
`read_only(&a)`, naming `f.m()` inside the generic body, not the impl that
broke the trait's contract.

## Root cause

Trait conformance (`src/evaluator/values/impl.yo`, the `.Some(conf_exp)` arm
of the member check) compares a member's type with the trait's after
`_with_receiver_mode_of`, which copies the trait's receiver mode onto the
member's type first. Receiver forms are free by design: a direct call adapts
to the impl's own signature, and a `Dyn` vtable slot goes through a wrapper.
That freedom is sound for a direct call, which sees the impl's real
receiver mode. It is unsound for a call through the trait, which passes the
borrow the trait promises. A member that writes (`&mut Self`) where the
trait lends read-only (`&Self`) is the one combination that breaks it.

## Fix

`_receiver_writes_where_trait_reads` (same file) detects a `self` receiver
that is a `&mut` borrow in the member and a `&` borrow in the trait (neither
`ref` nor owning). The conformance check rejects it with E0908, naming the
trait's spelling:

```text
Type "Foo" does not implement required trait "M" as written: member "m" takes `self : &mut Self`, but the trait lends its receiver read-only (`self : &Self`). ...
```

Every other receiver form stays free: a by-value `self : Self` member, a
`&Self` member of a `&mut Self` trait method, and so on.

Regression test: `tests/parameter_modes.test.yo`, "an impl member may not
write a receiver its trait lends read-only" (a user trait, and `Clone`).
