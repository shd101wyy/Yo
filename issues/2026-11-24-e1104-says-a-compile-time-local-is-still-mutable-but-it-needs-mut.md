# E1104 says a compile-time local declared with `::` is "still mutable", but reassigning one without `mut` is E0917

**Severity:** S3: a misleading diagnostic. Following E1104's advice and then reassigning the local in a loop fails with E0917; the repair the user needs is `mut(x) :: v`, which neither the message nor `yo explain E1104` names.

- Filed: 2026-11-24 (lane akc-k2k3k6, while re-verifying the pack's E1104 sharp edge with a tree binary built from develop `34359627e`).

## Reproducer

```yo
{ assert } :: import("std/assert");

count :: (fn(comptime(n) : i32) -> comptime(i32))({
  x :: i32(0);
  i :: i32(0);
  while(comptime(i < n), {
    x = (x + i32(2));
    i = (i + i32(1));
  });
  x
});

main :: (fn() -> unit)({
  assert(count(i32(3)) == i32(6), "comptime locals");
});
export(main);
```

`yo check`:

```text
error[E0917]: Cannot assign to `x`: it is a compile-time binding declared without `mut`, so it is immutable (plans/VALUES_BY_DEFAULT.md decision 47).
6 |     x = (x + i32(2));
3 |   x :: i32(0);
```

With `mut(x) :: i32(0);` and `mut(i) :: i32(0);` the program checks.

## Root cause

The E1104 texts predate decision 47 (immutable bindings by default) and were not updated when it made `::` bindings immutable:

- `src/evaluator/exprs/initialization-assignment.yo` (the `:=` site): "declare the local with `::` (it is still mutable)."
- `src/evaluator/exprs/binding.yo` (the `(name : T) = v` site): "write "(comptime(name) : T)" (it is still mutable)."
- `src/diagnostics-registry.yo`, E1104's explanation in both languages: "They are still mutable: reassign them with `=` in a loop as usual."

## Fix direction

Say what is true: the compile-time forms are immutable like any binding, and `mut(x) :: v` makes one reassignable. The `:=` site could suggest `mut(x) ::` when the local is reassigned later in the body. A cli-case or `tests/internal` diagnostics test pins the new text.
