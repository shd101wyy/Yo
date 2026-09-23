# The inout audit's C5 step says slot moves/overwrites are memory-safe and must NOT assert — the landed borrow asserts panic on them (the audit records both)

**Status:** FIXED 2026-09-23
**Severity:** documentation contradiction inside a frozen record that a future
refinement would read first. Runtime behavior is memory-SAFE (strictly more
conservative than the step text); nothing is wrong with the compiler.
**Found:** 2026-09-23, auditing `plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md`
against the tree; the reproducer below was run with `yo 0.2.39`
(`--optimize 2`) against the tree's `std/`.

## The contradiction

`plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md`, §8 Phase C, step C5
("Invalidation asserts"):

> The operations that must assert are exactly: any capacity change (realloc),
> any free, and any LENGTH DECREASE or entry removal … **Uniqueness-preserving
> moves between slots (`insert`'s shift, `sort`, `reverse`, `swap`) and slot
> overwrites (`xs(i) = v`, `set`) are memory-safe under a live borrow** — the
> slot still holds exactly one valid value

The same document's §9 third pass:

> Probed and confirmed correct: … `sort` inside a borrowed body (panics, **as
> designed**).

And the per-parameter-mask section:

> Verified: … `push`/`pop`/`insert`/`sort`, … still assert.

These cannot all describe one system. What landed (and what the code comment
on the emitter says — `src/codegen/functions/generation.yo:493-504`, "a length
decrement, **a slot overwrite**, a node unlink, a realloc/free, a call it
cannot see through") is the coarse rule: `_maybe_emit_method_entry_borrow_assert`
asserts at entry of every function whose `function_param_mutation_mask` hits
any RC-object parameter. The mask cannot distinguish an invalidating mutation
from a slot move or overwrite, so `sort`/`set`/`swap`/`reverse`/`insert` all
panic under a live borrow even though the C5 analysis (correctly, on its own
terms) shows they preserve "exactly one valid value" per slot.

## Reproducer (current behavior, verified 2026-09-23)

```rust
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");

main :: (fn(io : Io) -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(3));
  list.push(i32(1));
  list.push(i32(2));
  for(list, inout(x) => {
    if(x == i32(1), {
      list.sort();   // panics at runtime
    });
  });
});
export(main);
```

```
panic: container operation while an interior reference (a 'ref' into an
element/field) borrows from it
Aborted (core dumped)            # rc 134
```

`sort` permutes whole values between slots; each slot keeps exactly one valid
element, so the outstanding `x` stays memory-safe — this is a conservative
false positive, not a caught UAF.

## Why it matters

- A reader who wants to refine the assert set (permit slot moves/overwrites —
  a real, safe improvement for in-place algorithms inside borrowed loops)
  will find the C5 step text asserting that design **already holds**, and the
  third pass asserting the opposite. The frozen record never reconciles them.
- The audit banner (the designated live tracker of open follow-ups, since
  "nowhere else tracks the open follow-ups") lists the `Iterable` trait, the
  C4 static diagnostic, last-use live ranges and the codegen error channel —
  but not this granularity gap.

## Suggested fix

One line in the archived plan's **banner** (the body is frozen, the banner is
the live tracker), e.g.: "the landed assert set is the per-parameter mutation
mask, so memory-safe slot moves/overwrites (`sort`/`set`/`swap`) also panic
under a live borrow; §8 C5's 'exactly' list describes a finer granularity
that was never implemented — permitting safe moves is an untracked possible
refinement." No code change is required for this issue; a code change is only
needed if the refinement itself is taken.

## Fix (2026-09-23)

The archive's banner (the live follow-up tracker; the frozen body is not
rewritten) now carries a "Corrections to the frozen record" paragraph stating
that C5's "exactly" list describes a granularity that never landed — the
emitter keys on the per-parameter mutation mask, so memory-safe slot
moves/overwrites (`sort`/`set`/`swap`) panic under a live borrow too — and
that permitting safe moves is an untracked possible refinement.

## Verification

Banner text in `plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md`; the reproducer
above re-verified the same day (`sort` under a borrowed loop still panics,
`yo 0.2.39` tree-built, `--optimize 2`) so the correction matches shipped
behavior.
