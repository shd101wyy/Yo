# A generic function bound with `:=` is called through an undeclared symbol

**Status:** OPEN. **Found:** 2026-10-10, while probing
`issues/fixed/a-local-function-value-returning-an-impl-fn-calls-through-a-void-pointer-signature.md`
(reproduces on the tree before and after that fix; independent of `Impl`).
**Severity:** S2 — a program that passes `check` fails at the C compiler
(`use of undeclared identifier`); no wrong code reaches a binary.

## Repro

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  id := (fn(generic(T : Type), x : T) -> T)(x);
  println(`${id(i32(42))} ${id(i64(7))}`);
});
export(main);
```

```
$ yo compile repro.yo --optimize 2 -o a.out
a.out.c:2221:21: error: use of undeclared identifier 'yo_id_15068637160664750284000000'
```

The same definition bound with `::` (`id :: (fn(generic(T : Type), x : T) -> T)(x);`
inside `main`) compiles and prints `42 7`.

## What the C shows

```c
void* __yo_v_id = yo_id_15068637160664750284000000;
int32_t t0 = (((int32_t (*)(void*))__yo_v_id)((void*)(42)));
int64_t t1 = (((int64_t (*)(void*))__yo_v_id)((void*)(7LL)));
```

The `:=` binding makes the generic definition a RUNTIME function pointer. A
generic function has no single C symbol (each call specializes it), so the
pointer names the unspecialized definition, which is never emitted, and each
call passes its argument through the unresolved `T` lowered to `void*`.

## Direction

A generic function is a compile-time value: either the `:=` binding of one is
rejected at `check` with a diagnostic pointing at `::`, or the binding is kept
comptime-known so every call specializes as the `::` form does. The first is
the smaller, stricter rule (Rust has no first-class generic fn values either).
