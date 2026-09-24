# A safe file can import and call raw runtime externs from `std/sys/externs.yo`

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-9).
**Status:** OPEN. **Class:** trust-boundary leak (safe mode). Low severity for data races on
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
