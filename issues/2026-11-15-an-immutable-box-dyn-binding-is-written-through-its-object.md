# An immutable `Box(Dyn)` binding is written through its object

**Severity:** S2 (a binding declared without `mut` is mutated: decision 47's E0917 is skipped, no crash and no wrong C)

**Status:** OPEN. Found 2026-11-15 by the flip lane while pinning `tests/cli-cases/fix-migrate-unsized-lends`. It reproduces on v0.2.77, where `Box(Dyn)` is still the legacy owning value, and on the flip branch alike.

## What happens

```yo
Speak :: trait(speak : (fn(self : &Self) -> i32), bump : (fn(self : &mut Self) -> unit));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n), bump : ((self : &mut Self) -> { self.n = (self.n + i32(1)); })));
bump :: (fn(d : &mut Dyn(Speak)) -> unit)(d.bump());
main :: (fn() -> unit)({
  (d : Box(Dyn(Speak))) = dyn(Box.new(Cat(n : i32(3))));
  bump(&mut d.*); // accepted
  d.bump(); // accepted
});
export(main);
```

`yo check` accepts both writes. The same shape over `Box(i32)` (`b := Box.new(i32(1)); setp(&mut b.*)`) is
E0917, "Cannot lend `&mut` ... `b`: it is a binding declared without `mut`". On v0.2.77, where `d` is
the legacy owning value, `bump(&mut d)` is accepted too. So the gap is the `Dyn` object, whether reached
through the box or as the legacy value: a `&mut` lend of it, and a `&mut self` method dispatched through
the vtable.

## Expected

E0917 at both writes, with the `mut(d)` help, as for any other `Box`.

## Notes

The mutability walk (`place_require_mut`, `src/evaluator/utils.yo`) does not see a `Dyn` payload place
`d.*`, nor a `&mut self` vtable call through `d`, as a write of `d`'s binding. The fix needs a test
row in `tests/dyn.test.yo` (both writes are E0917; `mut(d)` accepts them).
