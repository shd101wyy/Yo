# A safe file can import and call raw runtime externs from `std/sys/externs.yo`

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-9).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 4, rule D6 of `plans/reference/PARALLELISM_RULES.md`). Was: **Class:** trust-boundary leak (safe mode). Low severity for data races on
its own; it matters because the parallelism model's whole argument is "user code without the
pragma cannot reach the primitives' internals".
**Measured:** yo 0.2.41 seed against the develop tree's `std`, macOS arm64.

## Repro

`issues/repros/safe-file-calls-imported-runtime-extern.yo`:

```rust
{ __yo_async_blocking_begin } :: import("std/sys/externs.yo");
main :: (fn() -> unit)({
  __yo_async_blocking_begin();      // no pragma in this file; check is green
});
```

Declaring the same extern locally is rejected as documented (`'extern(...)' is not available in
safe code`), so the gate is on the DECLARATION site only; a pragma'd module that `export`s an
extern hands it to every importer.

## Consequence

`std/sys/externs.yo` exports ~80 raw `__yo_*` entry points (async I/O starts over `*u8`, the
loop's blocking bracket, `__yo_async_loop_self_ptr`, clock/uname/socket syscalls). Most need a
raw pointer a safe file cannot make, but the zero-argument ones (`__yo_async_blocking_begin`,
`__yo_async_blocking_end(owner)` with an `owner` obtained from `__yo_async_loop_self_ptr`) let
safe code unbalance the event loop's cross-thread bracket, and any future zero-argument export
inherits the hole.

## Fix direction

Calling (not merely naming) an `extern`-bound function is a safe-mode violation unless the
CALLING file has the pragma, mirroring the rule for `unsafe(...)` — checked at the call site in
`src/evaluator/calls/function.yo` where the callee's `FuncVal` is known to be an extern binding.
std wrappers (`std/thread`, `std/fs`, …) all carry the pragma, so nothing in std changes.
Regression: the repro as a `comptime_expect_error` in `tests/safe_mode*.test.yo`.

## Fix (2026-09-26, rule D6)

Narrower than the fix direction above, which was measured against the language before it
landed: `io.await`, `io.async`, `io.spawn` are extern-bound FIELDS of the `Io` value, so "calling
any extern from a safe file" rejects every async program. What landed, in `evaluate_function_call`
(`src/evaluator/calls/function.yo`) beside the extern-"c" `unsafe(...)` gate: a callee whose
type is an extern of a language other than `"c"` (the runtime's `__yo_*` entry points), called
BY NAME (a bare-identifier callee, which is what a destructured import binds), from a file without
`pragma(Pragma.AllowUnsafe)` and not compiler-synthesized, is an error — "Calling the runtime
extern '__yo_async_blocking_begin' is not available in safe code … call the std API instead".
Extern "c" callees were already gated (their call needs `unsafe(...)`, which needs the pragma).

A field of a MODULE value (`X :: import("std/sys/externs.yo"); X.__yo_async_blocking_begin()`)
is a by-name call too (`_d6_callee_is_by_name`); a field of a runtime value is not.

Seven `std/sys` wrappers called runtime externs without the pragma (`timer`, `fcntl`, `lock`,
`seek`, `umask`, `fallocate`, `socket` — so the fix direction's "std wrappers all carry the
pragma" was wrong); they are the audited base the rule trusts, and now declare it.

Tests: the repro, and its module-value form, as `comptime_expect_error` blocks in
`tests/parallelism_soundness.test.yo` (the imports themselves stay legal); `yo check ./std` and the fast suite are the regression gate for
std's pragma'd wrappers.
