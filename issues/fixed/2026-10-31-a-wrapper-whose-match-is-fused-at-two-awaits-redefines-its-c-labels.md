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

## Addendum (2026-11-03): the seed still has the bug, so the B8 tree build hit it

The fix reaches the compiler's own C one generation later, because the v0.2.73 seed (`SEED_VERSION`) compiles the tree. Once B8 flipped `ArrayList`/`String` to values (`vbd/b8-arraylist-string-flip-r4` @ `fcb1444fa`), `yo build --std-path ./std` with that seed failed in the C compiler with 6 `redefinition of label` errors at two sites. In both, a wrapper with a consuming match is awaited twice in one task:

- `remove_dir_all` (`std/fs/walker.yo`) awaits `remove_dir` (`std/fs/dir.yo`) in its loop and again after it. `remove_dir` holds `match(path.to_string().to_cstr_checked(), .Ok(b) => b, ...)`, whose payload is `ArrayList(u8)`.
- `artifact_input_stamp` (`src/build_runner.yo`) awaits `_read_depfile` twice. `_read_depfile` holds `match(bytes_opt, .Some(bytes) => ...)` and a `match(lines.get_cloned(i), .Some(l) => ...)`.

On develop the same awaits build with the same seed. There the payloads are ref handles, so those matches lower as switches and emit no labels. Until `SEED_VERSION` carries this fix, the two wrappers avoid the consuming match: `remove_dir` checks `is_err()` and throws, then takes `unwrap_or(...)`, and `_read_depfile` uses `unwrap_or(...)` plus a borrowed `for(&lines, ...)`. The revert is a Generation B row in `plans/backlog/SEED_VERSION_AUTOMATION.md`. Other std wrappers have the same shape, for example `create_dir`, `remove_file` and `rename`. They are safe only while no seed-compiled code awaits one of them twice in a task: a program that awaits `create_dir` twice fails the same way under the seed.

Building with `YO_ASYNC_FUSION=0` sidesteps the bug, since it turns fusion off. The regression test for the fix stays "move-only: a wrapper's consuming match fused at two awaits of one task" in `tests/move_only.test.yo`.
