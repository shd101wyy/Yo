# An `io.async` capture list hides the annotated context parameter

**Severity:** S3 — a valid `io.async({ caps }(e : IoExn) => ...)` with no expected type is rejected with a unification error. Spelling an expected type (a declared `Impl(Future(T, IoExn))` result) works around it.

**Status:** fixed 2026-10-23 (branch `feat/v3-std-cell-free-resources`). Found while moving the std resources to move-only values (plans/VALUES_BY_DEFAULT.md V3, std half), where every borrowing future gained a capture list. Present on develop `5136a2b9d`.

## Reproducer

```yo
{ assert } :: import("std/assert");
{ IoExn, Exception } :: import("std/error");
test("cap-list ioexn", {
  exn := Exception(
    throw : (
      err -> {
        unwind(());
      }
    )
  );
  b := IoExn(io : io, exn : exn);
  k := i32(5);
  w := io.await(io.async({ k }(e : IoExn) => (k + i32(1))), b);
  assert(w == i32(6), "w");
});
```

```
error: Cannot unify Io and IoExn
```

The same body without the capture list, `io.async((e : IoExn) => ...)`, compiles.

## Root cause

`io.async`'s context type `E` is bound from the receiver (`Io`) unless the closure's parameter carries an annotation, which then binds `E` through argument unification (the C60 guard). `_io_async_closure_param_is_annotated` (`src/evaluator/calls/helper.yo`) looked for the annotation in the closure's first parameter node. After a capture list, that node is the call `{ caps }(params...)`, not the `:` annotation. So the guard answered "not annotated", `E` was pre-bound to `Io`, and the `IoExn` annotation failed to unify.

## Fix

The guard reads through a capture list (`ast_expr_is_capture_list_params`): the first parameter inside `{ caps }(...)` is the one checked for an annotation.

## Verification

`tests/closure_capture_list.test.yo`, "an `io.async` body's capture list keeps its annotated `IoExn` parameter": it fails with the develop binary and passes with the fixed one.
