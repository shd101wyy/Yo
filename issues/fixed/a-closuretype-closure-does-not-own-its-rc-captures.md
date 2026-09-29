# A `ClosureType({...})` closure does not own its RC captures

**Status:** FIXED 2026-09-28 (Phase 3 step 7 part 2 branch, `tss/p37-registry-v2`).
**Found:** CI on PR #975. ASan on Linux reported a heap use-after-free in
`tests/closure.test.yo` ("closure with Impl that captures Rc object", "closure captured Rc
survives nested early return"). macOS's allocator hides it; Guard Malloc
(`DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib`) reproduces it locally.

## Symptom

On develop (`cccb47c6e`, compiler built from the tree), a closure built with the
fn-module-type form and returned from its builder reads freed memory:

```rust
MyBox :: ref(struct((*) : i32));        // with a Dispose impl that prints
ClosureType :: Impl(Fn(y : i32) -> i32);
make :: (fn() -> ClosureType)({
  x := MyBox(40);
  c := ClosureType({
    x.* = (x.* + y);
    return(x.*);
  });
  c
});
main :: (fn() -> unit)({
  c := make();
  println(`${c(2)}`);   // printed 8 (freed memory), expected 42
});
```

`dispose 40` printed when `make` returned. Under Guard Malloc the program crashes with
SIGSEGV. The `=>` form of the same closure is correct.

## Root cause (measured from the emitted C)

The capture-struct initializer takes each RC field's `___dup(name)` from the closure
ExprInfo's deferred dup expressions (`codegen/exprs/closures.yo`). The `=>` path sets them
(`anonymous_function.yo`, `generate_captured_variable_dup_expressions`).
`try_to_implement_closure_by_fn_module_type` (`calls/closure_type.yo`) never did, so the
capture struct was initialized with `.x = x`, a borrowed reference.

- **On develop** the closure value typed as the bare `Impl(Fn)` wrapper, so nothing
  dropped the capture either. That was consistent only while the closure did not outlive
  the local, and it dangled once it did (above).
- **On the p37 branch** the closure value types as its capture struct (the wrapper's
  resolution), so its copies are dup'd and its scope end drops each capture. That is one
  drop more than the references taken, which is the use-after-free CI caught.

## Fix

`try_to_implement_closure_by_fn_module_type` generates the captured variables' dup
expressions and sets them on the closure's ExprInfo, exactly as the `=>` path does. The
capture struct owns its reference. `leaks --atExit` reports 0 leaks for both repros.

## Test

`tests/closure.test.yo`: "ClosureType closure keeps its Rc capture alive after its builder
returns". It fails on develop and passes with the fix, under Guard Malloc as well.
