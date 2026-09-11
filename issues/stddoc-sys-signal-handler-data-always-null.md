# `SignalHandler`'s `data` parameter is always NULL — the user-data table is never written

**Status:** open. Found by reading, during the `std/` `///` documentation
sweep. Not fixed here (the sweep is documentation-only), and the fix is a
design choice rather than a one-liner — see below.

## What happens

`std/sys/signal.yo` declares

```rust
SignalHandler :: (fn(data : *u8) -> unit);
on_signal :: (fn(signum : i32, handler : SignalHandler) -> i32)(
  __yo_signal_start(signum, unsafe.cast(handler, *u8))
);
```

so a handler is handed a `*u8` on every delivery. That pointer can never be
anything but NULL: `on_signal` has no parameter to supply it, and the runtime
never fills the slot it would come from.

`src/codegen/async/runtime_io_common.yo`, the POSIX arm:

```c
static void (*__yo_signal_handlers[32])(void*) = {NULL};
static void* __yo_signal_handler_data[32] = {NULL};   // written NOWHERE

static void __yo_signal_trampoline(int signum) {
  if (signum >= 0 && signum < 32 && __yo_signal_handlers[signum]) {
  __yo_signal_handlers[signum](__yo_signal_handler_data[signum]);   // always NULL
  }
}

static int32_t __yo_signal_start(int32_t signum, void* handler) {
  if (signum < 0 || signum >= 32) return -EINVAL;
  __yo_signal_handlers[signum] = (void (*)(void*))handler;
  /* no assignment to __yo_signal_handler_data[signum] */
  ...
}
```

`runtime_io_windows.yo` is the same shape and is explicit about it — it
assigns `__yo_signal_handler_data[signum] = NULL;`.

Contrast the two neighbouring callback APIs in the same layer, which DO carry
user data end to end: `__yo_poll_start(handle, events, callback, user_data)`
and `__yo_fs_event_start(handle, path, flags, callback, user_data)`, both
surfaced as a `user_data : *u8` parameter in `std/sys/events.yo` and used by
`std/fs/watch.yo` to find its `Watcher` from inside the callback.

## Why it matters

It is a parameter that looks like the mechanism for exactly the thing
`std/fs/watch` does with its equivalent — recovering context inside a
callback — and it silently is not. A caller who writes
`unsafe.cast(data, *MyState)` gets a NULL deref on the first signal, in a
signal handler, which is close to the worst place to debug one.

It is latent rather than live: `std/signal.yo`, the only consumer, ignores the
parameter, and `tests/sys/signal.test.yo` does too. So nothing is broken
today — the API is.

## Reproducer

No separate `.yo` file: the observation is static (there is no assignment to
`__yo_signal_handler_data` anywhere in `src/`, which
`grep -rn "__yo_signal_handler_data" src/` shows in nine lines — two
declarations, four reads inside trampolines, and three stores, every one of
which stores NULL). A runtime demonstration would have to
deliberately deref NULL inside a signal handler, which is not a useful test.

## Root cause

The trampoline was written to the shape of the poll / fs-event callbacks,
which pass `user_data` through `__yo_*_start`, but `__yo_signal_start` was
given only `(signum, handler)` — so the table it reads from has no writer. The
Yo-level signature was derived from the C callback type
(`void (*)(void*)`) rather than from what `on_signal` can actually supply.

## Suggested fix — pick one, do not leave both

1. **Carry it, matching `events.yo`.** Add a `user_data : *u8` parameter to
   `on_signal` and to `__yo_signal_start`, and store it in
   `__yo_signal_handler_data[signum]` in both the POSIX and Windows arms. This
   makes signal handlers consistent with poll and fs-event handlers, and lets
   a future `std/signal` deliver to a per-`Signal` object.
2. **Drop it.** Make `SignalHandler :: (fn() -> unit)` and have the trampoline
   call with no argument. Smaller, and honest — but it forecloses option 1
   and it is a breaking change to `std/signal`'s exported `SignalHandler`.

Option 1 is the better fit: `std/signal`'s handlers are the ones most likely
to want context (a shutdown flag, a channel), and the `events.yo` precedent
already exists in the same layer. Either way the test belongs in
`tests/sys/signal.test.yo` — register with a non-NULL cookie, `kill` self,
assert the handler saw that exact pointer. Written that way it fails today.
