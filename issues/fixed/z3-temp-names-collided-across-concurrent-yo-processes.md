# Z3 temp files collided across concurrent yo processes (`yo-verify-<n>.<ext>`)

> Found 2026-09-10 while investigating
> `issues/emitted-c-flipped-once-under-extreme-load-unexplained.md` (it turned
> out NOT to be that issue's cause — no Z3 was installed there — but the
> hazard is real and latent wherever a solver IS installed). **FIXED same
> day.**

## The hazard

`_z3_temp_path` (`src/verifier/z3.yo`) minted temp names from a per-process
counter only: `<tmp>/yo-verify-<n>.smt2` / `.out`. The system temp dir is
SHARED, so two concurrent yo processes that both run solver queries — e.g. a
test-suite's batch compiles racing a parallel `yo verify`, or any two
`yo verify` invocations — start at the same counter values and write the
same names:

- process B's script write can land between process A's write and A's
  `z3 <script>` invocation, so A proves B's obligations;
- process B's `.out` write can land between A's z3 run and A's read, so A
  scores B's verdict.

Wrong verdicts mean wrong verify+ strips and silently different compiled
output — nondeterministic corruption, not a crash.

## Fix

`_z3_temp_path` now embeds a per-process prefix — the monotonic clock at
nanosecond resolution, captured lazily once per process — so names are
`<tmp>/yo-verify-<start-nanos>-<n>.<ext>`: unique per process AND per query.
Temp names never reach emitted C, so wall-clock seeding there does not
affect compile determinism. (A PID would also work but has no portable
libc binding here: `std/libc/unistd`'s `getpid` would need a Windows
`_getpid` rename.)

## Verification

Uniqueness is by construction (two processes cannot share a nanosecond
start-time prefix; the counter disambiguates within a process). Four
concurrent `yo check` runs over a `Pragma.VerifyOrAssert` fixture all succeed
with the change (this box has no solver installed, so that exercises the
compile path, not the solver loop); the CI "Formal verification (pinned Z3)"
leg runs the real solver queries end-to-end.
