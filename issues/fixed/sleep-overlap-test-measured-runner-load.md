# The async-sleep overlap test measured runner load, not overlap

**Found**: 2026-08-28 — `test (macos-latest)` failed on `develop@b8a24016e` (the
`SEED_VERSION` bump), the only red leg in an otherwise 23-green run. **Fixed**:
same day, by proving the property structurally instead of by wall clock.

## Symptom

```
✗ sleep suspends the task instead of blocking the loop
    overlapped sleeps took 350 ms (order=11)
    the two sleeps must overlap
```

The same test on the same run, on `ubuntu-latest`:

```
  overlapped sleeps took 200 ms (order=11)
```

The macOS runner was ~3× slow on timers that run — its own sibling line reads
`sleep(60ms) took 198 ms`, against `60 ms` on ubuntu. So a 200 ms timer plus a
20 ms timer measuring 350 ms is the box, not the scheduler: `order=11` was
identical on both legs.

## Why the assertion could not work

`tests/time/sleep.test.yo` spawned a 200 ms sleeper and a 20 ms sleeper and
asserted `elapsed.as_millis() < 350`, with the comment "serialized (blocking)
sleeps would need >= 220ms plus scheduling slop".

That is the whole problem. The two outcomes it had to separate are:

| execution | elapsed |
| --- | --- |
| overlapped | ~200 ms (the longer sleep) |
| serialized, fast first | ~220 ms (20 + 200) |

**20 ms of discriminating power**, which is far below ordinary jitter on a shared
runner. And the accompanying `order == 11` check does not close the gap: with
`fast` running first, `order` reaches 11 through a fully SERIAL execution too
(fast sleeps, sees `order == 0`, adds 1; slow then sleeps and adds 10). So the
test was simultaneously flaky (fails on a slow box that is behaving correctly)
and weak (a serial fast-then-slow implementation passes it whenever the box is
quick).

## Fix

Prove the overlap with the marks themselves, so no clock is involved. The slow
task now marks `order` BEFORE its sleep as well as after:

```rust
slow: order += 100;  await sleep(200ms);  order += 10
fast:                await sleep(20ms);   assert(order == 100);  order += 1
```

`order == 100` at the fast task's check means the slow task had *started* and had
*not finished* — that is overlap, at any timer speed. The three outcomes are now
distinguishable by value: `0` (slow never started — serial, fast first), `110`
(slow finished first — serial, slow first), `100` (overlap). The final assertion
is `order == 111`.

Wall clock is demoted to a hang guard (`< 2000 ms`), matching what the sibling
`sleep_blocking` and `sleep` tests in the same file already use.

## Verification

- Passes locally with `order=111`, twice, at 201 ms and 209 ms.
- **Catches serialization**: removing the two `io.spawn` calls so the awaits run
  the tasks in sequence makes it fail with `fast task must finish while the slow
  one sleeps`. The old wall-clock assertion could not have caught that at all on
  a fast machine — 220 ms passes a `< 350 ms` bound.

## Rule this is an instance of

A timing assertion whose two branches differ by less than the platform's jitter
is not a test, it is a coin flip — and it fails on the slow, correct machine
rather than on the wrong implementation. Where a concurrency property can be
observed through shared state, observe it there and keep wall clock for
"did not hang".
