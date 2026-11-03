# A fused wrapper's consuming match of a call result drops the moved payload twice

**Severity:** S1 — a double drop in safe code. An `io.async` wrapper whose body moves a `Drop` payload out of a call result with a consuming `match` and then awaits drops that payload twice when the wrapper is awaited inside another `io.async` body (the fused path). For a payload that owns heap memory this is a double free.

**Status:** FIXED 2026-11-02 on `fix/s1-match-await-double-drop`. Found 2026-10-31 while writing the test for `issues/fixed/2026-10-31-a-wrapper-whose-match-is-fused-at-two-awaits-redefines-its-c-labels.md` on `fix/closure-capture-mut-receiver-spill`. The v0.2.73 seed, develop `9c78fdaf0` and develop `b02a4c908` all count two drops. Awaiting the same wrapper from a test body (no outer `io.async`) counts one, and so does any build with `YO_ASYNC_FUSION=0`: the bug is in await-site fusion. The `std/fs/dir.yo` wrappers have this shape (`cstr_bytes := match(path.to_string().to_cstr_checked(), .Ok(b) => b, …)` then an await); once B8 makes their `ArrayList(u8)` a value, a fused `create_dir`/`remove_dir` call would have double-freed.

## Reproducer

```yo
{ String } :: import("std/string");
{ yield } :: import("std/async");
{ IoExn, Exception } :: import("std/error");
{ println } :: import("std/fmt");
(mut(g_drops) : i32) = i32(0);
_Fd :: struct(n : i32);
impl(
  _Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_drops = (g_drops + i32(1));
    })
  )
);
_res :: (fn(n : i32) -> Result(_Fd, i32))(
  if(n > i32(0), Result(_Fd, i32).Ok(_Fd(n : n)), Result(_Fd, i32).Err(n))
);
_task :: (fn(n : i32, io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(e => {
    fd := match(_res(n), .Ok(b) => b, .Err(_) => e.exn.throw(dyn(String.from("not positive"))));
    e.io.await(yield(e.io), e.io);
    fd.n
  })
);
_outer :: (fn(io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(e => {
    a := e.io.await(_task(i32(1), e.io), e);
    a
  })
);
test("one _Fd, dropped once", {
  _r := io.await(_outer(io), IoExn(io : io, exn : Exception(throw : (_err -> unwind(())))));
  d := g_drops;
  println(&d); // 2
});
```

## Expected

One drop: the arm moves `b` out of the scrutinee temporary into `fd`, so only `fd` owns it. A fix adds the reproducer as a test that asserts one drop, and adds the drop-count assertion back to "move-only: a wrapper's consuming match fused at two awaits of one task" in `tests/move_only.test.yo`.

## Cause

Not the match: the consuming match and its binding are emitted correctly, and the fused body drops `fd` once at its scope end. The second drop came from the CALLER's dispose. Await-site fusion (`emit_fused_await`, `src/codegen/exprs/async.yo`) runs the wrapper's body inside the caller's state machine and gives the wrapper's cross-boundary locals (`fd`) and its capture struct fields in the caller (`sm->var_fd_…`, `sm->__fz…_capture`). The caller's dispose released every fused site's fields unconditionally, on the premise that "a site that is not live has zeroed fields, so this releases nothing there": the site's end zeroes them (`memset`). That premise holds for an RC handle (a zeroed handle is NULL, and its release is skipped) and is false for a move-only value: a zeroed `_Fd` is still an `_Fd`, and its drop runs the user's `Drop` on it. The emitted dispose of `_outer` was:

```c
  if (sm->__yo_mv_var_fd_…) { memset(&(sm->var_fd_…), 0, sizeof(sm->var_fd_…)); }
  yo_id_…_dispose(&(sm->var_fd_…));   /* runs on every dispose, the site long finished */
```

The wrapper's own state machine never had the problem: its dispose releases its locals only on `state == -2` (normal completion drops them inline).

The same premise made a task that unwound AFTER a fused site finished drop the site's payload again (dispose with `state == -2`, site fields zeroed), and two fused sites of one wrapper dropped their shared `fd` field a third time.

## Fix

`src/codegen/exprs/async.yo`: a fused site whose fields can hold something the dispose releases (`_fused_site_has_releases`: its capture struct, or a local, holds an RC or move-only value) carries a `uint8_t <prefix>live` field. `emit_fused_await` sets it once the site's capture is stored and `_emit_fused_site_end_releases` clears it after the site's own releases at its end. The dispose (`_emit_fused_sites_dispose`) releases a site's capture fields under `if (sm-><prefix>live)`, and each local field once, under the OR of the live flags of the sites that share it (a wrapper block reached at two depths shares its local fields; its sites run one after the other). A site the task died in is still released by the dispose, exactly as before; a site that finished is not touched.

Not covered here, still open: an abort that happens inside a live site before a move-only local is stored runs its `Drop` on the zeroed slot (the `.Err` arm of this reproducer's wrapper, fused or not), which is `issues/2026-10-23-an-aborted-task-runs-a-user-drop-on-a-local-it-never-stored.md`.

## Tests

`tests/move_only.test.yo`: the drop-count and drop-sum assertions are back on "move-only: a wrapper's consuming match fused at two awaits of one task" (dropped 3 before the fix, 2 after), and three new tests cover the fused site completing ("a consuming match of a call result before an await in a fused wrapper drops the payload once": 2 → 1), the task dying inside the site (1, unchanged: the dispose still releases a live site) and the task dying after the site finished (2 → 1).

