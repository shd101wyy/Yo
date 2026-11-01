# A `ref`-root place lent `&mut` and `&` to one call reads a stale copy

**Severity:** S1 — memory unsafety in safe code. A call that lends one place both `&mut` and `&` through a `ref(struct(...))` root (`o.s.push_string(&o.s)`) passes the `&` argument as a bitwise copy of the place's fields taken at the call. When the callee grows or replaces the place through its `&mut` argument, the copy still holds the old buffer pointer, and reading it is a use after free. Decision 28's value-root rule (E0910) rejects the same overlap on a local, but not below a `ref` root.

**Status:** open. Found 2026-10-31 on `vbd/b8-arraylist-string-flip`: once B8 makes `String` a value, `tests/string/string.test.yo`'s "a string pushed onto itself through a ref root appends a copy of itself" fails under ASan (heap-use-after-free, exit code 256). Before B8 the `&String` copy was a handle, so it followed the object.

The two std methods that grow `self` from a `&Self` argument are mitigated on the B8 branch: `String.push_string` and `ArrayList.extend_cloned` compare the argument's buffer pointer with `self`'s before growing, and read from `self`'s grown buffer when the two share one. Tests: the string test above, and "extend_cloned of a list with itself through a ref root appends a copy" in `tests/collections/array_list.test.yo` (fails before with exit code 256 under ASan, passes after). Any other callee, in std or user code, that writes `self` and then reads an aliased `&` argument is still exposed.

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

A non-projection `&T` parameter is passed by value (a copy of the place's bits; only a projection's `&T` parameters are pointers, `fn_param_is_ptr_borrow`). That is sound only while nothing can write the place during the call, which decision 28's value-root rule guarantees for places rooted in a local or parameter. A place below a `ref` handle is shared by every holder of the handle, so the rule does not apply there, and an overlapping `&mut` argument can write it.

## Fix direction

DECIDED (2026-10-31, Fable consultation #12 B8-Q3): extend the call-argument overlap check (E0910) to places below the same `ref` cell — two arguments rooted at the same `ref` handle overlap when their paths below it overlap, exactly as for a value root (the cell is the unit for local borrows already, decision 18; the same generalization decision 43's audit row pins as `f(&mut xs, &xs)` E0910 by name). This is an evaluator-only change (no C change). It lands as a separate PR BEFORE the B8 flip merges (v0.2.74; another agent owns it), and that PR deletes the two std mitigations above (`push_string`/`extend_cloned` buffer-pointer compares) with their special-case tests, keeping the ASan repro as an E0910 test. The alternative — passing such `&T` arguments by pointer — would change the calling convention of every `&T` parameter of a value type and reverse decision 33's copy-lowering semantics; rejected. For N2, O3's origin intersection absorbs this rule: write it as the ref-cell generalization, not a new check family. Until that PR lands, the mitigations stay in place on this branch.
