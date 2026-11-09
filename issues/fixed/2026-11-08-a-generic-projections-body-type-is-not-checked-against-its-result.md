# A generic projection's body type is not checked against its result, so the C compiler rejects it

**Severity:** S2. A program with an ill-typed projection body is accepted by the evaluator. The C compiler then fails on the emitted C (incompatible pointer types), where the evaluator should have rejected the body.

Filed 2026-11-08 by the G2 lane (`vbd/g2-holders`) on a develop `68d531aec` tree binary. `Rc.get_mut`'s first spelling, `_payload_mut : (fn(self : &mut Self) -> &mut T)(addr_of(self.*))`, checked under `yo check ./std` and failed the `tests/rc.test.yo` and `tests/arc.test.yo` batches in the C compiler. With `self : &mut Rc(T)`, `self.*` is the handle, so the body yields `*Rc(T)`, not `*T`.

## Reproducer

`issues/repros/2026-11-08-a-generic-projections-body-type-is-not-checked-against-its-result.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), W(T), at : (fn(self : &mut Self) -> &mut T)(unsafe(addr_of(self.*))));
main :: (fn() -> unit)({
  mut(w) := W(i64)(v : i64(1));
  w.at().* = i64(2);
  assert(w.v == i64(2), "written through the projection");
});
export(main);
```

```text
r3.c:2306:10: error: incompatible pointer types returning '… *' (aka 'struct …_struct *') from a function with result type 'int64_t *' (aka 'long *') [-Werror,-Wincompatible-pointer-types]
yo: error: compile: C compiler failed (exit 1)
```

The same body in a non-generic function, `(fn(h : &mut Rc(i32)) -> &mut i32)(unsafe(addr_of(h.*)))`, is rejected as it should be: "this body has type `*(Rc(i32))`". The v0.2.76 seed rejects the generic repro too, but at the call site ("Failed to evaluate left-hand side of assignment").

## Where to look

The projection-body check (the "a projection … this body has type" diagnostic) runs on the definition-time body. A body with `generic(...)` parameters defers to call time, and the specialized body's raw-pointer type is not compared with the result's pointee there.

## Fix

#1838 (`f23081973`, `issues/fixed/2026-11-08-a-generic-fn-forwarding-a-projection-call-as-its-reference-tail-emits-a-value.md`) gives a specialized generic body the concrete body's decision-24 check. The reproducer is now rejected in the evaluator, as the non-generic one is: "this body has type `*(W(i64))`" (verified on the holders tree binary `c33ee18ad`). That PR's tests in `tests/ref_return_ban.test.yo` pin the check.
