# An early return after an arm's move releases a value the tail also moves

**Severity:** S1 — a value moved by `own` inside a returning `if` arm is released again at that return when the function's tail moves it too: a heap use-after-free in safe code.

**Found:** 2026-10-03, next to the String S3 work. Same family as
`issues/fixed/a-move-in-a-returning-arm-is-released-again-at-the-return.md`, whose fix
covered a tail that only reads the value. **Status:** FIXED on `fix/own-arg-retain`.

## Reproducer

```rust
{ println } :: import("std/fmt");
PBox :: ref(struct(tag : i32));
sink :: (fn(own(b) : PBox) -> i32)(b.tag);
early_return :: (fn(c : bool) -> i32)({
  b := PBox(tag : i32(5));
  if(c, {
    return(sink(b));
  });
  sink(b)
});
main :: (fn() -> unit)({
  println(early_return(true));
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system -o r && ./r` (v0.2.49 and develop 60e4f7def):

```
==2573130==ERROR: AddressSanitizer: heap-use-after-free on address 0x7739eaae0010 at pc 0x5b16e202f5e5 bp 0x7719e82fec10 sp 0x7719e82fec08
READ of size 4 at 0x7739eaae0010 thread T1
...
SUMMARY: AddressSanitizer: heap-use-after-free (pbox2.bin+0x1795e4)
```

The emitted C releases `b` at the arm's return after `sink` took it:

```c
if (c) {
  int32_t t = sink(b);
  if (__yo_effect_escaped) { return (int32_t){0}; }
  __yo_decr_rc((void*)(b));      /* <- the second release */
  return t;
}
```

Any tail that moves `b` does it (`{ x := sink(b); x }`, a statement before the tail, a
`cond` instead of `if`); a tail that only reads `b` does not.

## Root cause

Two places decide what a cleanup point (an early `return`/`unwind`) releases, and only
one of them knew about moves the flow log undid.

1. Codegen's pending scope-end drops ask `_variable_moved_before_cleanup_point`
   (`src/codegen/exprs/return.yo`), which consults the variable's `UndoneMove` records
   — the fix of the earlier issue.
2. The evaluator's M3 pass (`src/evaluator/exprs/begin.yo`) handles a local that is
   NOT scope-end dropped because it is moved: it attaches an "early-return-only" drop to
   every return that precedes the variable's `consumed_at_token`. It compared positions
   only.

With a tail that only reads `b`, `b` is scope-end dropped and path 1 decides. With a tail
that moves `b`, `b` has no scope-end drop; its `consumed_at_token` is the TAIL's move
(the flow log restored the arm's move away at the join), so path 2 sees a return before
the consumption and attaches a drop — although the return's own `sink(b)` already moved
the value on that path. The `UndoneMove` record that says so was there; M3 never read it.

## Fix

The `UndoneMove` check is one predicate, `variable_moved_at_cleanup_point(v, point)`
(`src/env.yo`), asked by both deciders: M3 skips the attachment when the arm moved the
value before the return, and codegen's `_variable_moved_before_cleanup_point` calls the
same function instead of its own copy of the loop.

## Tests

`tests/type_soundness.test.yo`: "a returning arm's move is released once when the tail
moves the value too" (a keeper list holds one more reference, so a second release
disposes the box early; fails before the fix), and "a sibling arm's return still releases
the value the tail moves" (a three-way `cond`: the moving arm returns after a statement
move, a sibling arm returns without moving and must still release, and the tail moves —
each box released exactly once, so the skip does not leak).
