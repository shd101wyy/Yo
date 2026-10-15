# A module-level `::` constant can be assigned at runtime, and its compile-time and runtime values diverge

**Severity:** S2. The program is accepted and silently computes with two different values for one constant. There is no memory unsafety, so it is not S1.

**Status:** open. Found 2026-10-15 while checking how bindings behave today for decision 47 (`plans/handover/VBD_HANDOVER_2026-10-15.md` §5.11). Decision 47 makes the write an error: a `::` binding without `mut(...)` is immutable.

## Repro

Seed v0.2.62, `yo compile c4.yo -o c4 && ./c4; echo $?`:

```yo
{ exit } :: import("std/process");
G :: i32(1);
H :: (G + i32(10));
f :: (fn() -> i32)({ G = i32(3); return((G + H)); });
main :: (fn() -> unit)({ exit(usize(f())); });
export(main);
```

- **Expected:** a compile error, because `G` is a compile-time constant.
- **Actual:** the program compiles and exits with **14**:
  - the runtime write makes `G` read 3;
  - `H` was folded at compile time from `G == 1`, giving 11.
- `yo check` accepts the same module with no diagnostic.

A statement-level `a :: 1; a = 2;` inside a function body is also accepted today, and `comptime_assert((a == 2), …)` passes after it. That is a compile-time reassignment, which is consistent within compile time. Decision 47 still makes it an error unless the binding is spelled `mut(a) :: 1`.

## Fix

Ship it with decision 47's Generation A, or earlier as its own fix. Assigning to a `::` binding outside compile-time evaluation is an error at the assignment, naming the binding and its definition. The test goes in `tests/` with the fix: the repro above must fail to compile.
