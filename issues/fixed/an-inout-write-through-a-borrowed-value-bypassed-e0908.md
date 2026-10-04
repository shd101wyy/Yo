# An `inout` write through a borrowed value bypassed E0908

**Severity:** S2: a write the language rejects as an assignment was accepted as a method call. It was silently lost for an empty `String`, and the buffer it allocated leaked.

**Status: FIXED 2026-10-03** (`plans/STRING_VALUE_SEMANTICS.md` S1).

## Symptom

E0908 rejected an assignment into a borrowed binding (a by-value parameter, a `match` or `for` binding) whose old value holds RC data: `p.s = String.from("x")` is an error. The same write through an `inout` argument or an `inout(self)` receiver compiled:

```rust
append_copy :: (fn(out : String) -> unit)({
  out.push_str("!");
});
```

For an empty `String` the write landed in the callee's copy and was lost, and on yo 0.2.49 1,000 such calls leaked 33,000 bytes in 2,000 allocations. For a non-empty one it reached the caller through the shared buffer. `collect(String)`'s accumulator leak (`issues/fixed/collect-into-a-string-leaks-the-accumulated-buffer.md`) had the same shape.

## Fix

At both argument-binding paths, an `inout` argument whose place is rooted in a borrowed binding and whose type is a value aggregate holding RC data is recorded beside D3's pending list. When the callee's mutation mask (`effects/mutation_summary.yo`) says that parameter may be written, it is E0908, with the assignment rule's fix-it (`own`, `inout`, or a local copy). An unresolved mask counts as a write, as it does for D3. A read-only `inout(self)` method (`clone`, `to_string`, `hash`) resolves clean. A callee that returns a pointer (`Index.index`) is a place projection and is not judged here: a write through the place happens at the caller. The `std`/`src` sites it found are migrated:
- `FromIterator.from_iter_add` takes `own(acc)`;
- `_cc_plan_push_list` takes `inout(out)`;
- `String`'s `truncate`, `insert_str`, `insert`, `remove` and `pop` take `inout(self)`.

`YO_AUDIT_INOUT_BORROW=1` lists every site instead of stopping at the first.

## Tests

- `tests/cli-cases/inout-write-through-a-borrowed-param-is-e0908`
- `tests/cli-cases/inout-write-through-a-borrowed-for-is-e0908`
- `tests/string/string.test.yo`: the accepted forms are `inout`, `own`, a local copy, `clone`/index reads, an `inout` `for`, and a non-RC value written as a local copy.
