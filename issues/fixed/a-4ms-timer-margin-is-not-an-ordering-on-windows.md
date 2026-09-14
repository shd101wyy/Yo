# A 4 ms timer margin is not an ordering on Windows

**Status:** FIXED 2026-09-12.
**Found:** 2026-09-12 by yo-d1, on `p1/yo-toml-manifest` — both Windows legs of
one run failing identically, which is what ruled out timing noise.

## Symptom

```
✗ plain arm awaits once, looping arm polls to completion
  Test failed with exit code 22
  a 1ms deadline beats the 5ms work (at .../std/assert.yo:39:17)
```

on `test (windows-latest)` AND `test (windows-11-arm)`, in
`tests/async/while_await_in_match_arm.test.yo`. macOS and every Linux leg pass.

## What the test asserted

```rust
work   := 5 ms sleep, then i32(7)
race(Some(1 ms)) spawns work and a 1 ms deadline, polls both with `yield`,
and reports 200 when the DEADLINE won, 100/101 when the WORK won.
assert(c == i32(200), "a 1ms deadline beats the 5ms work");
```

That is a 4 ms margin. Windows' default timer resolution is **15.6 ms**
(the multimedia timer period is not raised, deliberately — raising it globally
costs power, and neither Rust nor tokio does it). Both sleeps therefore come
due within one tick, `__yo_win_timer_process_due` fires every timer whose
deadline has passed in a single call, and both handles finish in the SAME loop
turn. The loop's report then reads `h.is_finished()` first and answers 100.

So the assertion is not one the platform can support at that margin. It is not
a statement about the runtime at all below ~16 ms.

## Why it surfaced when it did

It had been passing because `yield` was a 1 ms timer: that timer woke the loop
often enough, and early enough, that a turn frequently landed between the two
completions. #608 removed the timer (step 2 of
`plans/WAKER_BASED_SCHEDULING.md`), the extra wakeups went with it, and the
latent assumption showed. The regression is real — the test genuinely went from
green to red — but the defect was in the test's premise, not in the yield.

Two things hid it from #608's own CI run: that run passed windows-latest (the
ordering is a race, and it went the other way), and every develop run since
took the docs-only fast path, which SKIPS the Windows legs. "develop is green"
can mean "develop skipped 15 jobs" — worth remembering.

## Fix

Every margin in the file is now at least 25x the coarsest resolution we run on:
the work sleeps 200 ms and the deadline that must lose is 5 s. The order the
two complete in is then a property of the runtime rather than of the host's
clock, which is what the test is about. The test's real subject — a
while-with-await inside one match arm whose sibling arm also awaits — is
untouched.
