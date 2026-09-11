# `std/sys/signals.yo` gives Linux signal numbers on macOS for `SIGBUS`, `SIGURG`, `SIGUSR1`, `SIGUSR2`

**Status:** open. Found while writing doc comments for `std/sys/signals.yo`
(std `///` doc sweep, 2026-09-11). **Filed, not fixed** — the sweep it was found
in is documentation-only.

## The claim vs the code

`std/sys/signals.yo`'s header said "Platform-aware signal numbers. Uses
`process.platform` for values that differ between Linux and macOS." Four
constants do branch (`SIGCHLD`, `SIGCONT`, `SIGSTOP`, `SIGTSTP`). **Four more
differ on macOS and do not branch**, so they carry the Linux number on every
platform:

| constant | in `std/sys/signals.yo` | macOS `<sys/signal.h>` | what the Yo value actually is on macOS |
| --- | --- | --- | --- |
| `SIGBUS`  | 7  | **10** | 7 = `SIGEMT` |
| `SIGURG`  | 23 | **16** | 23 = `SIGIO` |
| `SIGUSR1` | 10 | **30** | 10 = `SIGBUS` — **crashes the target** |
| `SIGUSR2` | 12 | **31** | 12 = `SIGSYS` — **kills the target** |

The other 23 entries are correct on both platforms (1-15 agree apart from
`SIGBUS`; 21-28 happen to agree; the four `cond`-ed ones are right).

## Reproducer

`issues/repros/sys-signals-macos-numbers-are-linux-values.yo`

```
yo compile issues/repros/sys-signals-macos-numbers-are-linux-values.yo \
  --std-path ./std --optimize 2 -o /tmp/sigrepro && /tmp/sigrepro
```

Observed on `aarch64-apple-darwin` (2026-09-11), verbatim:

```
SIGBUS = 7 (macOS <sys/signal.h>: 10, 7 is SIGEMT)
SIGURG = 23 (macOS <sys/signal.h>: 16, 23 is SIGIO)
SIGUSR1 = 10 (macOS <sys/signal.h>: 30, 10 is SIGBUS)
SIGUSR2 = 12 (macOS <sys/signal.h>: 31, 12 is SIGSYS)
```

Header values confirmed against
`$(xcrun --show-sdk-path)/usr/include/sys/signal.h` (MacOSX14.4.sdk).

## Root cause

`std/sys/signals.yo` was written as a flat table of Linux numbers with a
`cond(platform == Platform.Macos)` added only for the four job-control signals
that a Linux/macOS diff makes obvious (`SIGCHLD`/`SIGCONT`/`SIGSTOP`/`SIGTSTP`,
17-20 in both, permuted). The 4.4BSD renumbering also moved `SIGBUS` down into
the 1-15 block and pushed `SIGUSR1`/`SIGUSR2` to the top of the table, and
`SIGURG` sits at 16 on BSD where Linux has it at 23 — none of which the original
diff caught.

**`std/signal.yo` already has this right and does not use this module.** Its
`_signal_num` carries an independent table with `.User1 => 30` / `.User2 => 31`
on macOS, so nothing in the public API is affected; the wrong values are reached
only by importing `std/sys/signals` directly.

## Why no test caught it

`tests/sys/signal.test.yo` imports `SIGUSR1` from `std/sys/signals` and both
registers the handler and raises the signal through that same constant, so the
test is self-consistently wrong: on macOS it installs a handler for signal 10
(`SIGBUS`) and raises signal 10, and passes. A test that asserted the NUMBER, or
that raised through `std/signal.yo`'s enum and caught through `std/sys/signals`,
would have failed.

## Fix

`cond` the four values on `platform` the way the neighbouring four already are
(macOS: `SIGBUS` 10, `SIGURG` 16, `SIGUSR1` 30, `SIGUSR2` 31), and add a test
that asserts the numbers per platform rather than round-tripping one constant
through itself. `std/signal.yo`'s `_signal_num` should then be able to read this
module instead of duplicating the table — that de-duplication is the real prize,
and is why the fix wants a test that pins both tables to the same numbers.

Note the doc comments added in the doc sweep flag all four values as wrong at
their definitions; those warnings should be deleted by the fix.
