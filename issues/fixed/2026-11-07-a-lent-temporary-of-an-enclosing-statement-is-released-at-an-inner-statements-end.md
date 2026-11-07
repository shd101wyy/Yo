# A lent temporary of an enclosing statement is released at an inner statement's end

**Severity:** S1: use-after-free in generated code. Since #1814 a statement
nested inside a lending statement (a `for` loop body, most visibly) released
the outer statement's lent temporary at its own end, once per iteration, so
the stage-2 compiler freed its comptime-fn cache entries and rejected
`std/prelude.yo` on every invocation. Every develop battery since #1814 failed.

> Found 2026-11-07 investigating the mass-red develop battery 42361933554 on
> `f89a24b0d`: the seed-built stage 1 compiled `src/` fine, but the stage-2
> binary failed on its first file.

## Symptom

Every command of the stage-2 compiler (the tree compiled by a tree-built
stage 1) stopped on the prelude:

```text
error: Type "comptime_str" does not implement required constraint "(== : fn(lhs : &Self : (Comptime), rhs : &comptime_str) -> bool, != : fn(lhs : &Self, rhs : &comptime_str) -> bool)" from trait ""'s where clause.
     --> std/prelude.yo:1327:1
```

The CI artifact `bootstrap-stage2` (`yo-stage2.c`) rebuilt against libc
`malloc` with `-fsanitize=address` reports a heap-use-after-free in
`evaluate_comptime_fn_call` (`src/evaluator/calls/comptime_fn.yo`):
`g_comptime_fn_caches.with(xs => xs.get(ci))` takes a reference to a
`ComptimeFnCacheEntry` the same function had released inside the loop of

```yo ignore
match(
  g_comptime_fn_caches.with(xs => xs.get(the_entry_idx)),
  .Some(entry) => {
    for(&entry.caches, cache => { … });
  },
  .None => ()
);
```

A released cache entry then gave the where-clause check wrong answers.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
(mut(g_drops) : i32) = i32(0);
Holder :: struct(items : ArrayList(i32));
impl(
  Holder,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_drops = (g_drops + i32(1));
    })
  )
);
main :: (fn() -> unit)({
  (mut(xs) : ArrayList(i32)) = ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
  xs.push(i32(3));
  r := Rc.new(Holder(items : xs));
  (mut(sum) : i32) = i32(0);
  for(&r.items, x => {
    sum = (sum + x.*);
  });
  d := g_drops;
  println(`sum=${sum.to_string()} drops=${d.to_string()}`);
});
export(main);
```

`yo compile --sanitize address --allocator system` on develop `6b1147192`:
heap-use-after-free. The C keeps a counted copy of `r` for the borrow
`&r.items` (`tmp = __yo_incr_rc(r)`) before the lowered loop, and emits
`__yo_decr_rc(tmp)` as the loop body's second statement, so the handle loses
one count per iteration and is freed in the second.

## Root cause

#1814 (`_flush_stmt_lent_temp_drops`, `src/codegen/exprs/begin.yo`) flushes,
right after each non-final statement, every PENDING drop whose target is a
minted temporary with a lent mint token inside the statement's token span. The
pending list is not the block's own list: each block puts its scope-end drops
in front of every enclosing scope's drops (`_concat_drops`), so the escape
paths can release everything that is live. The flush scanned all of it.

A temporary an enclosing scope scheduled belongs to an enclosing statement
that is still running, because the current block is part of that statement.
Token spans normally keep it out: its mint token comes before the inner
statement's start. A lowering breaks that. The `for` lowering synthesizes
its nodes at the `for` token. The receiver's counted temporary is minted there,
and so is the loop body's first statement, the element binding
`x := get(for_coll, &for_cur)`. That statement's span runs from the `for`
token to the user's body, which comes later, so the outer temporary fell inside
it. The emitted-once guard keeps the drop's C text to one emission, but that
one emission sits inside the loop and runs on every iteration.

## Fix

A statement-end flush releases only a drop that is on the scope-end list of the
block whose statement just ended. `_flush_stmt_lent_temp_drops` takes that list
(`own_drops`), and each of the seven statement loops passes its block's
`deferred_drop_expressions()`: both forms of `generate_begin`, the function
body (`src/codegen/functions/generation.yo`), a `match` case body, a `cond`
arm, a `while` body and an `io.async` body. A temporary an enclosing block
scheduled keeps its release at that block's statement end or scope end, and
the drop is never emitted inside a nested loop. This matches Rust: a temporary
lives to the end of the statement that created it, and the statements nested
inside that statement do not end it.

Tests: `tests/local_borrows.test.yo`, "a lent temporary of an enclosing
statement is not released at an inner statement's end" (`for(&r.items, …)`
over an `Rc` handle) and "a match binding's lent temporary is not released
inside a loop in its arm" (the stage-2 compiler's shape). Both fail on develop
`6b1147192` (exit 256 and 6) and pass with the fix.
