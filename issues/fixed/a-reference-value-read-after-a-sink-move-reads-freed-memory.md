# A reference value read after a `sink` move reads freed memory

**Severity:** S1 — a program that compiles reads freed memory: a variable
moved into a `sink`/`own` parameter can still be read, and the callee may
already have released the value.

**Status: FIXED (2026-10-05)** on `feat/vbd-v3-move-only`, the V3 compiler
PR. **Found** 2026-10-04 while building the move-only compiler core
(`plans/VALUES_BY_DEFAULT.md` V3, Generation A). It was first filed as open,
because the fix changes a rule an earlier fix codified (below); the
coordinator, authorized by the maintainer, decided it on 2026-10-05.

## Reproducer

```rust
{ println } :: import("std/fmt");
H :: ref(struct(n : i32));
impl(H, Dispose(
  dispose : (fn(self : Self) -> unit)({ println(`dispose ${self.n}`); })
));
take :: (fn(sink(h) : H) -> unit)({ println(`take ${h.n}`); });
main :: (fn() -> unit)({
  a := H(n : i32(1));
  take(a);
  println(`after ${a.n}`);   // accepted
});
export(main);
```

Compiled by the v0.2.52 seed or the branch's stage-1, it prints:

```text
take 1
dispose 1
after 0
```

`take` drops the last reference, so `a`'s cell is freed before the third line
reads `a.n`. The `0` is the freed allocation (`--sanitize address` is not
functional with this Mac's clang, so the printed value is the verdict here).
Passing `a` again (`take(a)`, `b := a`) is already E0901: arguments and `:=`
right sides run `require_expr_not_consumed`. Only a plain read (an identifier
in any other position, including `a.n` and `a.method()`) is unchecked.

## Root cause

A `sink` (or `own`) argument consumes the caller's variable:
`consume_argument_for_parameter` sets its `consumed_at_token`. Only two
places looked at that mark:

- `require_expr_not_consumed`, which runs for call arguments and the right
  side of `:=`;
- `set_expr_as_consumed`, at a second move.

A plain read of the name (`a.n`, `a.method()`, `a` in any other position) is
evaluated by `evaluate_identifier_and_operator`, which never consulted the
mark. So the read compiled, and codegen read the variable's C local, which
still held the pointer to the cell the callee had released.

## Fix

`evaluate_identifier_and_operator`
(`src/evaluator/exprs/identifer_and_operator.yo`) rejects a read of a consumed
user-named variable with E0901 ("use of moved value", with the move site),
for every type (`_read_after_move_is_checked`). Under
`plans/VALUES_BY_DEFAULT.md` §0 a move consumes the name. The move-only branch
had added the check for types that are not implicitly copyable; this fix
drops that type gate. Exempt are the move site itself (a call node is
re-evaluated as an enclosing call's argument), compiler temps and generated
code (their consumed mark is ownership bookkeeping), and reads in a sibling
arm or a later loop iteration (the flow log restores those states). A copy
the dup/drop pair optimizer turns into a move (`(cur : T) = t` with `t` read
later) is marked after the block is evaluated, so it is not a user move and
its reads stay legal.

Measured before landing: `yo check ./src` reported 0 errors, and 308 of the
309 language test files passed. The one file was
`tests/async/sm_ownership.test.yo`, whose `_move_each_iteration` read `t.n`
after `_keep_thing(t)`. It now reads before the move, and the cli-case
`read-after-sink-move-in-a-task-is-e0901` expects E0901 for the read after the
move inside a task. That read was the rule `issues/fixed/a-local-read-after-it-moves-inside-a-task-reads-an-emptied-slot.md`
had kept ("the name may still read it while the new owner holds it"), and
that note is superseded for a `sink` move (see the dated note there).

## Tests

- `tests/type_soundness.test.yo`, "soundness: a read after a sink move is
  E0901": the reproducer's shape. It fails under a stage-1 built before the
  fix (the `comptime_expect_error` sees no error) and passes after.
- `tests/cli-cases/read-after-sink-move-in-a-task-is-e0901`: the same read
  inside an `io.async` body. `comptime_expect_error` observes only the body's
  definition-time wrapper there, so this is a `check` cli-case. A stage-1
  built before the fix reports the fixture `evaluator OK`.

The read error is raised through the flow-violation channel
(`raise_flow_violation`), so a closure or `io.async` body that a
definition-time trial evaluates re-raises it at `check` instead of
swallowing it into an abort stub.
