# A temporary object built in a `while` condition leaks once per evaluation

**Severity:** S1 — an unbounded leak in generated code: a `ref` object or an
`Rc` cell built and read inside a `while` condition is never released, one
allocation per evaluation of the condition, so a long loop leaks without bound.

**Status:** fixed 2026-10-25 on `fix/cond-scrutinee-temps` (see Fix). Found
2026-10-24 by the adversarial review of `feat/yo-cell-primitive-gen-a` (the
`__yo_cell` primitive). It predates that branch: the develop binary (v0.2.68
tree, 54e94f11e) reproduces it, and the new cell type leaks the same way
because it shares the `ref` object lowering.

## Reproducer

```yo
{ println } :: import("std/fmt");
RI :: ref(struct(v : i32));
main :: (fn() -> unit)({
  mut(j) := i32(0);
  while(RI(v : j).v < i32(3), {
    j = (j + i32(1));
  });
  println(`${j}`);
});
export(main);
```

`yo compile p.yo --sanitize address --allocator system -o p && ./p`:

```
SUMMARY: AddressSanitizer: 48 byte(s) leaked in 4 allocation(s).
```

Four allocations: the condition runs four times (`j` = 0, 1, 2, 3). The same
loop over `rc(k).* < i32(3)` leaks the same 48 bytes in 4 allocations. The
same temporary in an `if` condition or a `let` initializer is released.

## Where to look

The condition's temporaries are dropped by the scope that encloses the
`while`, not after each evaluation of the condition. A condition is
re-evaluated per iteration, so its deferred drops must run after each
evaluation (on both the continue and the exit edge), the way a loop body's
temporaries are dropped per iteration. Start at the `while` lowering in
`src/codegen/exprs/` and the deferred-drop bookkeeping of the condition
expression.

## Root cause

The guess above was wrong: the condition's temporaries are not dropped by the
enclosing scope. They are never dropped at all. The evaluator already gives
the condition its own frame (`evaluate_begin_expression` in
`src/evaluator/exprs/while.yo`), the way `cond` and a `match` guard get one.
That frame's scope-end drops ride the condition node, which shares its id with
the condition's tail. A call tail (`while(f(tmp), …)`) flushes them right
after the call. A field read or an operator tail (`RI(v : j).v < i32(3)`,
`mk(j).s.len() > usize(j)`) flushes nothing, and `generate_while_loop` emitted
`if (!(<cond>)) break;` without flushing the node either. The same held for a
`String` receiver (`String.from("abc").len() > usize(j)`: 140 bytes in 8
allocations).

## Fix

`_emit_while_cond_break` (`src/codegen/exprs/while_loop.yo`) emits the loop
head for both the two- and the three-argument form. It follows `cond.yo`'s
`_emit_cond_if_head`: the condition's drops are pending while it renders, so an
early exit inside the condition releases what is live. When a drop of the
condition node is still unemitted afterwards, the head becomes
`bool __yo_while_N = <cond>; <drops>; if (!(__yo_while_N)) { break; }`. The
drops then run once per evaluation, before the branch, so the exit edge and the
body edge are both covered, and `continue`, `break` and `return` leave after
them. A condition whose tail is a call keeps its old single line.

The triage of this issue found a related bug in the three-argument step, filed
and fixed alongside:
`issues/fixed/2026-10-25-a-temporary-built-in-a-three-argument-while-step-is-dropped-outside-its-c-scope.md`.

## Test

`tests/continue_rc_cleanup.test.yo`, "a temporary in a while condition is
released once per evaluation": a `Drop`-counted value built in the condition,
read through a field and through a `String` field's `len()`, with `continue`,
`break` and a `return` from the body. Each evaluation releases it once (4, 2
and 3 releases). Before the fix every count is 0.
