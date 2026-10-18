# A closure moved inside a failing `comptime_expect_error` stays moved and leaks

**Severity:** S3 — test-only construct: a closure that owns a counted capture, passed by value inside a `comptime_expect_error(...)` whose call is rejected, is marked moved although no code runs. Its scope-end drop is skipped (a leak under ASan) and a later use is E0901. `tests/copy_trait.test.yo` fails on develop because of it.

**Status:** open. Found 2026-10-17 while gating the `HashMap` move-only fix
(`issues/fixed/a-hashmap-of-a-move-only-key-or-value-does-not-compile.md`).
`tests/copy_trait.test.yo` fails with the same leak on develop `ed733408c`
(the develop-built `yo-dev-ed733408c`) and on the fix branch, so the fix did
not cause it.

## Symptom

`yo test tests/copy_trait.test.yo`:

```text
  ✗ Copy: where(T <: Copy) rejects a closure that owns a String
    Memory leak detected:
    ==1075260==ERROR: LeakSanitizer: detected memory leaks
    Direct leak of 32 byte(s) in 1 object(s) allocated from:
    Indirect leak of 2 byte(s) in 1 object(s) allocated from:
    SUMMARY: AddressSanitizer: 34 byte(s) leaked in 2 allocation(s).
```

## Reproducer

```yo
{ String } :: import("std/string");
_ct_need_copy :: (fn(comptime(T) : Type, x : T, where(T <: Copy)) -> T)(x);
main :: (fn() -> unit)({
  s := String.from("hi");
  (c : Impl(Fn() -> usize)) = ({ s }() => s.len());
  comptime_expect_error(_ct_need_copy(type_of(c), c), "does not implement required trait Copy");
});
export(main);
```

`yo compile --sanitize address --allocator system` and run: 34 bytes leak
(the capture struct and the `"hi"` buffer). Adding `println(c());` after the
`comptime_expect_error` is E0901 `use of moved value: c`, although the call
that would have moved `c` was rejected and emits nothing.

The same shape with a move-only STRUCT argument
(`_Mo :: struct(s : String)`, `comptime_expect_error(_take(type_of(m), m), …)`)
neither leaks nor marks `m` moved: only the closure argument's move sticks.

## Root cause (partial)

`consume_argument_for_parameter` (`src/evaluator/calls/helper.yo`) moves a
closure argument through its callable-value branch (`set_expr_as_consumed`),
and that mark is not rolled back when the enclosing call is then rejected
inside `comptime_expect_error`. The struct argument goes through
`transfer_explicit_copy_value`; why its mark does not survive the failed
call, and the closure's does, is not yet established.

## Fix direction

`comptime_expect_error` should evaluate its expression without leaving
ownership effects in the caller's environment: snapshot the move state
(`consumed_at_token`) of the variables the expression names and restore it
when the expected error is caught. The regression test is the reproducer as a
`tests/copy_trait.test.yo` case that reads `c` afterwards, plus the existing
test passing its leak check.


## Fix (landed)

One mechanism for all three docs (and the fourth of the family,
`2026-10-17-comptime-expect-error-marks-its-operands-moved.md`, which arrives
with PR #1422's branch and is closed by the same change):
`evaluate_comptime_expect_error`
(`src/evaluator/builtins/comptime_expect_error.yo`) now snapshots every
frame's `consumed_at_token` list before the argument trial and restores it
after the frame truncation, alongside the other state the expected throw can
strand. A rejected expression leaves no ownership effects on the caller's
bindings: the operand keeps its scope-end drop (no leak), and a later use is
no longer E0901.

The regression coverage: `tests/copy_trait.test.yo`'s existing test now CALLS
`c` and `c2` after their rejections (the E0901 was the fails-before), and a
new test drops a `Drop`-counted capture through both the `comptime(T)` and
the `generic(...)` rejections (`g_ct_cee_disposed == 2`), which is visible
in CI without a leak verdict.
