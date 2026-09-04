# Every float literal was "normalized" through `%g` — six significant digits, silently

**Status: FIXED 2026-08-27.** Found writing `std/rand`'s `next_f64` test: a
comparison window `f >= 0.6303102 && f < 0.6303103` failed because BOTH
bounds parsed to the same value.

## Symptom

```rust
(a : f64) = 0.6303102;
(b : f64) = 0.6303103;
a < b            // FALSE — comptime-folded AND runtime alike
```

The emitted C for both literals was `0.63031`. Every float constant in every
Yo program lost everything past the 6th significant digit — silently: no
diagnostic, and small examples (1.5, 3.14) round-trip fine, so nothing
noticed since the port.

## Mechanism

`evaluate_float_literal` (`src/evaluator/values/float.yo`) "normalizes" the
source token: `parsed := parse_raw_float(tok.value)` (full-precision `atof`)
then `raw := parsed.to_string()` — and f64 `ToString` is C **`%g`**, which
prints SIX significant digits. The TS original normalized through JS
`Number.toString()`, which is shortest-round-trip — the `%g` substitution
was a silent mis-port. `make_float_val`
(`src/evaluator/builtins/comptime_numeric_fns.yo`) had the same hole for
COMPUTED comptime floats.

## Fix

`f64_raw_roundtrip` (`src/evaluator/utils.yo`): render FloatLit raws with
`%.17g` — the shortest width guaranteed to round-trip every IEEE double —
used by both the literal evaluator and `make_float_val`. Display formatting
(`println`, `${x}`) is untouched: it still goes through std's `%g`
`ToString`; only the compiler's internal value carrier changed.

## Verification

- The two-literal reproducer compares correctly at comptime AND runtime, and
  the emitted C carries `0.6303102`/`0.6303103`.
- `tests/rand.test.yo`'s `next_f64` window test (the discovery site) passes.
- Full battery on the branch.
