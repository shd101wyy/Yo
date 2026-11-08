# A holder with a `Drop` impl can hand out a `&mut` through its reference field, and its drop then runs while that `&mut` is live

**Severity:** S1. An unsound program is accepted: the holder's `drop` writes through the same `&mut` loan the caller still holds. If the drop freed or moved what the field points to (cleared a list, say), the caller's reference would dangle.

Filed 2026-11-08 by the G2 lane. The bug predates `fix/impl-origin-in-method-result`: develop `beefabda4` accepts the payload form below.

## Reproducer

`issues/repros/2026-11-08-a-drop-holder-yields-a-place-through-its-reference-field.yo`:

```yo
{ assert } :: import("std/assert");
Slots :: struct(a : i32, b : i32);
Entry :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(m : &mut(Slots, p)));
impl(
  generic(p : Origin),
  Entry(p),
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      self.m.a = i32(-1);
    })
  )
);
impl(generic(p : Origin), Entry(p), take : (fn(self : Self) -> Option(&mut(i32, p)))(.Some(&mut self.m.*.a)));
main :: (fn() -> unit)({
  mut(s) := Slots(a : i32(0), b : i32(0));
  e := Entry(s)(m : &mut s);
  match(
    e.take(),
    .Some(r) => {
      r.* = i32(1);
    },
    .None => ()
  );
  assert(s.a == i32(1), "written");
});
export(main);
```

`take` consumes `self` and returns a reborrow of `*self.m`. The holder's `drop` runs at the end of `take`, and writes `self.m.a` while the returned `&mut` into `s.a` is live. Rust rejects this shape with E0713 ("borrow may still be in use when destructor runs"). It accepts the shape only when the holder type has no `Drop` impl.

## Where to look

There are two places a fix could go:

- The projection or return check of a body that yields a place through a by-value parameter's reference field (`&mut self.m.*.a`).
- The end-of-body `___drop(self)` of that parameter.

Either way, the rule is: when the parameter's type implements `Drop`, the yielded reference may not reach through it (E0713's rule).

## Test

The fix adds the reproducer, in both the payload form and the projection form (`-> &mut(i32, p)`), as negatives to `tests/origins/impl_origin_result.test.yo`. It keeps the no-`Drop` holder positive and moves this doc to `issues/fixed/`.
