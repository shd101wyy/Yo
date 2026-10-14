# D3 misses a write through an `Arc` that is not the place's root

**Severity:** S1 — safe code could write an `Arc`'s payload from two threads at once (a data race) whenever the `Arc` sat in a field, a tuple element or another cell.

**Status:** fixed 2026-10-14 on `feat/vbd-async-mutex-rust`, found while
narrowing E0909 for the async `Mutex` (§3.13 A2 relies on D3).

## Symptom

D3 (`plans/reference/PARALLELISM_RULES.md`) forbids a write through an
atomic object in a file without `pragma(Pragma.AllowUnsafe)`. It looked only at
the written place's ROOT binding. Measured with v0.2.62, every write below
passed `yo check` in safe code:

```yo
Counter :: struct(n : i32);
impl(Counter, bump : (fn(self : &mut Self) -> unit)({ self.n = (self.n + i32(1)); }));
bump_by_ten :: (fn(c : &mut Counter) -> unit)({ c.n = (c.n + i32(10)); });
Holder :: struct(a : Arc(Counter), n : i32);
main :: (fn() -> unit)({
  h := Holder(a : arc(Counter(n : i32(0))), n : i32(0));
  h.a.*.n = i32(1); // field of an Arc reached through a struct field
  h.a.* = Counter(n : i32(9)); // the whole payload replaced
  bump_by_ten(&mut h.a.*); // a `&mut` argument
  t := (arc(Counter(n : i32(0))), i32(1));
  t.0.*.bump(); // a `&mut self` receiver through a tuple element
  r := rc(arc(Counter(n : i32(0))));
  r.*.*.n = i32(3); // an Arc behind an Rc
});
export(main);
```

The same writes with the `Arc` as the root (`a.*.n = …`) were rejected. A copy
of `h.a` moved into a `Thread.spawn` closure then races with these writes.

## Root cause

`throw_if_write_through_atomic_root` and `d3_record_inout_place`
(`src/evaluator/exprs/assignment.yo`) took `get_root_expr_of_place(place)` and
asked whether that root VARIABLE has an atomic object type
(`get_atomic_object_root_type`). An atomic object at an inner hop was never
looked at.

## Fix

The hops of the evaluated place are walked with their types
(`place_cell_hops`, `src/evaluator/utils.yo`, shared with decision 38 D and
§3.13 A2), and its `atomic_receiver` is the inner atomic object:

- an assignment checks the evaluated left-hand side
  (`_throw_if_write_through_atomic_hop`), after the unchanged root check;
- a `&mut` argument or `&mut self` receiver whose root is not atomic is
  recorded as a candidate (`D3PendingInout.atomic_hop`); `d3_check_pending`
  resolves it on the evaluated place, and it is an error when the callee's
  mutation mask says the parameter is written, exactly as for a root `Arc`.
  A call whose candidates all fall away computes no mask.

## Verification

`tests/parallelism_soundness.test.yo`, "D3 past the root": six
`comptime_expect_error` blocks (field, tuple element, `Rc` of `Arc`, whole
payload, `&mut` argument, `&mut self` receiver) that the seed accepts, plus a
canary that writes the holder's own field and reads through the `Arc`.
