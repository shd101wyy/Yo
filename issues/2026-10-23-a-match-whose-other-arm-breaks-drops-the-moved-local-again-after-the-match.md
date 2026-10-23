# A match whose other arm breaks drops the moved local again after the match

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

## Root cause (to confirm)

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
