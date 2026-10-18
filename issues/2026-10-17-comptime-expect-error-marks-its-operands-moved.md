# `comptime_expect_error` marks the operands of its rejected expression moved, so they leak

**Severity:** S2: a bounded leak, and a valid program is rejected. A move-only
local passed by value inside an expression that `comptime_expect_error`
expects to fail is marked consumed, although the expression is never emitted.
The local is then never dropped, and a later use of it is E0901.

Found 2026-10-17 by the Tier 1 gate of `fix/collection-clone-through-borrow`:
`tests/copy_trait.test.yo` fails one test, "Copy: where(T <: Copy) rejects a
closure that owns a String", with a 32-byte LeakSanitizer report. CI runs the
language suite with `YO_TEST_LEAK_VERDICT=0` and never sees it.
**Measured on:** develop ed733408c (`yo-dev-ed733408c` with that commit's std:
28 passed, 1 failed) and on the `fix/collection-clone-through-borrow` build
(the same result).

## Symptom

```yo
{ String } :: import("std/string");
_need_copy :: (fn(comptime(T) : Type, x : T, where(T <: Copy)) -> T)(x);
main :: (fn() -> unit)({
  s := String.from("hi");
  (c : Impl(Fn() -> usize)) = ({ s }() => s.len());
  comptime_expect_error(_need_copy(type_of(c), c), "does not implement required trait Copy");
});
export(main);
```

`yo compile --sanitize address --allocator system` then running the binary
gives:

```text
==287327==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 32 byte(s) in 1 object(s) allocated from:
```

Without the `comptime_expect_error` line, nothing leaks. Passing the `String`
itself (`comptime_expect_error(_need_copy(String, s), …)`) leaks nothing
either. Adding `n := c();` after the `comptime_expect_error` line fails to
compile with `error[E0901]: use of moved value: c`, pointing at the argument
inside `comptime_expect_error`.

## Cause

The emitted `main` builds `c` (taking a second reference to the string
buffer), never emits the rejected call, and at scope exit releases only `s`:

```c
__yo_t_… __yo_v_c = _file____home_temp_…;
if ((__yo_v_s) != NULL) { __yo_decr_rc((void*)(__yo_v_s)); }
```

The E0901 on a later use shows that the move of `c` into the argument is
recorded in the enclosing scope while the expected-to-fail expression is
evaluated, before the `where(T <: Copy)` check fails. `comptime_expect_error` catches the error but
keeps the move, so `c` counts as consumed. No drop is scheduled for it, and
none is needed for the call, which is never emitted.

## Fix direction

`comptime_expect_error` should restore the ownership state (move marks and
deferred drops) of the enclosing scope after its expression fails, so that a
rejected expression has no effect on its operands. The test is
`tests/copy_trait.test.yo`'s existing case under the leak verdict, together
with a use of `c` after the `comptime_expect_error`, which must compile.
