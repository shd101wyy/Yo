# An owning `JoinHandle` costs one heap allocation per `io.spawn`

**Severity:** S3 — about 550 extra instructions per spawn of a leaf future (691 → 1239 with 100k live handles); no wrong result

**Status: OPEN.** Found 2026-09-29 while measuring phase 3 of `plans/ASYNC_STATE_MACHINE_GENERATION.md` (the phase 2/3 PR).

## Symptom

Callgrind instructions per operation, from the audit's benchmark (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.4, n=100000 minus n=0). "Before" is the v0.2.45 seed; "after" is the phase 2/3 branch.

| Mode | Before | After |
|---|---|---|
| `spawn`: spawn 100k no-await leaves into an `ArrayList(JoinHandle(i32))`, then await each | 691 | 1239 |
| `spawn_sm`: the same with one-await state machines | 1718 | 1638 |

Half of the `spawn` profile is glibc `malloc`/`free`, on its slow path (`_int_malloc`, `malloc_consolidate`) because 100k handles are live at once.

## Cause

Phase 2 made `JoinHandle(T)` a `ref(struct(__future : *(T)))` so that it owns a reference to the future. That fixed the statement-level spawn leak (`issues/fixed/statement-level-io-spawn-leaks-the-state-machine.md`). But the handle is now a second heap object per spawn, a 16-byte box around the future pointer, with its own RC header and its own `Dispose`.

## Fix direction

The future is already reference-counted, so the handle does not need a box of its own: it can BE a counted reference to the future. Dup is then `__yo_incr_rc(fut)` and drop is `__yo_decr_rc(fut)`, with no allocation. That needs a prelude type whose values are a foreign RC pointer:

- either an opaque RC handle type the codegen dups and drops with the future's header;
- or a `newtype` over the erased future interface.

This belongs with phase 7 (allocation per await). Regression test: the `spawn` row back at or below 691 instructions, with the statement-level spawn test in `tests/async/sm_protocol.test.yo` still passing.

## Design, and why it waits (2026-09-29, phase 7)

- **The design.** Since #1008 a struct field can hold an `Impl(Future(T, E))`
  (the erased future interface, upcast at every store). The handle is then a
  VALUE struct whose one field is the counted future, and the value-struct
  RC code does the rest:
  - a dup is the future's `__yo_incr_rc`;
  - a drop is its `__yo_decr_rc`;
  - detach on drop is the drop itself, because the running task holds its
    own reference.

  There is no box and no second header.
- **Why it waits.** It is the same change as step 2 of
  `issues/fixed/join-handle-ownership-waits-for-the-seed.md`. The seed lowers
  `io.spawn` and `JoinHandle.await` with its own codegen, which hard-codes
  today's value handle: `.__future = (void*)…` at the spawn, and a release
  after reading the result. With a counted field it would release the
  future twice. So this lands with that seed bump, in the same PR.
- **Measured today**, with the seed-safe value handle, which has no box and
  also no ownership: `spawn` is 666 instructions per op, and `spawn_sm` 987
  on the phase 6 branch.
