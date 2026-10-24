# An `Arena.deinit` panic reports `std/assert.yo:39:17`, not the caller's line

**Severity:** S3 — every panic raised through std's `panic`/`assert` names the same line inside `std/assert.yo`, so the message never points at the call that failed; the program still aborts with the right message.

**Status:** open. Found 2026-10-24 while writing the undefined-behavior table of
`plans/backlog/ALLOCATOR_PLACEMENT.md` (§4: an arena deinit under a live block is a defined panic).

## Repro

`issues/repros/2026-10-24-arena-deinit-panic-reports-the-assert-site.yo`: an `ArrayList` placed in an arena, then
`arena.deinit()` while the list is live.

```
$ yo compile issues/repros/2026-10-24-arena-deinit-panic-reports-the-assert-site.yo -o a.out && ./a.out
Arena.deinit: 1 block(s) still live (32 of 65536 bytes in use) (at file:///home/<user>/.local/lib/yo/v0.2.69/std/assert.yo:39:17)
$ echo $?
134
```

Measured 2026-10-24 with the installed v0.2.69 and again with `--std-path ./std` on develop `48b8e93a1` (the path
becomes the checkout's `std/assert.yo:39:17`). The caller's site is line 9 of the repro. A plain
`assert((n == i32(4)), "n is not four")` in `main` prints `n is not four (at …/std/assert.yo:39:17)` too, and two
open issue logs quote the same location for unrelated test failures
(`issues/windows-1ms-deadline-race-loses-since-cancellation-landing.md`,
`issues/2026-10-20-the-mutex-fifo-across-loops-test-sees-a-wrong-waiter-count-one-run-in-a-few.md`).

## Root cause

`generate_panic` (`src/codegen/exprs/panic.yo:26`) bakes the location of the `__yo_panic` call's own token into
the message: `ploc` (line 50) for a literal message, `rloc` (line 79) for a run-time one, the branch std's
`panic` takes. std's `panic` (`std/assert.yo:32-42`) builds its message at run time and
calls `__yo_panic` from one line (`.Some(p) => __yo_panic(p)`, line 39), so every caller of `panic` gets that
line baked in. `std/arena.yo:487` (`Arena.deinit`), `assert`, and the other std modules that import `panic`
(`std/async/index.yo`, `std/time/datetime.yo`, `std/time/instant.yo`) all inherit it.

## Fix direction

The caller's location has to reach `panic` as a value. That is `source_location()`: `ZIG_ADOPTION_CANDIDATES.md`
Z4, owned by `plans/backlog/COMPTIME_METAPROGRAMMING_AUDIT.md` C6, whose defaulted
`loc : SourceLocation = source_location()` parameter is folded at the call site. `panic` and `assert` take that
parameter and print it instead of their own line. A narrower interim, marking `panic`/`assert` so codegen bakes
the caller's token (Rust's `#[track_caller]`), needs the same plumbing for nested callers (`Arena.deinit` calls
`panic`, and its user calls `deinit`), so Z4 is the fix rather than a special case.

## Test

When fixed: a cli-case runs the repro, and its golden expects `(at <repro>:9:3)` once `Arena.deinit` forwards
its own caller's `loc` (with only `panic` taking `loc`, the line would be `std/arena.yo:487`, which is already
better than today); a second case expects `assert`'s caller line in a user file. Both fail today.
