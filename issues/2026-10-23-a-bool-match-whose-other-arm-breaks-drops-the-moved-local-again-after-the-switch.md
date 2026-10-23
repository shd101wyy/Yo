# A bool match whose other arm breaks drops the moved local again after the switch

**Severity:** S1 — a double free (heap-use-after-free under ASan) on every
iteration that takes the moving arm.

**Status:** open. Found 2026-10-23 by the adversarial review of branch
`fix/derive-early-return-drop` (the break/continue exit-drop fix). The branch
neither causes nor fixes it: the emitted C is byte-identical on a
develop-built binary (`6dee22187`) and on the branch.

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
      (i == k),
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
An `if`/`cond` of the same shape does not double-free (it leaks instead:
`issues/fixed/2026-10-23-an-exit-in-a-later-arm-than-the-move-skips-the-drop-of-the-moved-local.md`).
An `Option` or integer scrutinee in the same shape does not double-free.

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

## Root cause (to confirm)

`match` leaves a `break`/`continue` arm out of the join
(`non_return_em`, `src/evaluator/exprs/match.yo`), as `cond` leaves out a
`return`/`unwind` arm. With one arm left, the join takes the "single
non-return body" shortcut (Cases 2/3: `env_adopt` of that arm's env) instead
of `merge_and_check_envs`. The flow log had already undone the `false` arm's
move when the `true` arm started (`reset_sibling_flow_state`), so the shortcut
never restores it and `s` reads as unmoved after the match. Why the
`Option`/integer scrutinee does not take the same path is not yet known.

## Fix direction

Route a runtime scrutinee's single reaching arm through
`merge_and_check_envs` (Case 1 restores that arm's move from the flow log),
or restore the reaching arm's moves before the shortcut. A test with a
`Drop`-counting move-only local belongs in `tests/move_only.test.yo`.
