# A `ref`-root place lent `&mut` and `&` to one call reads a stale copy

**Severity:** S1 — memory unsafety in safe code. A call that lends one place both `&mut` and `&` through a `ref(struct(...))` root (`o.s.push_string(&o.s)`) passes the `&` argument as a bitwise copy of the place's fields taken at the call. When the callee grows or replaces the place through its `&mut` argument, the copy still holds the old buffer pointer, and reading it is a use after free. Decision 28's value-root rule (E0910) rejects the same overlap on a local, but not below a `ref` root.

**Status: FIXED** by decision 43's ref-cell extension of decision 28's value-root rule (`_check_call_cell_root_overlap`, `src/evaluator/calls/function.yo`): two arguments of one call that root at the same `ref` cell may not overlap below it when one is lent `&mut` — E0910 at the later argument, naming the shared cell. Tests: `tests/ref_cell_lend_overlap.test.yo`; the ref-root regression of `issues/fixed/a-string-pushed-onto-itself-reads-its-freed-buffer.md` (`tests/string/string.test.yo`) now asserts the rejection. This doc supersedes the copy carried on `vbd/b8-arraylist-string-flip` (the B8 branch's buffer-pointer compares in `String.push_string` and `ArrayList.extend_cloned` are dropped at its final rebase; this branch never carried them — they exist only where `String`/`ArrayList` are values, which is the B8 flip).

Found 2026-10-31 on `vbd/b8-arraylist-string-flip`: once B8 makes `String` a value, `tests/string/string.test.yo`'s "a string pushed onto itself through a ref root appends a copy of itself" fails under ASan (heap-use-after-free, exit code 256). Before B8 the `&String` copy was a handle, so it followed the object. Fix direction decided by consultation #12 B8-Q3 (0.85): reject at check time — extend E0910 to ref-root places — never pass such `&T` arguments by pointer (that would change the calling convention of every `&T` parameter of a value type and reverse decision 33's copy-lowering semantics). For N2, O3's origin intersection absorbs this rule: it is the ref-cell generalization of the value-root check, not a new check family.

## Reproducer

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
_C :: ref(struct(xs : ArrayList(String)));
main :: (fn() -> unit)({
  o := _C(xs : ArrayList(String).with_capacity(usize(2)));
  o.xs.push(String.from("a"));
  o.xs.push(String.from("b"));
  o.xs.extend_cloned(&o.xs); // the &-argument copy's buffer is freed by the first push
  println(o.xs.len());
});
export(main);
```

With `extend_cloned` as it was (`self.push(other(i).clone())` in a loop), `--sanitize address --allocator system` reports a heap-use-after-free on the second element read. The emitted call is `extend_cloned(&(o->xs), o->xs)`: the `&` argument is the field's value, not its address.

## Cause

A non-projection `&T` parameter is passed by value (a copy of the place's bits; only a projection's `&T` parameters are pointers, `fn_param_is_ptr_borrow`). This is sound only while nothing can write the place during the call, which decision 28's value-root rule guarantees for places rooted in a local or parameter. A place below a `ref` handle is shared by every holder of the handle, so the rule does not apply there, and an overlapping `&mut` argument can write it.

## Fix

`cell_rooted_place_of` (`src/evaluator/utils.yo`) walks a lent place the way `local_borrow_place_of` does, but records the reference cell the path crosses (the root binding and the field steps down to it; the root itself when its type is a cell) and the value-field steps below it, stopping at a second cell (below a cell the cell is the unit, decision 18). `_check_call_cell_root_overlap` runs after `_check_call_value_root_overlap` at every call: when one lend is exclusive (`&mut`, or the receiver of a `&mut self` method) and another lend's place is strictly below the same cell, and the below-paths overlap, E0910 names the cell.

The shared side must be strictly below the cell: a `&` argument naming the cell whole is a copy of the handle, which a write below the cell cannot invalidate and which re-pointing leaves alive (a `ref` payload is shared), so `s.push_string(&s)` for a whole-cell receiver keeps working while the collections are shared handles. The exclusive side may be the cell itself: its callee can re-point the cell, freeing the storage below it. Disjoint paths below one cell (`f(&mut o.a, &o.b)`), two `&` lends, and distinct cells pass.
