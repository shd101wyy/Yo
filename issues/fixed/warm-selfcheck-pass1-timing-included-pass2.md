# `--warm-selfcheck`'s "pass1" duration was measured after pass2 finished

**Status:** FIXED 2026-09-22. Surfaced by the new unused-variable warnings
channel (ERROR_DIAGNOSTICS_OVERHAUL.md P4 / D15): `t0` was flagged as an
initialized local nothing ever read, which made the actual measurement look.

## Symptom

`yo compile <file> --warm-selfcheck` printed

```
warm-selfcheck: pass1=<N>ms pass2=<M>ms identical=...
```

where `pass1` was not pass1's duration.

## Root cause

```rust
t0 := Instant.now();
run_compile(argv_a, io, exn);
t1 := Instant.now();
run_compile(argv_b, io, exn);
t2 := Instant.now();
...
eprintln(`warm-selfcheck: pass1=${t1.elapsed()...}ms pass2=${t2.elapsed()...}ms ...`);
```

`Instant.elapsed()` is evaluated when the template interpolates it — AFTER
pass2 and the identical-bytes comparison — so `t1.elapsed()` reported
pass1+pass2+compare, and `t2.elapsed()` reported only the compare. Neither
number was what its label claimed.

## Fix

Capture each duration at its boundary: `pass1_ms := t0.elapsed()` right after
pass1 returns, `pass2_ms := t1.elapsed()` right after pass2 returns; the
print uses the captured strings and the now-pointless `t2` disappears. The
printed format is unchanged, so any harness normalizing durations
(`<TIME>`-style rewrites) keeps matching; only the values became truthful.

## Verification note

The failure is a timing SEMANTIC, not an output shape, so no automated test
can fail before and pass after (the golden formatters deliberately erase
durations). The regression net is the lint itself: the old shape left `t0`
unread and would be flagged again the moment the capture moved away from the
boundary.
