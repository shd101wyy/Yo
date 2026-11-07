# Should `std/sys`'s operations take `io` before the `Io` interface lands?

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN until IO-1b (v0.2.81) closes it. Filed 2026-11-07 from
VERDICTS-32 §6.

## The question

[`plans/backlog/IO_INTERFACE_AND_STD_RUNTIME.md`](../../plans/backlog/IO_INTERFACE_AND_STD_RUNTIME.md)
makes `Io` a `{ctx, vtable}` value carrying every operation the event loop
mediates. When that lands, the 90 `__yo_async_*_start` externs in
`std/sys/externs.yo`, and their `std/sys` wrappers, gain an `io` argument.
For example, `openat(dirfd, path, flags, mode)` becomes
`openat(dirfd, path, flags, mode, io)`.

Should those wrappers take an (unused) `io` argument now, ahead of the
interface, so that IO-1b's diff is smaller?

## Recommendation

No. The argument arrives with IO-1b, in one sweep.

- **Pre-migrating gains nothing.** Every caller above `std/sys` (`std/fs`,
  `std/net`, `std/time/sleep`, `std/process`, `std/async`) already holds an
  `io`, so IO-1b changes no signature above `std/sys` either way.
- **An unused parameter would be the kind of scaffolding Yo does not carry.**
  It is a parameter whose value means nothing until a later release.
