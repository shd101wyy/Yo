# A self-referential bound (`A <: Add(A)`) rejects every candidate for `A`

**Status: FIXED 2026-09-25** (Phase 2.6 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).

**Severity: false rejection.** A binder fixed by an associated-type bound,
with a second bound that mentions the binder itself, refused every argument:

```rust
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
_sum :: (fn(generic(S : Type, A : Type), s : S, zero : A, where(S <: Iterator(Item := A), A <: Add(A))) -> A)(
  s.fold(zero, (acc, x) => (acc + x))
);
main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(7));
  println(_sum(xs.into_iter(), i32(0)));
});
export(main);
```

```
error[E0602]: Type ArrayListIter(i32) does not implement required trait Iterator.
```

The same program with `A <: Clone` or `A <: Add(i32)` was accepted. Expected
output: `7`.

**Found** 2026-09-25 while landing Phase 2.6 (associated types in a free
function's `where`). The seed fails earlier on the same program, because it
cannot bind `A` from `Item := A` at all.

## Root cause

Checking `Item := A` against the iterator's `Item = i32` asks
`are_types_compatible(i32, A)`, where `A` carries the bound `Add(A)`. The
"concrete vs constrained SomeT" rule in `src/types/compatibility.yo` required
`i32` to implement each of `A`'s bounds as written, and `i32` does not
implement `Add(A)`: `Add(A)` is a different trait value from `Add(i32)`.
Trait identity is the instantiation's id. Answering correctly means applying
the `Add` constructor at the candidate, which `types/` cannot do because it
cannot evaluate.

## Fix

The rule skips a bound that mentions the SomeT itself (`_bound_mentions_some`
looks inside trait member types and Fn signatures). That bound is still
checked. The call's where-clause re-application
(`reapply_where_clause_exprs_for_call`) re-evaluates `A <: Add(A)` with `A`
bound, as `i32 <: Add(i32)`, and rejects a candidate that does not satisfy it.

## Verification

- The reproducer prints `7`.
- `tests/type_soundness.test.yo`, "soundness: a free fn binds an associated
  type from its where-clause" (`A <: Add(A)` at `i32` and at `i64`).
