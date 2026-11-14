# The join's kill precision ends an entry at a reassignment that an exit skips

**Severity:** S1. A holder that stores a reference to an inner-block local and is reassigned back later in that
block is accepted even when a `break` (or `continue`, `return`) between the two leaves the block with the
inner reference still stored: the read after the loop is a stack-use-after-scope. Pre-existing since the
kill precision landed (`issues/fixed/2026-11-09-a-drop-holder-re-pointed-at-an-inner-block-root-and-back-is-rejected.md`).

Found 2026-11-12 by the `flow` lane (P1, re-point widening) while reading `_lb_join_root_end`. Reproduced on
develop `ece5e5cfd` (the `reprobe` tree binary at `4f8f975b3`).

## Reproducer

`tests/origins/unsound/c4-kill-across-break.yo` (negative, expects E0911):

```yo
main :: (fn() -> unit)({
  x := String.from("outer string that is long enough to live on the heap");
  mut(h) := Option(&String).Some(&x);
  mut(i) := i32(0);
  while(i < i32(3), {
    y := String.from("inner string that is long enough to live on the heap");
    h = .Some(&y);
    if(i == i32(1), {
      break;
    });
    h = .Some(&x);
    i = (i + i32(1));
  });
  match(h, .Some(r) => println(`OUT: ${r.*}`), .None => ());
});
```

```text
$ yo check c4-kill-across-break.yo          # accepted
$ yo compile c4-kill-across-break.yo --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: stack-use-after-scope … READ of size 24
```

Positive control: `tests/origins/unsound/c4-kill-across-break-pos.yo` (the `break` after the reassignment).

## Root cause

`_lb_join_root_end` (`src/evaluator/utils.yo`) serves §7's scope check in `bind_join_roots_for`: when the
stored root's block ends before the holder's live range does, the entry is taken to end at the next
statement of the root's block that reassigns the whole holder (`h = …`). It scans the block's statements
after the root's binding for that reassignment and never asks whether every path from the store reaches
it. A `break`, `continue` or `return` between the store and the reassignment is such a path: it leaves
the block with the entry live, the root is dropped at the block's end, and the holder is read after.

## Expected

E0911 at `h = .Some(&y)`, as without the reassignment: "`y`'s scope ends with its block, while `h` is live
to its last use". The shortening is sound only when no statement between the store and the reassignment
can leave the block (BCC §3: a kill is a strong update on the paths through it, and an exit is a path
that skips it).

## Fix

Fixed by the cluster-4 branch `fix/c4-flow-join`. `_lb_join_root_end` (`src/evaluator/utils.yo`) keeps the block's end as the entry's end when any statement from the store up to the reassignment may leave the block (`_lb_may_exit`: a `break`, `continue`, `return` or `unwind` anywhere inside it, conservatively), so §7's scope check sees the path that skips the reassignment. The flow join counts exits the same way: an entry GENed before an exit is not removed by a KILL after it.

## Test

`tests/origins/unsound/c4-kill-across-break.yo` (E0911) and `c4-kill-across-break-pos.yo` (accept), G-B.
