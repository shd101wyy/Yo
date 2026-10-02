# A `Waker` in a program without `await` calls an undeclared runtime function

**Severity:** S2 — a valid program fails in the C compiler and `yo check` passes. A struct holding an `Option(Waker)` is enough.
**Found:** 2026-10-02, bisecting `issues/fixed/a-comptime-type-argument-holding-a-resolved-impl-never-specializes.md` (`sizeof(Waker)` failed to link). It reproduces on develop and on v0.2.48.

## Reproducer

```rust
{ println } :: import("std/fmt");
{ Waker } :: import("std/async/waker");
_Slot :: struct(w : Option(Waker), n : i32);
main :: (fn() -> unit)({
  s := _Slot(w : .None, n : i32(1));
  println(`${s.n}`);
});
export(main);
```

```
error: call to undeclared function '__yo_waker_release'; ISO C99 and later do not support implicit function declarations
```

## Cause

The async runtime is emitted only when codegen sees async use (`context.uses_async`). That covers an `io.await` / `io.spawn`, or a call to an extern the runtime defines, recognized by name prefix in `is_async_runtime_extern_name` (`src/codegen/exprs/async.yo`): `__yo_poll_`, `__yo_fs_event_`, `__yo_async_`. The waker family (`__yo_waker_new`, `__yo_waker_wake`, `__yo_waker_is_woken`, `__yo_waker_release`) is defined only in `runtime_core.yo`, but its prefix was not in the list. A program that stores a `Waker` without awaiting emits `Waker`'s Dispose, which calls `__yo_waker_release`, without the runtime that defines it. Every other `__yo_*` extern std declares is either matched by those prefixes or emitted unconditionally by the sys runtime (`generate_sys_runtime`). The waker family was the only gap.

## Fix

`is_async_runtime_extern_name` also matches `__yo_waker_`. The regression test is "a struct holding an Option(Waker) links without any await" in `tests/std_export_coverage.test.yo` (a batch with no async). It fails on v0.2.48 and passes with the fix.
