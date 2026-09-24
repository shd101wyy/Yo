# A `cond` arm whose unit value renders a statement is dropped, so every HashMap rehash leaks

> Found 2026-09-24 by the LSP leak investigation
> (`issues/lsp-memory-grows-per-open-edit-close-round.md`,
> `plans/EVALUATOR_MEMORY_REDUCTION.md`). Fixed in the same PR as this doc.

## Symptom

```rust
Node :: ref(struct(n : usize));
m := HashMap(usize, Node).new();
// insert 100 nodes, let `m` die
```

disposes 44 of the 100 nodes. Each node leaks one reference for every
rehash it lives through. The compiler's own `ExprInfo` tables
(`HashMap(ExprId, ExprInfo)`) are the biggest victim: `check` of an empty
file left about 28 K ExprInfos alive, all reachable from nothing, with 1–5
extra references each (one per resize).

## Root cause

`HashMap._resize` (`std/collections/hash_map.yo`) duplicates each live bucket
into the new table and then releases the old slots with

```rust
cond(
  Type.contains_rc_type(V) => unsafe.drop((bucket_ptr.*).value),
  true => ()
);
```

`unsafe.drop` expands to `___drop(value)`, whose generator RETURNS its
statement text (`__yo_decr_rc((void*)((*bucket_ptr).value))`) rather than
emitting it. In `src/codegen/exprs/cond.yo`, `_emit_value_arm_body` discarded
the rendered code of a unit arm that is not control flow ("unit values emit
nothing"), so the release never reached the C. `match` handles the same case
correctly: `_emit_case_body_no_break` emits an unassigned arm's code as a
statement. A block arm (`c => { unsafe.drop(x); }`) was also correct.

Minimal reproduction:

```rust
k :: (fn(p : *(Entry), f : bool) -> unit)({
  cond(f => unsafe.drop((p.*).value), true => ());
});
// emitted: if (f) { } else { }
```

Both `cond` lowerings had the gap: the if/else chain (`_emit_value_arm_body`)
and the collapse-to-direct path taken when the first non-false arm is a
compile-time true. `_resize`'s `Type.contains_rc_type(V) =>` arm takes the
second one.

## Fix

A shared `_emit_unassigned_arm_code` emits an unassigned arm's non-empty
rendered code as a statement (a bare temp name excepted), mirroring match.
Both lowerings call it.

## Test

`tests/rc.test.yo`: "a HashMap that rehashes releases every value once when
it dies" (Dispose counter; 100 inserts, then the map dies). It fails on the
unfixed compiler (exit 6) and passes after the fix.
