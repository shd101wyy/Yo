# Every program that sends on an async `Channel` fails with E0909 since `with_mut` takes `FnOnce`

**Severity:** S2 — any program that instantiates `std/async/channel.yo`'s `Channel(T)` send path is rejected at compile time (a valid program wrongly rejected; no workaround short of not using the async channel).

**Found:** 2026-10-29, develop battery 40762802803 on `086b01a7e`: `tests/async/channel.test.yo`, `tests/async/combinators.test.yo`, `tests/async/sm_protocol.test.yo` and `tests/async/waker.test.yo` failed to compile on every Linux, wasm and forced-epoll leg.

**Fixed:** `fix/develop-async-channel-fnonce`.

## Symptom

```text
error[E0909]: This value borrows `slot` (the capture `slot : &mut slot` at std/async/channel.yo:333:30),
so it is second-class and cannot be moved into a by-value (`sink`) parameter: a borrow never outlives
the scope that lends it.
```

## Root cause

#1655 (B4-0b Generation B) changed `RefCell.with_mut`'s body parameter from `&Impl(Fn(...))` to
`sink(body) : Impl(FnOnce(...))`. A closure whose capture list borrows a local (`{ &mut slot }`) is a
second-class value, so it cannot be passed to a `sink` parameter. Two callers still used the old
workaround, which existed because a `Fn` body could not move a capture: they lend an
`Option` slot and `take()` from it inside the body.

- `Channel(T)._push` in `std/async/channel.yo` is a generic body, so it is only checked when a program
  instantiates it. `check ./std` and the PR's own test selection (which included `sync/channel` but
  not `async/channel`) never reached it.
- `tests/async/waker.test.yo` parked a `Waker` the same way.

## Fix

Both bodies now move the value in, which is the shape `FnOnce` exists for:
`self._st.with_mut({ value }(s) => s._buf.push(value))` and
`slot.with_mut({ w }(cur) => { cur = Option(Waker).Some(w); })`.

## Test

The four failing files are the regression tests: before the fix, `channel.test.yo` fails 22/22 and
`waker.test.yo` 12/12 (the batch fails to compile); after it, 22/22 and 12/12 pass, with a compiler
built from develop's `src/` at `c0c99708f`, which is unchanged at `086b01a7e`.
