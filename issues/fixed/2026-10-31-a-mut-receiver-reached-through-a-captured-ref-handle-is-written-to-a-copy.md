# A `&mut` receiver reached through a captured `ref` handle is written to a copy

**Severity:** S1 — a miscompile in safe code. Inside a closure, a `&mut self` call on a field of a captured `ref` handle (`h.c.bump()`, `h.xs.push(x)`) writes a C copy of the field, so the write is silently lost. Once B8 makes `ArrayList` and `String` values, the same shape double-frees: `h.xs.clear()` frees the elements through the copy while the field still holds them.

**Status:** FIXED 2026-10-31 on `fix/closure-capture-mut-receiver-spill`. Found the same day on `vbd/b8-arraylist-string-flip`: five `tests/rc.test.yo` tests (`hs2.xs.clear()` inside a closure, `hs2` a captured `ref` handle) reported heap-use-after-free under ASan once `ArrayList` became a value. Develop `9c78fdaf0` and the v0.2.73 seed lose the write.

## Reproducer

The test "a mut receiver reached through a captured ref handle is written in place" in `tests/closure.test.yo`:

```yo
_SpillCounter :: struct(n : i32);
impl(
  _SpillCounter,
  bump : (fn(self : &mut Self) -> unit)({
    self.n = (self.n + i32(1));
  })
);
_SpillBag :: ref(struct(c : _SpillCounter, xs : ArrayList(i32)));
_spill_run :: (fn(act : &Impl(Fn() -> unit)) -> unit)({
  act();
});
test("a mut receiver reached through a captured ref handle is written in place", {
  b := _SpillBag(c : _SpillCounter(n : i32(0)), xs : ArrayList(i32).new());
  h := b;
  _spill_run(
    &(
      () => {
        h.c.bump();
        h.xs.push(i32(7));
      }
    )
  );
  assert(b.c.n == i32(1), "the closure's bump reached the handle's counter");
  assert(b.xs.len() == usize(1), "the closure's push reached the handle's list");
});
```

On the seed the first assertion fails (`b.c.n` is 0).

## Cause

`_apply_ref_amp` (`src/codegen/exprs/other_fn_call.yo`) passes a `&mut` argument as `&(code)` when `_is_addressable_c_expr(code)` holds, and otherwise spills it to a fresh local and passes the local's address. A closure body reads a capture through its context pointer, so the receiver's C code is `((Ctx*)closure_context)->__yo_v_h->__yo_v_c`. The addressability check accepted a parenthesized head only when it was a dereference (`(*p)`), so the cast head failed it and the call became

```c
T __yo_ref_spill_0 = ((Ctx*)closure_context)->__yo_v_h->__yo_v_c;
bump(&(__yo_ref_spill_0));
```

## Fix

`_is_addressable_c_expr` also accepts a parenthesized pointer cast of an identifier or an addressable expression (`((T*)p)`, the new `_is_pointer_cast_c_expr`), provided a `->` member access follows it: the cast itself is not an lvalue, `((T*)p)->f` is. The receiver is now passed as `&(((Ctx*)closure_context)->__yo_v_h->__yo_v_c)`.
