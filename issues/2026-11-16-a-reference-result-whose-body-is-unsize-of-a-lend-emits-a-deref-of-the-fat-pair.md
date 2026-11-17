# A `-> &[T]` function whose body is `unsize(&x)` emits a C dereference of the fat pair

**Severity:** S2 — a valid program fails to compile in C: the function returns `(*pair)` on a `__yo_slice_t`; writing the body `&unsize(&x).*` avoids it.

Found 2026-11-16 by the deref-owner lane (VERDICTS-63 Generation A), while writing an owner whose `deref` is
`unsize(&self.items)`. Develop `223b188f4` (built with `yo build --std-path ./std`).

## Reproducer

`issues/repros/2026-11-16-a-reference-result-whose-body-is-unsize-of-a-lend-emits-a-deref-of-the-fat-pair.yo`:

```yo
{ assert } :: import("std/assert");
W :: struct(items : Array(i32, 3));
impl(W, view : (fn(self : &Self) -> &[i32])(unsize(&self.items)));
f :: (fn(a : &Array(i32, 3)) -> &[i32])(unsize(a));
main :: (fn() -> unit)({
  w := W(items : Array(i32, 3)(1, 2, 3));
  v := w.view();
  assert(v.len() == usize(3), "view");
  a := Array(i32, 3)(1, 2, 3);
  r := f(&a);
  assert(r.len() == usize(3), "f");
});
export(main);
```

```text
error: indirection requires pointer operand ('__yo_slice_t' invalid)
  return (*((__yo_slice_t){ .ptr = (void*)((&((*__yo_v_self).__yo_v_items))), .len = (size_t)3 }));
```

## Root cause (inferred)

`unsize(&x)` is a projection call (decision 49) whose result is the fat pair. Since #1970 the evaluator accepts it as
the tail of a `-> &[T]` body ("a noted unsize-reference body IS the projection of the lent place"); the yo-dt6 binary
of 2026-11-15 rejected it and asked for `&unsize(...)`. The return lowering still treats a projection-call tail as a
sized place and wraps it in `(*…)`, which is invalid on the pair. `&unsize(&x).*` compiles, because its `&` folds the
place back to the pair.

## Fix direction

In the return lowering of a reference result, an unsized pointee's place code is folded to the pair
(`unsized_lend_pair_code`) instead of being dereferenced, as `_apply_ref_amp` and `generate_address_of` do.
