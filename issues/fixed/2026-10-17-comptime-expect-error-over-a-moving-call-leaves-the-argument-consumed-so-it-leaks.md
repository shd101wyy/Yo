# `comptime_expect_error` over a call that moves a local leaves the local consumed, so it leaks

**Severity:** S3 — a local passed by value to a call that `comptime_expect_error` expects to fail is never dropped: the rejected call's move leaks out of the trial, so the local's scope-end drop is skipped (a bounded leak, seen only under LeakSanitizer).

**Found:** 2026-10-17, by the Tier 1 gate of #1428: `tests/copy_trait.test.yo` "Copy: where(T <: Copy) rejects a closure that owns a String" fails locally with a LeakSanitizer report. CI passes it because it runs with `YO_TEST_LEAK_VERDICT=0`.
**Status:** open.

## Symptom

```yo
{ String } :: import("std/string");
_ct_need_copy_g :: (fn(generic(T : Type), x : T, where(T <: Copy)) -> T)(x);
main :: (fn() -> unit)({
  s := String.from("hi");
  (c2 : Impl(Fn() -> usize)) = ({ s }() => s.len());
  comptime_expect_error(_ct_need_copy_g(c2), "does not implement required trait Copy");
});
export(main);
```

```text
SUMMARY: AddressSanitizer: 34 byte(s) leaked in 2 allocation(s).
```

`yo compile --sanitize address --allocator system`, on develop `5425cd7bf`
and on the branch above alike. The same program without the
`comptime_expect_error` line, or calling `c2()` instead, leaks nothing.

## Root cause (suspected, not traced)

- The argument loop marks `c2` consumed while it moves the closure into the
  by-value parameter, before the `where(T <: Copy)` check rejects the call.
- `comptime_expect_error` catches the rejection, but the consumption it
  recorded on the caller's binding stays. So the closure's scope-end drop,
  which would release the captured `String`, is skipped.

## Fix direction

The trial a `comptime_expect_error` runs should not leave caller-side
ownership effects behind. Snapshot and restore the `consumed_at_token` of the
caller's bindings around it, as the checking phase does for trial calls
(`consume_argument_for_parameter` skips its moves under
`is_in_function_call_checking_phase`).


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

Fixed by PR #1459 (fix/cee-move-marks).
