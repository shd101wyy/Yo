# A wrapper whose `match` is fused at two awaits redefines its C labels

**Severity:** S2 — a valid program is rejected: the C compiler fails with `redefinition of label '__yo_m<N>_a0'`.

**Status:** FIXED 2026-10-31 on `fix/closure-capture-mut-receiver-spill`. Found the same day on `vbd/b8-arraylist-string-flip`: `tests/fs/walker.test.yo` stopped compiling once `ArrayList` became a value, because `std/fs/dir.yo`'s `remove_dir` (an `io.async` wrapper whose body is `cstr_bytes := match(path.to_string().to_cstr_checked(), .Ok(b) => b, .Err(_) => e.exn.throw(...))`) is awaited twice in one test task. Develop `9c78fdaf0` and the v0.2.73 seed fail the same way with any wrapper whose match moves a move-only payload out.

## Reproducer

The test "move-only: a wrapper's consuming match fused at two awaits of one task" in `tests/move_only.test.yo`:

```yo
_mo_fused_match :: (fn(n : i32, io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(e => {
    fd := match(_mo_res(n), .Ok(b) => b, .Err(_) => e.exn.throw(dyn(String.from("not positive"))));
    e.io.await(yield(e.io), e.io);
    fd.n
  })
);
_mo_fused_twice :: (fn(io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(e => {
    a := e.io.await(_mo_fused_match(i32(1), e.io), e);
    b := e.io.await(_mo_fused_match(i32(2), e.io), e);
    a + b
  })
);
```

## Cause

The general match lowering (`_gen_general_match`, `src/codegen/exprs/match.yo`) names its C labels after the match's AST node id (`__yo_m<id>_a0`, `__yo_m<id>_end`). C labels are scoped to the whole function, and a fused wrapper's body is inlined into the awaiting state machine's resume function once per await, so the same match node was emitted twice in one C function. A match lowered as a switch or a nullable-pointer test has no labels, which is why the shape only failed once the payload was move-only.

## Fix

The label prefix is fresh per emission (`fresh_local_name("__yo_m<id>_", <function>)`), so each inlined copy gets its own labels.
