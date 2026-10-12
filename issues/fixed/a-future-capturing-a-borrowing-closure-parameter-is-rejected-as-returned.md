# A returned future that captures a borrowing closure parameter is rejected ("cannot be returned", blamed on std)

**Severity:** S2 — `Mutex.with_lock` with a body that borrows the caller's
locals was rejected inside `std/async/mutex.yo`.

Found by the adversarial review of the §3.13 A2 change, 2026-10-12.

## Symptom

```yo ignore
run :: (fn(body : &Impl(Fn() -> i64), io : Io) -> Impl(Future(i64)))(
  io.async((io : Io) => { return(body()); })
);
s := i64(7);
r := io.await(run({ &s }() => (s + i64(1)), io), io);
```

```text
error[E0909]: This value borrows `s` (the capture `s : &s` at w1_min.yo:9:24), so it is second-class and cannot be returned: a borrow never outlives the scope that lends it.
```

`m.with_lock({ &s }(v : &mut i64) => { ... }, io)` failed the same way, with
the error raised at `std/async/mutex.yo:97`. The same `run` with a closure
that borrows nothing, or awaited inside `run`, compiled.

## Root cause

The `io.async` body captures the `&Impl(Fn)` parameter `body` by value (the
closure struct is copied). `_register_borrowing_future` registered the
captured closure's borrows on the future as they were: rooted at the caller's
`s`. `reject_second_class_return` accepts a returned borrowing future whose
borrows are all rooted at the function's `&`/`&mut` parameters, and `s` is not
in the function's scope at all, so the return was rejected.

## Fix

`_register_borrowing_future` walks the capture struct's fields. A field that
captures a `&`/`&mut` parameter of the function writing the `io.async`
contributes its value's borrows re-rooted at that parameter, when their root
is out of scope there: the caller lent the parameter's argument for the call,
and that argument's own borrows outlive it. At the call site the future's
type then carries the parameter's borrow, so it is awaited where it is made
like any borrowing future. No lent copy is needed: the closure struct is
copied into the future, and its pointers are the caller's.

Regression tests: `tests/async/mutex.test.yo`, "Test with_lock runs a body
that borrows the caller's locals"; `tests/async_await.test.yo`, "a returned
future borrows a parameter through its own entry, or the closure a parameter
lends".
