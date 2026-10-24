# A borrowing method future on a `ref` receiver is rejected as a cell lend

**Severity:** S2 — `r.m(io)`, where `r` is a `ref` object and `m`'s future borrows `self : &Self`, was E0909 ("that place lives in a shared mutable cell"), while the same call spelled `T.m(&r, io)` was accepted. Since V3's std half the `Reader`/`Writer` defaults (`read_to_end`, `read_to_string`, `write_all`) borrow their receiver, so every user `ref` reader hit it on `r.read_to_string(io)`.

**Status:** fixed 2026-10-24 on `feat/v3-std-cell-free-resources`. Reproduced with the v0.2.68 seed and the tree binary before the fix.

## Reproducer

```yo
{ IoExn, Exception } :: import("std/error");
{ println } :: import("std/fmt");
Counter :: ref(struct(n : i32));
impl(
  Counter,
  get : (fn(self : &Self, io : Io) -> Impl(Future(i32, IoExn)))(
    io.async(e => {
      self.n = (self.n + i32(1));
      self.n
    })
  ),
  twice : (fn(self : &Self, io : Io) -> Impl(Future(i32, IoExn)))(
    io.async({ &self, io }(e : IoExn) => {
      a := e.io.await(self.get(io), e);
      b := e.io.await(self.get(io), e);
      a + b
    })
  )
);
main :: (fn(io : Io) -> unit)({
  exn := Exception(throw : (err -> unwind(())));
  b := IoExn(io : io, exn : exn);
  c := Counter(n : i32(0));
  v := io.await(c.twice(io), b); // E0909 before the fix; prints 3 after it
  println(`${v}`);
});
export(main);
```

```text
error[E0909]: This future borrows `c` across its suspension, and that place lives in a shared mutable cell (any `ref` object, a pointer dereference, or a buffer reached by an index): ...
  --> repro.yo:24:17
```

## Root cause

`_check_future_call_lends` (`src/evaluator/calls/function.yo`) decides whether a method receiver was auto-dereferenced (`k.m(io)` on an `Rc(T)` whose `Self` is `T` lends the payload, one cell hop) by comparing the receiver's type with the method's `Self` parameter type. It read that type from the ExprInfo of the `.` callee node. A method call's `.` node carries no function type: dispatch records the resolved method's type under the call's id instead (`record_method_callee_type`), as `projection_call_callee_type` and codegen already read it. So `self_ty` was always unknown, every `ref` receiver counted as auto-dereferenced, and the lend was classified as crossing a mutable cell.

## Fix

Read the callee's function type from the `.` node when it has one, else from `lookup_method_callee_type(call id)`. A `ref` receiver whose method takes `Self` lends the handle binding and is accepted; an auto-dereferenced `Rc` receiver (`k.bump(io)`) is still rejected. With the labels now known for method calls, the argument loop checks only the arguments the future actually borrows, as it already did for plain function calls.

Regression test: `tests/async_await.test.yo`, "a borrowing method future on a ref receiver lends the handle (§3.13 A2)" (the receiver and handle spellings both run; the `Rc` auto-deref stays rejected), and `tests/io/async_traits.test.yo`, "BufReader wraps a user Reader through its generic parameter" (`m.read_to_string(io)` on a `ref` reader).
