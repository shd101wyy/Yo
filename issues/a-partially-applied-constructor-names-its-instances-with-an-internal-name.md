# A partially applied type constructor names its instances `__pa_fn_<id>(...)`

**Severity:** S3 — every diagnostic and hover that prints a type first minted through a partial application (`P1 :: Pair(i32, _)`) shows a compiler-internal name instead of `Pair(i32, bool)`.
**Found:** 2026-10-06, by the adversarial review of #1241 (decision 32, `plans/VALUES_BY_DEFAULT.md`): the new E0613 for `P1.first(p)` printed the internal name. The name is not #1241's: E0601 prints it too, with no unapplied-constructor call involved.
**Measured:** tree-built compiler at `feat/vbd-d32-unapplied-ctor-method` (yo 0.2.52 seed).

## Repro

```rust
Pair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(a : A, b : B)
);
P1 :: Pair(i32, _);
main :: (fn() -> unit)({
  p := P1(bool)(a : i32(3), b : true);
  (z : u8) = p;
});
export(main);
```

```
error[E0601]: Incompatible types:
- Expected: u8
- Given   : __pa_fn_104338(i32, bool)
```

Expected: `- Given   : Pair(i32, bool)`. When `Pair(i32, bool)` is written anywhere before `P1(bool)` is first evaluated, the same type prints correctly, so the output depends on evaluation order.

## Root cause

Partial application (`src/evaluator/calls/function.yo`, the `_`-hole block in the FuncVal call arm) mints a FuncVal whose body is the call `__pa_fn_<id>(captures..., holes...)`, where `__pa_fn_<id>` is the capture holding the original constructor. The display-name side table (`register_type_display_name`, `src/types/string.yo`) is filled by `comptime_fn.yo` from the callee expression's head token, and the first registration for a type id wins. The first comptime call that mints the struct is the one inside the partial application's body, whose head token is the capture name, so `__pa_fn_<id>(i32, bool)` is recorded and the outer `P1(bool)` registration is ignored.

## Fix direction

The partial application knows the original callee expression (`Pair`, or the member of `m.Pair`), so it can carry that display head to the inner call and register `Pair(i32, bool)`. A test then asserts the E0601 text above names `Pair(i32, bool)`, and `tests/unapplied_constructor_method.test.yo`'s `_Partial` case can pin `which has type \`_Pair(i32, bool)\``.
