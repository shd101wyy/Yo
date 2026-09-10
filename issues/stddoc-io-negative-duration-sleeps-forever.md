# A negative `Duration` makes `sleep` / `sleep_blocking` wait ~585 million years

**Found:** 2026-09-11, during the `std/` `///` documentation sweep (docs-only PR;
this is filed, not fixed).
**Files:** `std/time/sleep.yo:59`, `std/time/sleep.yo:68`, `std/time/duration.yo:53-76`

## Behaviour, verbatim

Reproducer: `issues/repros/stddoc-io-negative-duration-sleeps-forever.yo`

```
$ yo compile issues/repros/stddoc-io-negative-duration-sleeps-forever.yo \
    --std-path ./std --optimize 2 -o /tmp/negdur && /tmp/negdur
as_millis=-1000
u64 ms=18446744073709550616
usize ms=18446744073709550616
```

`18446744073709550616` ms is ≈ 5.85 × 10^8 years. With the `sleep_blocking(d)`
line uncommented the process hangs instead of returning.

## Root cause

`std/time/duration.yo`'s `Duration` is **signed** — `struct(secs : i64, nanos :
i64)` — and none of the four integer constructors clamps:

```rust
from_secs   : (fn(secs : i64) -> Self)(Self(secs : secs, nanos : i64(0))),
from_millis : (fn(millis : i64) -> Self)(...),
from_micros : (fn(micros : i64) -> Self)(...),
from_nanos  : (fn(nanos : i64) -> Self)(...),
```

so `Duration.from_secs(i64(-1))` is an ordinary, safe, non-`unsafe` call that
yields `secs = -1`, and `as_millis()` returns `-1000`.

Both sleep forms then cast that signed count to an **unsigned** type with no
range check (`std/time/sleep.yo`):

```rust
sleep :: (fn(duration : Duration, io : Io) -> Impl(Future(unit)))({
  ms := u64(duration.as_millis());          // (uint64_t)(-1000) == 1.8e19
  io.async((io : Io) => { io.await(IO_timer.sleep(ms), io); return(()); })
});
sleep_blocking :: (fn(duration : Duration) -> unit)(
  __yo_ms_sleep(usize(duration.as_millis()))   // same wrap
);
```

The cast is C's `(uint64_t)` reinterpretation of a negative two's-complement
value, so "wait for less than no time" becomes "wait essentially forever" —
the worst possible failure direction for a timeout.

Rust cannot express this bug: `std::time::Duration` is `(u64, u32)` and
`Duration::from_secs` takes a `u64`, so a negative span is unrepresentable.
Yo's signed representation is what opens the hole, and the module is
inconsistent about it — `Duration.from_secs_f64` *does* clamp a negative input
to zero and `Duration.sub` saturates at zero, both of which document
themselves as "a Duration is a non-negative span", while the four integer
constructors happily build one that is not.

## Blast radius

Anything that computes a span by subtraction in the wrong order, or from a
signed difference:

```rust
d := Duration.from_secs(deadline - now);   // negative once the deadline passes
io.await(sleep(d, io), io);                // hangs instead of firing immediately
```

`timeout` (`std/async`) and `Interval.tick` are not affected today, because
`Instant.duration_since` clamps at zero and `SystemTime.duration_since`
returns a `Result` — std never *produces* a negative `Duration` internally. It
is caller-constructed spans that reach the hole.

## Fix options (for the maintainer to choose — see D-decision note below)

1. **Follow Rust: make `Duration` unsigned.** `secs : u64, nanos : u32`, the
   constructors take unsigned, and the bug is unrepresentable. Breaking, and it
   forces every `i64` call site (`Duration.from_millis(i64(100))` is the
   spelling used throughout `std/` and `tests/`) to change.
2. **Keep it signed and make the clamp uniform.** The four integer
   constructors clamp negatives to zero, exactly as `from_secs_f64` already
   does — smallest change, keeps every call site, and makes the
   "non-negative span" claim in `from_secs_f64`'s doc true for the whole type.
3. **Clamp at the sleep boundary only.** `ms := u64(max(as_millis(), 0))` in
   both sleep forms. Fixes the hang but leaves negative `Duration`s flowing
   through the rest of the API (`as_nanos`, `Ord`, `to_string`).

Option 2 or 1 is the real fix; option 3 alone would leave the same trap for the
next unsigned consumer. This is the "signedness" open question named in
`std/time/duration.yo`'s new `## Stability` section, and it belongs in the
`plans/STD_API_STABILIZATION.md` decision list.

## Test to add with the fix

`tests/time/sleep.test.yo` — a `sleep_blocking(Duration.from_secs(i64(-1)))`
bounded by an `Instant.elapsed()` assertion (it must return in well under a
second), plus a `tests/time/duration.test.yo` case pinning whichever of the
three shapes is chosen.
