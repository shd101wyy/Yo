# A local function value returning `Impl(Fn)` is called through a `void*`-returning signature

**Status:** OPEN. **Found:** 2026-10-10, while probing
`issues/fixed/cond-match-tail-adopts-the-abstract-impl-result-type.md` (reproduces on
seed v0.2.56 and on the tree with that fix; independent of `cond`/`match`).
**Severity:** S1 — a valid program that passes `check` and compiles without a
diagnostic crashes at runtime (SIGBUS, rc=138, at `-O2`).

## Repro

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mk := (fn(x : i32) -> Impl(Fn() -> i32))({
    (f : Impl(Fn() -> i32)) = ({ x }() => x);
    f
  });
  g := mk(i32(7));
  println(`${g()} (want 7)`);
});
export(main);
```

`yo compile repro.yo --optimize 2 -o a.out && ./a.out` exits 138 with no output. The
same function declared at module level (`mk :: (fn(x : i32) -> Impl(Fn() -> i32))(...)`)
prints `7`.

## What the C shows

```c
void __yo_user_main() {
  void* __yo_v_mk = yo_id_18237979924433214527000000;
  void* _file____User_temp_... = (((void* (*)(int32_t))__yo_v_mk)((int32_t)(7)));
  ...
static inline __yo_t_4246070578346537283 yo_id_18237979924433214527000000(int32_t __yo_v_x) {
```

The function returns the closure's capture struct BY VALUE, but the local `mk`'s
type lowers its `Impl(Fn() -> i32)` result to `void*` (the unresolved existential),
so the call site casts the function to `void* (*)(int32_t)`: an ABI mismatch, and
the "closure" `g` is then called through a garbage context.

## Likely root cause (not yet verified)

The local binding's function type keeps the declared, unresolved `Impl(Fn)` result
SomeT; the module-level path resolves a function's `Impl` result to the body's
concrete type (`function_return_impl_concrete_type`) and codegen reads that
resolution, but the `:=`-bound function value's type is never re-stamped with it.
Start from where codegen lowers a `Func` type's result for a function-pointer
local and compare with the module-level function's prototype emission.
