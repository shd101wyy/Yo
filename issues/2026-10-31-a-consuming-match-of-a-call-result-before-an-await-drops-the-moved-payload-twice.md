# A fused wrapper's consuming match of a call result drops the moved payload twice

**Severity:** S1 — a double drop in safe code. An `io.async` wrapper whose body moves a `Drop` payload out of a call result with a consuming `match` and then awaits drops that payload twice when the wrapper is awaited inside another `io.async` body (the fused path). For a payload that owns heap memory this is a double free.

**Status:** OPEN — found 2026-10-31 while writing the test for `issues/fixed/2026-10-31-a-wrapper-whose-match-is-fused-at-two-awaits-redefines-its-c-labels.md` on `fix/closure-capture-mut-receiver-spill`. The v0.2.73 seed, develop `9c78fdaf0` and that branch all count two drops. Awaiting the same wrapper from a test body (no outer `io.async`) counts one, and so does a wrapper without the await after the match. The `std/fs/dir.yo` wrappers have this shape (`cstr_bytes := match(path.to_string().to_cstr_checked(), .Ok(b) => b, …)` then an await); once B8 makes their `ArrayList(u8)` a value, a fused `create_dir`/`remove_dir` call double-frees.

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
