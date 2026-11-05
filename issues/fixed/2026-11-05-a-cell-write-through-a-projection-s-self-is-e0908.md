# A write into a cell through a projection's `self : &Self` is E0908

**Severity:** S2 — a valid program is rejected: a method returning `&T` cannot write a cell its `&Self` receiver reaches, which the same method returning a value can.

Found while giving `OnceCell(T).get_or_init` Rust's `-> &T` result
(the `OnceCell` move-only read S2 filed on `vbd/v5-part-b-tests`),
on develop 68b45b81d.

## Symptom

```yo ignore
_Lazy :: struct(h : __yo_cell(Option(i32)));
impl(
  _Lazy,
  get_or_set : (fn(self : &Self, v : i32) -> &i32)({
    self.h.* = .Some(v); // E0908 here
    match(&self.h.*, .Some(x) => &x, .None => __yo_panic("unset"))
  })
);
```

```
error[E0908]: Cannot write through `self`: it is a `&T` parameter, a read-only borrow of the caller's place.
```

`OnceCell.get_or_init` wrote `self._cell.*._value` the same way. With a `-> T` result the
write is accepted.

## Root cause

A projection's `&T` parameter is passed by pointer and binds as a non-reassignable
`is_ref` variable (`bind_parameter`'s `is_ptr_borrow`). `_check_capture_borrow_write`
(`src/evaluator/exprs/assignment.yo`) rejects every write whose place is rooted at such a
binding, walking the place to its root without asking whether a step leaves the borrowed
value. A cell's payload is shared storage, not part of the value `self` borrows. A by-value
`&T` parameter never reached that branch: the evaluated-place check
(`shared_borrow_param_root_of_place`) judges it, following only the steps that stay inside
the borrowed value (value fields, tuple elements, fixed arrays, a unique `Box`'s payload).

## Fix

The pre-evaluation branch skips a `&T` parameter (`is_imm_borrow`): the evaluated-place
check judges a pointer-passed `&T` parameter exactly as it judges a by-value one. A write
into the borrowed value itself stays E0908.

## Test

`tests/yo_cell.test.yo`: "a projection's `&Self` writes a cell it reaches" (`_Lazy`), and a
`comptime_expect_error` keeping a field write through a projection's `&T` parameter E0908.
