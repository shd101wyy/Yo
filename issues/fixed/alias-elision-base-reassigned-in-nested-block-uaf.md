# Alias dup elision + base reassigned in a nested block = use-after-free (pre-existing, no `inout` involved)

**Status: FIXED (2026-09-07, `inout` local-bindings PR).** Surfaced by the
Phase B tests of `plans/INOUT_LOCAL_BINDINGS_AUDIT.md` (a pinned object field
read garbage after its handle was reassigned in an inner block); the minimal
reproducer has no `inout` at all and crashes under the SEED compiler
(`yo 0.2.27`).

## Reproducer (safe code, no pragma)

```rust
Holder :: ref(struct(n : i32));
v4 :: (fn() -> unit)({
  h := Holder(n : i32(1));
  h2 := h;                       // alias: ONE shared count
  {
    h.n = i32(7);
    h = Holder(n : i32(100));    // old value's drop scheduled at THIS block's end
  };
  println(`${h2.n}`);            // reads freed memory (printed 10 / 3357993; GuardMalloc rc=139)
});
```

## Root cause

`_optimize_dup_drop_pairs` (`src/evaluator/exprs/begin.yo`) implements the
same-frame alias optimisation: for `h2 := h` the single `___dup` on the base
`h` is removed and the alias `h2` is marked consumed, so the group owns ONE
count, held by `h`, and only `h`'s scope-end drop releases it. That is sound
while `h`'s count outlives every use of `h2`. A reassignment `h = …` saves
the old value into a temp attached to the `=` expression
(`attach_temp_variable_to_expr`, `evaluator/exprs/assignment.yo`) whose drop
is scheduled at the end of the block the assignment sits in. In the same
block as the alias that is after every use of `h2` (fine); inside a NESTED
block it runs before the alias's remaining uses — and before the alias's
own scope end, where nothing drops (the alias was marked consumed).

## Fix

The optimizer now checks, for an alias candidate (`base.id != v.id`),
whether the base variable is assigned anywhere in the block's subtree
(`_subtree_assigns_variable`, macro-expansion aware). If so the dup is kept:
each handle owns its own count, the reassignment releases only the base's,
and the alias's scope-end drop releases its own. Cost: one dup/drop pair in
exactly the shape that was unsound.

## Tests

`tests/rc.test.yo` — "alias survives a reassignment of its base inside a
nested block" and the inner-alias twin. GuardMalloc-clean.
