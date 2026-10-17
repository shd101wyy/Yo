# A field write through a `&T` parameter is accepted, and the write is lost

**Severity:** S2 — an invalid program is accepted: `p.n = v` on a `p : &T` parameter compiles, writes a callee-local copy, and the caller never sees it.

**Status:** fixed 2026-10-17. Found 2026-10-12 while testing the unique `Box` (V1 step 2):
`b.n = v` on `b : &Box(P)` compiled, and the same holds for a plain `&P`.

## Reproducer

```yo
{ eprintln } :: import("std/fmt");
P :: struct(n : i32);
w :: (fn(p : &P) -> unit)({
  p.n = i32(1); // expected: E0908, a `&T` borrow is read-only
});
main :: (fn() -> unit)({
  x := P(n : i32(0));
  w(&x);
  eprintln(&x.n); // prints 0
});
export(main);
```

`yo check` accepts it. A whole-value write (`p.* = …` through a `&Box(P)`) and
a write that releases owned data are already E0908.

## Root cause

E0908 fires only where the old value holds data its owner still holds
(an RC or move-only part). A write of plain data through a `&T` parameter
reaches no check, and `&T` of a small value lowers to a by-value C
parameter, so the write lands in the callee's copy.

## Fix direction

`plans/VALUES_BY_DEFAULT.md` §3.1: "A write through a `&T` borrow is E0908."
Every place rooted at a `&T` parameter or `&` local borrow, through field,
element and `Box` payload steps, is read-only; the assignment and `&mut`
argument paths reject it. A `tests/` case: `p.n = v` and `b.n = v` (for
`b : &Box(P)`) are E0908.

## Fix

A `x : &T` parameter (of a `fn`, a method's `self : &Self`, or a closure)
binds with `Variable.is_imm_borrow`. `shared_borrow_param_root_of_place`
(`src/evaluator/exprs/assignment.yo`) walks a place from the written end to
its root through the steps that stay inside the borrowed value (a field of
a value struct or tuple, an element of a fixed array, a unique `Box`'s
payload: `_place_root_variable` without collection steps) and returns the
root when it is such a parameter. Three write sites consult it, and each
reports E0908 (`Cannot write \`p.n\`: \`p\` is a \`&T\` parameter, a
read-only borrow of the caller's value.`):

- the field/element assignment (`p.n = v`, `p.inner.m = v`,
  `p.arr(i) = v`, `p.pair.0 = v`, `a(i) = v`, `b.n = v` through
  `b : &Box(P)`, `self.n = v` in a `self : &Self` method), after the
  existing check for a write whose old value holds RC data, which keeps
  its own message;
- a `&mut` argument or `self : &mut Self` receiver the callee writes
  (`p.inc()`, `p.inner.bump()`, `f(&mut p.inner)`, `g(&mut p.n, v)`,
  `g(&mut p.inner.m, v)`, `g(&mut p.arr(i), v)`), through the pending
  borrow entries `d3_check_pending` judges against the callee's mutation
  mask, as the RC case already did;
- a `&mut` local borrow of such a place (`q := &mut p.inner.m`).

A step through a handle (a `ref` object, an `Rc`, a std collection) still
reaches storage the handle shares, and so does lending a handle place to a
`&mut` parameter or receiver: `h.xs.push(v)` on `h : &H` stays legal until
the V2b flip makes the collections values. (The `&mut` argument check
applies to places of plain-data type; a value aggregate holding RC data
already gets the borrowed-copy E0908.)

The E0908 explanation (`yo explain E0908`, en and zh-CN) no longer says
that plain-data fields of a `&T` parameter can be written.

Writing the test turned up two more bugs, fixed in the same change:
`issues/fixed/2026-10-17-e0908-prints-an-element-place-with-unbalanced-parentheses.md`
and
`issues/fixed/2026-10-17-comptime-expect-error-nested-in-another-resets-its-propagate-mode.md`.

Test: `tests/shared_borrow_write.test.yo` (every shape above is E0908; the
by-value, `&mut` and through-a-handle writes stay legal). It fails on
develop at 36c41e62b: `p.n = i32(1)` compiles, so the first
`comptime_expect_error` fails the batch (`error: "is a \`&T\` parameter, a
read-only borrow"`), and every shape listed above compiled there (`yo check`
rc 0 on each).
