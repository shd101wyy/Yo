# A module-level `::` constant can be assigned at runtime, and its compile-time and runtime values diverge

**Severity:** S2. The program is accepted and silently computes with two different values for one constant. There is no memory unsafety, so it is not S1.

**Status:** fixed 2026-10-15 on `fix/runtime-write-to-comptime-constant` (error E0918). Found 2026-10-15 while checking how bindings behave today for decision 47 (`plans/handover/VBD_HANDOVER_2026-10-15.md` §5.11).

## Repro

Seed v0.2.62, `yo compile c4.yo -o c4 && ./c4; echo $?`:

```yo
{ exit } :: import("std/process");
G :: i32(1);
H :: (G + i32(10));
f :: (fn() -> i32)({
  G = i32(3);
  return(G + H);
});
main :: (fn() -> unit)({
  exit(usize(f()));
});
export(main);
```

- **Expected:** a compile error, because `G` is a compile-time constant.
- **Actual:** the program compiles and exits with **14**:
  - the runtime write makes `G` read 3;
  - `H` was folded at compile time from `G == 1`, giving 11.
- `yo check` accepts the same module with no diagnostic.

A statement-level `a :: 1; a = 2;` inside a function body is also accepted today, and `comptime_assert((a == 2), …)` passes after it. That is a compile-time reassignment, which is consistent within compile time. Decision 47 still makes it an error unless the binding is spelled `mut(a) :: 1`.

## Fix

An assignment to a compile-time binding (`G :: v`, `comptime(G) := v`) that runs when the program runs is error **E0918** (`E_COMPTIME_BINDING_RUNTIME_WRITE`), reported at the write with a second label on the definition and the hint to declare a runtime binding with `:=`:

```text
error[E0918]: Cannot assign "G" when the program runs: it is a compile-time constant (a `::` binding) declared at module level. Every use of it was folded to its value while compiling, so a runtime write would leave the folded uses reading the old value.
```

`_reject_runtime_write_of_comptime_binding` (`src/evaluator/exprs/assignment.yo`) runs for a plain `x = v` and for a field or element write `G.x = v` / `G(i) = v` (rooted through value steps only, so a write through a `ref` handle is not a write of the binding).

The assignment runs at runtime when it is evaluated inside a function, closure, `io.async` or test body whose result is not compile-time (not `-> comptime(...)`, `-> Type`, `-> Expr`: `fn_ctx_returns_comptime` / `in_compile_time_fn_body`, the E1104 test), and outside CTFE execution and CTFE capability analysis (`force_compile_time_bindings`, `is_analyzing_ctfe_capability`, `ctfe_depth`). Inside such a body it is rejected when:

- the binding is declared outside the body: at module level (the repro), or in an enclosing function (a nested `fn` writing the outer `a :: 1`, which had the same divergence: the outer `b :: a` folded the closure's value);
- the value written is a runtime one: `a :: i32(1); a = x;` with a runtime `x`.

Why it was accepted: the evaluator treated every write of a compile-time-only variable as a compile-time write. It stored the new value into the binding during the function's definition-time evaluation, and codegen skipped the statement (`is_compile_time_only_assignment`). Uses folded before the write kept the old value; uses folded after it saw the new one.

Unchanged, compile-time behaviour:

- a module-level `G :: 1; G = 2;`;
- a body's own `a :: 1; a = 2;` with a compile-time value, observed by `comptime_assert`;
- a `while(comptime(...))` counter;
- `-> comptime(...)` bodies and CTFE.

Decision 47 later makes those spell `mut(a) ::`.

Not covered: a compile-time value written to a body's own `::` under a runtime `cond` arm or loop. That needs flow sensitivity, and decision 47's `mut(a) ::` owns it.

Found while fixing: `return(a)` of a function-local `::` emits an undeclared C identifier, with no assignment involved (`issues/2026-10-15-return-of-a-function-local-comptime-constant-emits-an-undeclared-c-identifier.md`).

Tests: `tests/comptime.test.yo`:

- "a compile-time constant assigned at runtime is E0918": the repro shape, a field write, a nested function writing an outer `::`, a runtime value, and a test body;
- "compile-time reassignments and runtime globals still work": module-level reassignment, a body's own reassignment, a compile-time loop counter, and a module-level `:=` written at runtime.

The tree (src, std, tests) had no runtime write to a `::` binding.
