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

On develop `b1af0cd01` (after #1839) the reproducer is rejected, but at `main`'s `assert` and for the wrong reason (`issues/fixed/2026-11-09-a-drop-holder-moved-into-a-call-stays-live-to-its-scope-end.md`). Without that `assert` it is still accepted, so `take`'s body is not checked.

## Where to look

There are two places a fix could go:

- The projection or return check of a body that yields a place through a by-value parameter's reference field (`&mut self.m.*.a`).
- The end-of-body `___drop(self)` of that parameter.

Either way, the rule is: when the parameter's type implements `Drop`, the yielded reference may not reach through it (E0713's rule).

## Test

The fix adds the reproducer, in both the payload form and the projection form (`-> &mut(i32, p)`), as negatives to `tests/origins/impl_origin_result.test.yo`. It keeps the no-`Drop` holder positive and moves this doc to `issues/fixed/`.

## Fixed

VERDICTS-41 Q2: the diagnostic is E0911 (a destructor is an access that conflicts with the live loan), raised in `return_check` (`src/evaluator/utils.yo`, `_check_drop_param_yield`). `origin_of` has no root for a place lent through a by-value parameter's `&mut` field (the field's origin is the caller's), so `return_check` walks the lends the result is built from (`_result_lend_operands`: arm values, block tails, constructor and tuple arguments) and judges each by its path (`_place_path_segments`): it rejects when the path crosses a `.*` through a `&mut` field of a by-value parameter and some value prefix on the path (the parameter, then each field step down to the field's holder) has a `Drop` that uses its roots (`type_nominal_drop_uses_roots`, D1). A `&` field, a holder without a `Drop`, and a `Drop` field the path does not go through are accepted. The destructor sentence is added to E0911's registry entry. Tests: `tests/origins/impl_origin_result.test.yo` (the projection, payload, shared-reborrow and outer-prefix negatives; the no-`Drop`, `&`-field and disjoint-guard positives); G-B pair `h6f-drop-param-yields-through-mut-field` (E0911; the program is a heap-use-after-free under ASan on the pre-fix binary) / `h6f-drop-param-yields-through-mut-field-pos`.
