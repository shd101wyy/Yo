# A module-level mutable binding is lost across a suspension point in an `io.async` body

**Status: OPEN.** Found 2026-09-11 while writing the keep-alive server for
`std/http`'s pool tests, where a module-level accept counter written by a
spawned server task read back as zero.

## Symptom

A module-level mutable binding (`(g_n : usize) = usize(0);`) read or written
inside an `io.async` body that SUSPENDS operates on a copy: the writes are
lost, and a later call starts from the value the global had before the body
ran. The same body with no `io.await` in it updates the real global.

## Reproducer

`issues/repros/module-global-lost-across-an-async-suspension.yo`:

```
flat, awaited:       task=2 global=2      <- correct
suspending, awaited: task=2 global=0      <- writes lost
suspending, awaited: task=2 global=0      <- and the second call restarts from 0
suspending, spawned: task=2 global=0
```

Every body is the same two increments of `g_n`; the suspending ones have an
`io.await(sleep(1ms))` between them. The task's own return value shows it saw
1 then 2, so the increments happened — against storage the caller cannot see,
and which the next call does not see either.

## Why it matters

It is silent. The testing guidance in
`.github/instructions/testing.instructions.md` recommends a module-level
counter as the in-language oracle for a leak, and that recommendation is sound
only for synchronous code: an async body that suspends makes the counter read
zero, which looks exactly like "the thing under test never happened". It cost
an afternoon of chasing a working pool that reported no accepts.

The workaround, used by `tests/http/http.test.yo`'s `_KaStats`, is to put the
counters in a `ref(struct(...))` and pass it as a parameter — reference
semantics are shared by construction. (That workaround costs a leaked
reference per call, for
`issues/a-ref-value-passed-to-an-async-future-is-never-released.md`.)

## Where to look

A suspension splits the body into state-machine states, and locals that live
across the split are moved into the future's state struct. A module-level
binding is not a local and must keep being addressed as a global; the symptom
says it is being promoted into that struct (snapshot on entry, written back
nowhere). `src/codegen/async/` — the state-field promotion decision.
