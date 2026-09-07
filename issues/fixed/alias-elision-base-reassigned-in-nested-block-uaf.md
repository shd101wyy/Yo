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

## Sibling shapes (same root, found by probing)

- **Alias reassigned** (`b := a; b = new;`): the alias was marked consumed,
  so its scope-end drop was skipped — the REPLACEMENT leaked (dispose count
  short by one on the seed).
- **Chained aliases, base reassigned in a nested block** (`b := a; c := b;
  { a = new; }`): under-released on the seed (dispose count short by one).
- Plain last-use-then-reassign (`take(a); a = new;`, same or nested block) was
  already correct on the seed and is left alone.

## Fix

`_optimize_dup_drop_pairs` now treats an alias candidate (`base.id != v.id`)
whose alias OR base is assigned anywhere in the block's subtree
(`_subtree_assigns_variable`, macro-expansion aware) as non-elidable: the dup
is kept, so each handle owns its own count, the reassignment releases only
the reassigned handle's count, and every scope-end drop releases its own.
The base is then also protected from the plain move path (which would
otherwise remove the same dup when the base is the candidate and mark the
base consumed — the base's replacement would leak). The decision is recorded
on the BASE variable (`VariableRare.keep_alias_dups`), not only in the
epilogue's local set: an alias made in an INNER block (`{ b := a; a = new; }`)
is decided by the inner epilogue while the base's candidate pass runs in the
OUTER block's epilogue — a first version that kept the decision local made
exactly that shape crash under GuardMalloc although it is clean on the seed
(caught by re-probing every sibling shape after the fix). Cost: one dup/drop
pair in exactly the shapes that were unsound.

## Tests

`tests/rc.test.yo` — "alias survives a reassignment of its base inside a
nested block", the inner-alias twin, "reassigning the alias itself disposes
both objects exactly once", and "chained aliases with the base reassigned in
a nested block", "alias made in an inner block, base reassigned there, base
used after" (dispose deltas). GuardMalloc-clean.
