# A break in a later argument skips the drop of a by-value argument

**Severity:** S3 — a leak on the exit path only: in `g(s, { if(c, { break; }); 0 })`
the `break` runs before the call takes `s`, but `s` is not dropped.

**Status:** fixed 2026-10-23 (branch `fix/derive-early-return-drop`; see
[Fix](#fix)). **Found:** 2026-10-23 by the adversarial review of that branch.
Present on develop (`6dee22187`).

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
g :: (fn(s : Box(String), m : usize) -> usize)((s.len() + m));
f :: (fn(k : i32) -> usize)({
  (mut(i) : i32) = i32(0);
  (mut(acc) : usize) = usize(0);
  while(i < i32(3), {
    i = (i + i32(1));
    s := box(String.from("leaked on the break path"));
    acc = (acc + g(s, {
      if(i == k, {
        break;
      });
      usize(0)
    }));
  });
  acc
});
main :: (fn() -> unit)({
  println(f(i32(2)));
});
export(main);
```

`yo compile repro.yo --optimize 2 --sanitize address --allocator system`:

```text
develop (6dee22187):   24
                       SUMMARY: AddressSanitizer: 56 byte(s) leaked in 2 allocation(s).
fixed:                 24   (no leak)
```

## Root cause

The move of a by-value argument is recorded at the argument's own token,
which precedes a later argument in source. The exit-drop attach orders exits
by source position, so a `break` in the later argument counted as after the
move, though the call (and so the move) runs only after every argument is
evaluated.

## Fix

Walking a plain call's arguments, `_m3_consumed_for_call_arg`
(`src/evaluator/exprs/begin.yo`) treats the variable as not yet moved inside
any argument after the one that names it directly. A block's statements are
not arguments and keep their order.

**Regression test:** `tests/move_only.test.yo`, "move-only: a `break` in a
later argument than a by-value argument drops it once".
