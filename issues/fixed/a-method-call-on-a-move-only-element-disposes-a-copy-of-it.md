# A method call on a move-only element disposes a copy of it

**Severity:** S1 — `xs(i).m()` on a move-only element (a `Dispose` type) ran its `dispose` while the list still owned the element, so the list disposed it a second time; with a `JoinHandle` element the task was released twice and the program crashed at exit

**Status:** FIXED 2026-10-12 (feat/vbd-v3-genb, §3.13 A3 Generation B).

## Symptom

Found while switching `JoinHandle(T)` to a move-only value struct
(`plans/VALUES_BY_DEFAULT.md` §3.13 A3). Reproduced with the released v0.2.59
seed and no async code at all:

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
Tok :: struct(id : i32);
impl(Tok, Dispose(dispose : (fn(self : &Self) -> unit)(println(`dispose ${self.id}`))));
impl(Tok, get : (fn(self : &Self) -> i32)({ println(`get`); self.id }));
main :: (fn() -> unit)({
  l := ArrayList(Tok).new();
  l.push(Tok(id : i32(1)));
  _b := l(usize(0)).get();
  println(`got ${_b}`);
});
export(main);
```

printed

```
get
dispose 1
got 1
dispose 1
```

The element was disposed right after the call, and again when `l` was
dropped. With `ArrayList(JoinHandle(i32))` and `l(usize(0)).is_finished()`,
the second release freed the task's future twice and the program crashed in
`__yo_sm_pools_drain` at exit (SIGSEGV). A `get` whose body only reads
`self.id` did not show it: the mutation summary skips a read-only callee.

## Cause

Aliasing Stage 0 (`set_expr_as_needs_to_call_dup_for_borrowed_projection`,
`src/evaluator/utils.yo`) gives an RC-typed projection argument passed to a
borrowing parameter a caller-owned +1 for the call, so a callee that mutates
the container cannot free the value it borrows. Its gate is
`type_contains_rc_type`, which is true for every move-only type: the
ownership machinery tracks move-only values like RC values. A move-only value
has no +1. Its "dup" lowered to a bitwise copy, and the copy's scope-end drop
ran `Dispose` on the element the list still owned.

## Fix

The marker returns early for a move-only type. A borrow of a move-only
element stays a plain borrow: the element cannot be copied, and the call's
exclusivity rules keep the container from being replaced under it.

Regression test: `tests/move_only.test.yo`, "a method call on a move-only
element borrows it: no copy is disposed", and `tests/async/join_handle.test.yo`
(a `JoinHandle` list's `l(i).is_finished()`).
