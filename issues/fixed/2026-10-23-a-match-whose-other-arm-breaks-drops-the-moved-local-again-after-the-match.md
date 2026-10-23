# A match whose other arm breaks drops the moved local again after the match

**Severity:** S1 — a double free (heap-use-after-free under ASan) on every
iteration that takes the moving arm.

**Status:** fixed (branch `fix/s1-match-break-arm-double-drop`). Found
2026-10-23 by the adversarial review of branch `fix/derive-early-return-drop`
(the break/continue exit-drop fix). The branch neither causes nor fixes it:
the emitted C is byte-identical on a develop-built binary (`6dee22187`) and on
the branch.

**Scope, as measured at the fix (develop `a368eaae0`, seed v0.2.68 alike).**
Wider than the title. Every `match` whose join reaches exactly one arm, or
whose scrutinee is known at compile time, lost the move of an arm evaluated
before the last one:

- an arm that moves, then an arm that always `break`s, `continue`s or
  `return`s (a `return` arm double-frees too, it does not leak), over a
  `bool`, `Option` or enum scrutinee, in `while` and `for` bodies;
- no loop at all: `x := match(opt, .Some(_) => take(s), .None => return(..))`
  in straight-line code drops `s` twice on the `.Some` path (a heap-use-after-
  free under ASan with `Box(String)`);
- a scrutinee that is a compile-time `::` constant, whose taken arm moves the
  value and a later arm does not: a double drop with no exit anywhere.

An integer scrutinee with a `_` arm, a move in the LAST arm, and three or more
arms with two reaching the join were already correct; the "integer matches
leak" note in an earlier draft did not reproduce. The `Option` reproducer
below also hits a second defect, a leak at the `continue` inside the nested
`cond`:
`issues/fixed/2026-10-23-an-exit-in-a-nested-branchs-other-arm-skips-the-drop-of-a-local-the-branch-moves.md`.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
take :: (fn(s : Box(String)) -> usize)(s.len());
f :: (fn(k : i32) -> usize)({
  (mut(i) : i32) = i32(0);
  (mut(acc) : usize) = usize(0);
  while(i < i32(4), {
    s := box(String.from("double-freed-on-the-move-path-xx"));
    i = (i + i32(1));
    match(
      i == k,
      false => {
        acc = (acc + take(s));
      },
      true => {
        break;
      }
    );
  });
  acc
});
main :: (fn() -> unit)({
  println(`r=${f(i32(2))}`);
});
export(main);
```

`yo compile repro.yo --optimize 2 --sanitize address --allocator system`:

```text
ERROR: AddressSanitizer: heap-use-after-free
SUMMARY: AddressSanitizer: heap-use-after-free (repro+0x1798b8)
```

The same failure with `continue` in the `true` arm, and inside a `for` body.
An `if`/`cond` of the same shape is correct (it leaked until
`issues/fixed/2026-10-23-an-exit-in-a-later-arm-than-the-move-skips-the-drop-of-the-moved-local.md`).

An `Option` scrutinee fails the same way when the moving arm itself holds a
`continue`. With a `Drop` that counts, this loop drops `f` twice on each
moving iteration and never at the `continue` (7 drops where 6 are due,
develop and branch alike):

```yo
{ println } :: import("std/fmt");
(mut(g_d) : i32) = i32(0);
Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_d = (g_d + i32(1));
    })
  )
);
take :: (fn(sink(f) : Fd) -> i32)(f.n);
some :: (fn(n : i32) -> Option(Fd))(.Some(Fd(n : n)));
cont :: (fn(k : i32) -> i32)({
  (mut(i) : i32) = i32(0);
  (mut(total) : i32) = i32(0);
  while(i < i32(3), {
    i = (i + i32(1));
    f := Fd(n : i);
    match(
      some(i),
      .Some(_) => cond(
        (i != k) => {
          total = (total + take(f));
        },
        true => {
          continue;
        }
      ),
      .None => {
        break;
      }
    );
  });
  total
});
main :: (fn() -> unit)({
  r := cont(i32(2));
  d := g_d;
  println(`${r} drops=${d} (want 4 drops=6)`);
});
export(main);
```

Its C ends the loop body with an unconditional `drop(&f)` after the match,
on the path where `take(f)` already consumed `f`, and the `continue` in the
`.Some` arm emits no drop of `f`.

## Evidence

The loop body's C, abridged:

```c
switch (cond) {
case false: { ... take(__yo_v_s); /* moves s */ ... break; }
case true:  { drop(&(__yo_v_s)); goto loop_exit; break; }
}
drop(&(__yo_v_s));   /* drops s again on the false path */
```

`s` stays in the loop body's scope-end drop list after the match: the
evaluator does not record the `false` arm's move at the join.

## Root cause (as filed)

`match` leaves every arm with any control flow out of the join
(`non_return_em`, `src/evaluator/exprs/match.yo`: `has_any_control_flow`,
so a `break` or `continue` anywhere in the arm), where `cond` leaves out only
a `return`/`unwind` arm. With one arm left, the join takes the "single
non-return body" shortcut (Cases 2/3: `env_adopt` of that arm's env) instead
of `merge_and_check_envs`; with none left, it merges nothing. Either way the
flow log had already undone the moving arm's move when the next arm started
(`reset_sibling_flow_state`), nothing restores it, and the local reads as
unmoved after the match, so it keeps its scope-end drop.

## Fix direction

Filter the join's arms as `cond` does (an arm that merely contains a
`break`/`continue` still reaches the join on its other paths), and route a
runtime scrutinee's single reaching arm through `merge_and_check_envs`
(Case 1 restores that arm's move from the flow log) rather than the
`env_adopt` shortcut. A test with a
`Drop`-counting move-only local belongs in `tests/move_only.test.yo`.

## Fix

The diagnosis above was right about the join and slightly off about which
arms leave it: `control_flow` on an arm means the arm ALWAYS leaves (an arm
that only sometimes breaks already reached the full merge and was correct).

Each arm of a `cond`/`match` is evaluated against the shared `Variable`s, and
`reset_sibling_flow_state` undoes the previous arm's moves before the next one
starts (`src/evaluator/utils.yo`). After the last arm, the variables therefore
show the state the LAST evaluated arm left. Only `merge_and_check_envs`
rebuilds each reaching arm's end state from the flow log. `evaluate_match`
took three shortcuts past it (`src/evaluator/exprs/match.yo`):

- Case 1, a compile-time scrutinee with a matched arm: `env_adopt` of that arm;
- Case 2, a compile-time scrutinee with one arm reaching the join: the same;
- Case 3, a runtime scrutinee with one arm reaching the join: the same.

Each shortcut now follows its `env_adopt` (which keeps the arm's comptime
variable values) with `merge_and_check_envs` over the arms that reach the join
(Case 1: the matched arm, unless it always leaves). The arm filter that leaves
every always-leaving arm out of the join stays: those exits get their drops
from begin.yo's exit-drop pass. A side effect corrects a diagnostic: a value
declared outside a loop and moved only in a `break` arm of a match now
reports E0907 (moved on some ways out of the loop) instead of E0901.

The join fix alone turned two correct shapes into leaks (a nested `match`
with one reaching arm inside an outer arm, whose other arm `continue`s). That
is the second defect, fixed in the same change:
`issues/fixed/2026-10-23-an-exit-in-a-nested-branchs-other-arm-skips-the-drop-of-a-local-the-branch-moves.md`.

Tests: `tests/move_only.test.yo`, "a match arm's move stands when another arm
breaks, continues or returns" (move then `break`/`continue`/`return`;
`Option` with `.None => break`; an enum with move, `break` and `continue`
arms; a `for` body; the no-loop `Option`/`return` shapes as a statement and as
a match value; a comptime scrutinee with and without a loop). Every case
counts the `Drop` runs and the sum of the dropped values, so a double drop and
a leak both fail it. The test fails on develop `54e94f11e` and passes with the
fix.

