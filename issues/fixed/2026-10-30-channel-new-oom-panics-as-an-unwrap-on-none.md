# Channel.new reports an out-of-memory ring buffer as "Called unwrap on a None value"

**Severity:** S2. `Channel(T).new` allocated its ring buffer with the fallible `GlobalAllocator.malloc` and `.unwrap()`ped the result, so an exhausted heap killed the program with `Called unwrap on a None value (at std/prelude.yo:…)` instead of an allocation diagnostic. Every `Thread(T).spawn` (and so `spawn_blocking`) builds a channel first, which breaks the safe-mode contract that out-of-memory is always a diagnosed allocation failure (plans/SAFE_MODE.md §7, §14 R5). It also turned develop's tier-1 cli-diff gate red.

**Status:** FIXED 2026-10-30 (`fix/develop-fixed-oom-thread-unwrap`). **Found:** 2026-10-30. Develop battery 41000346867 on `0ce055183` failed Self-hosted tier-1 GATE 7 on `tests/cli-cases/compile-allocator-fixed-oom-shapes`:

```
< thread: died with an allocation diagnostic
> thread: died WITHOUT an allocation diagnostic: Called unwrap on a None value (at <REPO>/std/prelude.yo:8282:16)
```

## Root cause

`std/sync/channel.yo` `Channel.new`:

```yo ignore
(ptr : *T) = (*T)(malloc(capacity * size_of(T)).unwrap());
```

`malloc` here is `GlobalAllocator.malloc`, the fallible surface: it returns `.None` on failure and prints nothing. Every other std allocation on the thread-spawn path goes through a diagnosed one. The RC constructors and `__yo_thread_spawn`'s entry args use `__yo_rc_alloc` → `__yo_alloc_fail`, and `Box.new` panics with `Box.new: out of memory`. So whichever allocation exhausts the heap decides the message. The thread shape spawns threads until a 64 KiB fixed heap runs out. The spawned threads allocate and free concurrently, so the exhausting allocation varies from run to run. It is usually a 56-byte `Cond` cell, and rarely the channel's own buffer, which is `malloc(0)` at `T = unit`. That rare case is the unwrap. Measured on `0ce055183`: 1 in 300 local runs printed it. With the fix, 3 in 800 runs end in `Channel.new: out of memory` and none in an unwrap.

The defect is older than the #1665–#1677 window: `Channel.new` has not changed in that window. The window's allocation-size changes (W6a's collector-free cells, allocator v2) moved where the heap runs out, and that made the rare case frequent enough to show up in CI.

## Fix

`Channel.new` uses `.expect("Channel.new: out of memory")`. This is the prelude's convention for a constructor that runs out of memory (`Box.new: out of memory`). The fixed-heap oracle accepts the message as an allocation diagnostic.

## Test

`tests/cli-cases/compile-allocator-fixed-oom-shapes` gains a `channel` shape: `Channel(u64).new(usize(1048576))`, an 8 MiB buffer in the 64 KiB heap. It fails every run, not 1 run in 300. Before the fix it printed `channel: died WITHOUT an allocation diagnostic: Called unwrap on a None value (…)`. After the fix it prints `channel: died with an allocation diagnostic`.

The same `.unwrap()` on a fallible allocation remains at about 48 other std sites, none of them on the thread-spawn path: `issues/2026-10-30-std-io-helpers-unwrap-a-failed-malloc.md`.
