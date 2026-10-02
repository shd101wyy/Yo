# `comptime(name) := value` is parsed as a destructuring assignment

**Severity:** S2 — a documented compile-time declaration form is rejected: `comptime(x) := v` (DESIGN.md "Variables") fails to compile.

**Status: FIXED 2026-10-01** together with
`issues/fixed/colon-equals-is-accepted-in-a-compile-time-context.md`.

## Symptom

```rust
f :: (fn(comptime(n) : i32) -> comptime(i32))({
  comptime(i) := i32(0);
  i = (i + n);
  i
});
v :: f(3);
```

`yo check` (0.2.47):

```
error: Destructuring assignment not supported for the right-hand type: i32
```

The same at module level (`comptime(y) := 5;`). `docs/en-US/DESIGN.md`
("Variables") lists `comptime(y) := 5;` as a compile-time variable.

## Cause

`evaluate_initialization_assignment` unwrapped `given(name)`, `inout(name)`
and `thread_local(name)` on the left of `:=`, but not `comptime(name)`, so the
call fell to the destructuring branch.

## Fix

`comptime(name) := rhs` unwraps the name and binds it exactly like
`name :: rhs` (compile-time, no runtime conversion). It matters more now: with
E1104 rejecting `name := rhs` in a compile-time body, this is one of the
compile-time spellings that remain.

## Verification

`tests/comptime.test.yo`: `comptime(i) := i32(2)` inside a compile-time body,
reassigned and asserted (`with_wrapped_walrus(4) == 8`), and a module-level
`comptime(_ct_module_seven) := 7` asserted with `comptime_assert`. Both fail
on the 0.2.47 seed.
