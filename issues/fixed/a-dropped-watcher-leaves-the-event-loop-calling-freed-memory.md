# A dropped `Watcher` leaves the event loop calling into freed memory

**Status:** FIXED 2026-09-10 — `std/fs/watch.yo` gained a `Dispose` impl.

## Symptom

`std/fs/watch`'s `Watcher` had a `close()` method and **no `Dispose` impl**, so
a watcher that simply fell out of scope was never unregistered:

```rust
{ watch, WatchOptions } :: import("std/fs/watch");
_start_watching :: (fn(p : Path, exn : Exception) -> unit)({
  w := watch(p, WatchOptions.defaults(), exn);
  // ... no w.close(); w's last reference dies here
});
```

## Why this is a use-after-free, not just a leak

`watch` registers the callback with a **raw, non-owning** pointer to the
watcher itself (`std/fs/watch.yo`):

```rust
rc := events.fs_event_start(w._handle, cstr, flags, _on_fs_event, unsafe.cast(w, *u8));
```

`unsafe.cast(w, *u8)` does not dup the Rc, so the runtime's active-watch list
holds a pointer that does not keep the watcher alive. When the last Yo-side
reference dies, the `Watcher` is freed while still registered, and the next
backend notification runs:

```rust
_on_fs_event :: (fn(path : *u8, mask : i32, user_data : *u8) -> unit)({
  w := unsafe.cast(user_data, Watcher);
  if(w._active, {                      // <-- read of freed memory
    ...
    w._queue.push(...);                // <-- write into freed memory
```

`w._active` is a read of freed memory, and if the freed bytes happen to be
nonzero it goes on to `push` into a freed `ArrayList` — heap corruption on the
event loop thread, at an arbitrary later time, with no connection to the code
that dropped the watcher.

On top of that, `__yo_fs_event_close` is what frees the backend handle and its
descriptor (`src/codegen/async/runtime_io_common.yo`):

```c
static void __yo_fs_event_close(void* h) {
  __yo_fs_event_t* handle = (__yo_fs_event_t*)h;
  if (!handle) return;
  if (handle->active) __yo_fs_event_stop(h);
  __yo_free(handle);
}
```

so a dropped watcher also leaks the `__yo_fs_event_t` and its inotify (Linux)
or kqueue (macOS) descriptor. **Linux caps inotify instances per user** —
`/proc/sys/fs/inotify/max_user_instances`, default 128 — so this leak is not
merely untidy: a program that creates and drops watchers in a loop stops being
able to watch anything at all, and `watch` starts throwing `IoError`.

## Why no other closeable in std had this

Every other closeable resource in `std/` pairs its `close` with a `Dispose`:
`File`, `TcpListener`, `TcpStream`, `UdpSocket`, `Cond`, `RwLock`, `Mutex`,
`Channel`, `TempFile`, `TempDir`. `Watcher` was the only one that shipped a
`close()` and stopped there — and it is the one where a missed teardown is a
UAF rather than a leak, because it is the only one that hands the runtime a
non-owning self-pointer.

## Fix

```rust
impl(
  Watcher,
  Dispose(
    dispose : (fn(self : Self) -> unit)(self.close())
  )
);
```

`close` changed from `inout(self)` to `self : Self` so `dispose` can delegate
to it — every other closeable in `std/` already spells it that way, and
`Watcher` is a `ref(struct)`, so the field writes work identically through the
Rc handle. `close` was already idempotent (`if(self._active, …)`), so an
explicit `close()` followed by drop stops the watch exactly once.

The `Dispose` impl is also what makes the non-owning `user_data` **sound**
rather than merely convenient: the callback can no longer outlive the object,
because the object's own teardown removes it from the loop's list.

## Test

`tests/fs/watch.test.yo` — "a watcher dropped without close() releases its
backend handle": 200 create-and-drop cycles, with the **descriptor number** as
the oracle, then a fresh watcher that must still deliver an event.

The oracle matters. My first version asserted that the 200 cycles all succeed,
reasoning that Linux caps inotify instances at 128 by default so the loop would
throw. **That test passed with the `Dispose` impl removed** — this machine's
`RLIMIT_NOFILE` swallows 200 leaked macOS watchers without complaining, so on
macOS it was vacuous, and I would have shipped a test that proves nothing on
the platform I develop on.

The replacement opens and closes a probe file before and after the loop and
compares the descriptor numbers. The kernel hands out the lowest free
descriptor, so that reads as "how many descriptors are in use" with no
dependence on any limit — and each live watcher holds one inotify instance on
Linux, or an `O_EVTONLY` descriptor **plus** a kqueue descriptor on macOS.
Verified both ways with the impl in and out:

```
  ✗ a watcher dropped without close() releases its backend handle     (no Dispose)
  ✓ a watcher dropped without close() releases its backend handle     (with Dispose)
```

The use-after-free half is not directly observable without a sanitizer (and
macOS blocks ASan under AMFI — see the GuardMalloc recipe), but it has the same
single cause and the same single fix.

## The `ChildStdin` half of the same batch

`std/process/command.yo`'s new `ChildStdin` handle has the same hazard in a
gentler form: a dropped write end that does not close leaves the child waiting
for an EOF that never arrives. Its test (`tests/process/command.test.yo`,
"dropping a ChildStdin closes the pipe") therefore **bounds** its read with
`std/async`'s `timeout` rather than reading straight through — without the
`Dispose` impl the bare read HANGS, and a hanging test burns a CI job's whole
timeout instead of reporting a failure. Bounded, the regression reports in
~2 seconds.
