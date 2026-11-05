# Destructuring a tuple of references fails to evaluate, and its names would not freeze what they borrow

**Severity:** S2: a valid program is rejected. `(p, q) := pair(&mut x, &mut y); p.* = 3`
fails with "Failed to evaluate left-hand side of assignment: (p.(*))". The corpus row
`get2-mut-pair` stopped at this error. Once the names bound, a second gap showed up:
they froze nothing, so `x = 9` while `p` was still live was accepted. That second gap
was unsound, but no program could reach it before the first fix.

> Found 2026-11-05 while gating the N2b residue rows on develop af566f95b
> (decision 43 step 3).

## Reproducer

```yo
pair :: (fn(a : &mut i32, b : &mut i32) -> Tuple(&mut(i32, a), &mut(i32, b)))((&mut a.*, &mut b.*));
main :: (fn() -> unit)({
  mut(x) := i32(1);
  mut(y) := i32(2);
  (p, q) := pair(&mut x, &mut y);
  p.* = i32(3);
  q.* = i32(4);
  ()
});
export(main);
```

```text
error: Failed to evaluate left-hand side of assignment: (p.(*))
```

## Root cause

`handle_member_destructuring` (src/evaluator/exprs/destructuring_assignment.yo) bound
each element at the element's own type. For an element of type `&mut i32`, `p` was
therefore an ordinary binding of type `&mut i32`, not a reference binding. `p.*` then
had no place to write. A `match` payload of reference type is bound as a reference
binding: the name has the pointee's type and its C slot holds the pointer.

Neither the destructuring path nor its caller registered the N2b binding freeze
(`freeze_origin_carrying_binding`). `t := pair(&mut x, &mut y)` freezes `x` and `y` while
`t` is live; `(p, q) := ...` froze nothing.

## Fix

- A tuple element whose type is a reference binds a reference binding, as a `match`
  payload does: the pointee type, `is_ref`, `is_imm_borrow` for a `&` element, and
  reassignable for a `&mut` element.
- After destructuring, `evaluate_initialization_assignment`
  (src/evaluator/exprs/initialization_assignment.yo) freezes the right-hand side's
  roots for every runtime name whose element type carries an origin, as the `match`
  reference payload does.

Tests: `tests/borrow_spelling.test.yo`, "a tuple literal lends its reference
elements" (positive) and `bs_destructured_lend_freezes` ("is still live").
