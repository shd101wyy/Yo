# A move in one `cond` arm is reported at the other arm

**Severity:** S3 — E0901's "value moved here" note for a value moved inside one
arm of a `cond` points at a different arm that never touches the value. The
reader then looks for the move in the wrong place.

**Status:** open. **Found:** 2026-10-22 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). Under the flip,
`std/cli/arg_parser.yo` reports `use of moved value: current_arg` and puts the
move note at line 645, `.None => ()`, while the move is at line 631,
`parsed._subcommand = .Some(current_arg)`. The v0.2.68 seed and develop
`e30c0d8ed` behave the same.

## Reproducer

`issues/repros/2026-10-22-a-move-in-one-cond-arm-is-reported-at-the-other-arm.yo`
(a move-only `B`, moved into `slot` on one path and again behind a flag):

```text
error[E0901]: use of moved value: `x`
   --> ...:28:20
28 |       slot = .Some(x);
note: value moved here
   --> ...:21:17
21 |         true => ()
```

The move is at line 18 (`slot = .Some(x);` in the `(v > i32(2))` arm). The
error itself is correct: the flow join merges a moved and an unmoved path.

## Root cause (hypothesis)

At the join, the merged "moved" state seems to record the token of the last
arm walked, or of the join itself, rather than the token of the arm that
moved. `variable_move_note` (`src/env.yo`) then reads that token back.

## Fix direction

When the join merges a moved state from arm A with an unmoved state from arm
B, keep arm A's move token. A cli-case or `comptime_expect_error` test can pin
the note's line.
