# `return(a)` of a function-local `::` constant emits an undeclared C identifier

**Severity:** S2 — a valid runtime function that returns a local `::` constant with `return(...)` fails in the C compiler; binding it to a `:=` local first, or ending the body with `a`, works around it.

**Status:** open. Found 2026-10-15 while fixing `issues/fixed/2026-10-15-a-module-level-comptime-constant-can-be-assigned-at-runtime.md` (E0918). Not fixed there: this bug needs no assignment at all.

## Repro

Seed v0.2.62, `yo compile q.yo -o q && ./q; echo $?`:

```yo
{ exit } :: import("std/process");
f :: (fn(x : i32) -> i32)({ a :: i32(1); return(a); });
main :: (fn() -> unit)({ exit(usize(f(i32(5)))); });
export(main);
```

- **Expected:** the program exits with 1.
- **Actual:** `yo check` accepts it, and the C compiler rejects the emitted code:

  ```text
  q.out.c:1985:10: error: use of undeclared identifier '__yo_v_a'; did you mean '__yo_v_x'?
  ```

| Body                                   | Result        |
| -------------------------------------- | ------------- |
| `a :: i32(1); return(a);`              | C error       |
| `a :: 1; return(a);`                   | C error       |
| `a :: i32(1); a`                       | exits with 1  |
| `a :: i32(1); y := a; return(y);`      | exits with 1  |
| `return(A);` with a module-level `A :: i32(1)` | exits with 1  |

The `return(...)` argument path emits the local by name: `a` is compile-time only and has no C declaration. The tail-expression path and a `:=` read fold `a` to its value. Codegen's `return` should fold a compile-time-only local the way the tail-expression path does (`src/codegen/exprs/return.yo`).

## Fix

Not started. The test goes in `tests/comptime.test.yo` with the fix: the repro's function must return 1.
