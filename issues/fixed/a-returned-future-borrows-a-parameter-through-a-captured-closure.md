# A returned future that borrows a `&T` parameter through a captured closure dangles

**Severity:** S1 — the future read the parameter's slot in a C frame that had
returned (`84435521` at -O0, `0` at -O2, where 42 was right).

Found by the adversarial review of the §3.13 A2 change, 2026-10-12.

## Symptom

```yo ignore
via_closure :: (fn(c : &C, io : Io) -> Impl(Future(i32, Io)))({
  (f : Impl(Fn() -> i32)) = ({ &c }() => (c.n + c.m));
  io.async((io : Io) => { io.await(yield(io), io); f() })
});
```

The emitted constructor built `{ .__yo_v_c = (&(__yo_v_c)) }` from the
by-value C parameter `__yo_v_c`, moved the closure into the heap state machine
and returned; the closure body later read `(*ctx->__yo_v_c)` from the dead
frame. Develop rejected the program with E0909 (a borrowing future had not
landed).

## Root cause

A2 accepts a returned borrowing future whose borrows are all rooted at `&`
parameters, and C receives a `&T` parameter by value, so a future that
borrows one keeps its own copy (`__yo_lent_<label>`,
`_lent_param_capture_fields`). That copy is made only for a capture field
that is itself the `{ &p }` entry. A closure captured by the body holds
`&p` one level down, where nothing copies it: the evaluator accepted a set of
borrows codegen does not copy.

## Fix

A future copies a `&T` parameter only through its own capture list, as an
`io.async` list already borrows a `&` parameter whole (`{ &p.f }` is an error
naming `{ &p }`). `_register_borrowing_future` marks a borrow that reaches
the body through a captured value `through_value`, and
`reject_second_class_return` rejects returning a future with such a borrow of
a `&T` parameter, naming the fix: borrow the parameter in the body's own
capture list. Awaiting it inside the function stays accepted (the frame is
alive). A `&mut` parameter is a pointer in C and is unaffected. Recorded in
`plans/VALUES_BY_DEFAULT.md` §3.13 A2's "As built" note.

Regression test: `tests/async_await.test.yo`, the top-level
`comptime_expect_error` over `_a2_via_closure` and the test "a returned
future borrows a parameter through its own entry, or the closure a parameter
lends".
