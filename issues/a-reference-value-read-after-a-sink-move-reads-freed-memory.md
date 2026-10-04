# A reference value read after a `sink` move reads freed memory

**Severity:** S1 — a program that compiles reads freed memory: a variable
moved into a `sink`/`own` parameter can still be read, and the callee may
already have released the value.

**Found** 2026-10-04 while building the move-only compiler core
(`plans/VALUES_BY_DEFAULT.md` V3, Generation A). **Open by decision**: the
general fix changes a rule an earlier fix codified (below), so it waits for
the maintainer's verdict.

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

## Why it is not fixed with the move-only rule

The move-only branch rejects a read after a move in
`evaluate_identifier_and_operator`
(`src/evaluator/exprs/identifer_and_operator.yo`,
`_read_after_move_is_checked`). That check is gated on
`type_requires_explicit_copy`, which today holds only for move-only types.
Measured with the gate dropped (every user-named variable checked, a
temporary debug switch since removed):

- `yo check ./src`: 0 errors;
- the language suite, file by file (309 files): 308 pass;
- `tests/async/sm_ownership.test.yo` fails: `_move_each_iteration` reads
  `t.n` after `_keep_thing(t)` moved `t` into a list that keeps it alive.
  That test guards
  `issues/fixed/a-local-read-after-it-moves-inside-a-task-reads-an-emptied-slot.md`,
  whose fix codified "the name may still read it while the new owner holds
  it" and built the task-slot move flag around it.
- `yo check ./std` was not measured with the gate dropped.

So the general rule contradicts a documented, tested behavior. That behavior
is unsound in general (the new owner may drop the value, as `take` does
above), but changing it is the maintainer's call.

## Recommendation

Make the read check unconditional for user-named variables, and adapt
`_move_each_iteration` to read `t.n` before `_keep_thing(t)`. The values-by-
default amendment's explicit-copy kind (a value owning a buffer: `String`, the
collections) already gets the check when `type_requires_explicit_copy` widens
to it. What would remain open are reference handles (`ref(struct)`, `Box`,
`Arc`) moved into a `sink` parameter, which this reproducer is. Land it in the
PR that widens the predicate, after `yo check ./std` runs clean with it. The
test that fails before the fix is the reproducer above, as a
`comptime_expect_error(a.n, "use of moved value")` after `take(a)` in
`tests/type_soundness.test.yo`.
