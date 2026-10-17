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
