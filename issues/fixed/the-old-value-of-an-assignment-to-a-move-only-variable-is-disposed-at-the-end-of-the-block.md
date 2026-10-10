# The old value of `x = y` is disposed at the end of the block, not at the assignment

**Kind:** design question: when a move-only value's replaced value is
disposed. Found 2026-10-04 while building the move-only compiler core
(`plans/VALUES_BY_DEFAULT.md` V3, Generation A).

## What happens

An assignment to a variable whose type carries a drop saves the old value in
a temp and drops that temp at the end of the enclosing block. This is how an
RC value has always been released. A move-only value (`Dispose` on a value
type) takes the same path, so its `dispose` runs at the block's end:

```rust
Fd :: struct(n : i32);
impl(Fd, Dispose(dispose : (fn(self : Self) -> unit)(close_fd(self.n))));

main :: (fn() -> unit)({
  (x : Fd) = Fd(n : i32(3));
  x = Fd(n : i32(4));   // fd 3 is NOT closed here
  long_running_work();  // fd 3 is still open
});                     // fd 3 and fd 4 are closed here
```

The emitted C (`--emit-c`) reads `_tmp = x; // Save old value for later use`
and `x = new;`, and the old value's drop is in the scope-end cleanup. The same
holds for a field store (`h.fd = Fd(...)`).

Each value is still disposed exactly once (`tests/move_only.test.yo`, "`=`
moves the right side…"), so this is not unsound. For a resource, though, the
release is late: a lock is held, or a descriptor stays open, until the block
ends. Rust drops the old value at the assignment.

## Options

1. **Dispose at the assignment** for move-only values: emit the old value's
   drop right after the store. There is no aliasing to protect, because a
   move-only value has one owner. The RC path keeps the delayed release,
   which exists so that `x = f(x)`-shaped stores never release a value that
   the right side still reads.
2. **Keep the block-end release** and document it ("the replaced value is
   released at the end of the block").

## Recommendation

Option 1, in the std half of V3, before any std resource becomes a move-only
value. The right side has already been evaluated when the store runs, and a
move-only right side cannot alias the old value (it would have been a copy,
which is E0901). So the immediate drop is sound for move-only values, and it
is the behavior resource code expects.

## Resolution (2026-10-09)

The maintainer chose option 1: drop at the assignment, as Rust does. As
built (branch `feat/vbd-v3b-storing-by-value`):

- An assignment STATEMENT (its value, the old value, unused) whose old value
  is explicit-copy (a move-only value, or plain data without `Copy`) drops it
  right after the store. `_drop_unused_old_value_now`
  (`src/evaluator/exprs/begin.yo`) marks the old-value temp moved, so the
  scope-end pass skips it, and records the drop
  (`record_immediate_old_value_drop`, `src/expr_info.yo`), which
  `generate_assignment` (`src/codegen/exprs/assignment.yo`) emits after the
  store. Variable, field and index stores, and stores inside `io.async`
  bodies, all take this path.
- `old := (x = y)` is unchanged: the old value moves into `old`.
- A still implicitly copyable kind (`String`, a collection, `Rc`, a `ref`
  handle) keeps the end-of-block release until its own phase makes it
  explicit-copy (V2b, V2c, V5): its right side can share the old value
  through a dup the pair optimizer elided.
- `tests/move_only.test.yo`, "an assignment statement drops the old value at
  the assignment", checks the timing for a variable, a field and an index
  store, and that a used result keeps the old value.
