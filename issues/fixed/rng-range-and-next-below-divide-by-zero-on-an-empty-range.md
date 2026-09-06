# `Rng.range(x, x)` and `Rng.next_below(0)` divided by zero

**Status: FIXED** (2026-09-06, `std/rand.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 11.

## Symptom

`Rng.range(low, high)` computed `next_below(u64(high - low))`, and
`next_below` began with `threshold := (u64(0) - bound) % bound`. For an empty
range (`high == low`) or `bound == 0` that is `% 0`:

| platform | result |
| --- | --- |
| x86-64 | SIGFPE — the process dies with no message |
| arm64 | `udiv` by zero yields 0 and the call *returns a number* — measured: `range(3, 3)` → `0`, `next_below(0)` → `0` |

The same program was a crash on one CI leg and a wrong answer on another,
which is the worst shape a bug can take. An inverted range was wrong on both:
`range(5, 1)` returned `-1864718553421689963`. The doc comment on `range` said
"Panics via wrap if `high <= low`" — it did not panic, and `high < low` did not
wrap into a panic either: `u64(high - low)` is a huge span and the call
returned a value far outside the range.

## Fix

Both entry points check their precondition and panic with a message naming
the call, like Rust's `gen_range` on an empty range:

```
Rng.range: empty range (high <= low) (at file:///…/std/rand.yo:87:24)
Rng.next_below: bound must be non-zero (at file:///…/std/rand.yo:70:24)
```

(`__yo_panic` prints the message plus its source location and aborts — rc 134.)

## Regression tests

- `tests/rand.test.yo` — "one-element ranges are the safe edge": `range(x,
  x+1)` and `next_below(1)` — the legal boundary next to the panic — must keep
  working and not rejection-sample forever.
- `tests/cli-cases/rand-empty-range-panics` — the panic itself: a `build run`
  program that calls `range(3, 3)` must exit non-zero with the diagnostic on
  stderr (a `.test.yo` cannot assert a process-killing panic; the cli-case
  harness scores rc + the kept stdout substring).
