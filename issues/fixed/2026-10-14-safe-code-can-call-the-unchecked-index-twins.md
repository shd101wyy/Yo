# Safe code can call the unchecked index twins after the V2b split

**Severity:** S1: a safe program reads or writes past an `ArrayList`'s end with no `unsafe`, no pragma and no error.

**Found:** 2026-10-14 by develop's battery on 57e5c98c3 (run 38559516989). `tests/safe_code_structural_gates.test.yo` failed on ubuntu-latest and ubuntu-arm shard 2/4 and on wasm32-wasi:

```
error: Expected compile error, but the expression was evaluated successfully:
begin(xs := (ArrayList(i32).new)(), (xs.push)(i32(1)), (xs.index_unchecked)(usize(5)))
```

**Status:** fixed (fix/develop-index-unchecked-raw-pointer).

## Cause

`IndexUnchecked.index_unchecked` and `IndexUncheckedMut.index_unchecked_mut` are `index`/`index_mut` without the length test. Codegen calls them only at a subscript the verifier proved in bounds (`plans/backlog/SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md`). Nothing marks them unsafe: what kept safe code from calling them was their raw-pointer result (`-> *Self.Output`), since safe code cannot name a raw pointer.

V2b Generation B (#1361) moved both into the projection shapes (`-> &Self.Output`, `-> &mut Self.Output`), in `std/prelude.yo` and in `ArrayList`'s impls. A projection result is legal in safe code, so `xs.index_unchecked(usize(5))` compiled and read out of bounds.

## Fix

Both twins return `*Self.Output` again; the receivers stay `&Self`/`&mut Self`. No emitted C changes: codegen's twin call site dereferences the result either way, and the twin recorder (`_record_index_unchecked_twin`) accepts a pointer result.

## Test

`tests/safe_code_structural_gates.test.yo`: the existing read case fails on 57e5c98c3 and passes after the fix. A new case pins the same rejection for `index_unchecked_mut`.
