# An aborted task runs a user `Drop` on a local it never stored

**Severity:** S1 — when a task unwinds, its abort runs the `Drop` of every value-type local that has a task slot. That includes a local the body never reached, and one it already moved out. The `Drop` runs on zeroed bytes, so a descriptor wrapper whose fields read zero closes fd 0 (stdin).

**Status:** open. Found 2026-10-23 while fixing `issues/fixed/2026-10-23-an-aborted-task-drops-a-box-local-it-never-stored.md`, on develop `5136a2b9d` with the tree binary. That fix covers `Box` and every type whose state sits in a `Box`, which includes the std resources. It does not cover a user type that implements `Drop` on its own fields.

## Reproducer

```yo
{ IoExn, Exception } :: import("std/error");
{ println } :: import("std/fmt");
_Tok :: struct(n : i32);
impl(
  _Tok,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      println(`drop _Tok(${self.n})`);
    })
  )
);
_make :: (fn(fail : bool, io : Io) -> Impl(Future(_Tok, IoExn)))(
  io.async(e => {
    if(fail, {
      e.exn.throw(dyn(`boom`));
    });
    _Tok(n : i32(7))
  })
);
_outer :: (fn(fail : bool, io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(e => {
    r := e.io.await(_make(fail, e.io), e);
    w := e.io.await(_make(false, e.io), e);
    v := (r.n + (w.n - i32(7)));
    return(v);
  })
);
_run :: (fn(fail : bool, io : Io) -> bool)({
  exn := Exception(
    throw : (
      err -> {
        unwind(false);
      }
    )
  );
  ioe := IoExn(io : io, exn : exn);
  v := io.await(_outer(fail, io), ioe);
  v == i32(7)
});
main :: (fn(io : Io) -> unit)({
  println(`threw: ${!_run(true, io)}`);
});
export(main);
```

Output:

```
drop _Tok(0)
threw: true
```

No `_Tok` was ever made, yet one is dropped.

## Root cause

`dispose_locals` (emitted by `src/codegen/exprs/async.yo`, the `local_drop_lines` loop and the fused-block variant near `sm_move_flag_of`) drops every named local slot that crosses an await. A slot that was moved out is first zeroed (`if (sm->__yo_mv_…) memset(…)`). A slot the body never stored is still zero from the state machine's `memset`. Either way the drop runs on zeros. That is harmless for a reference handle, whose release null-checks, and for `Box` since the fix above. A user `Drop` runs on a value that does not exist.

## Fix direction

Give each such slot an initialization flag: set it at every store into the slot (the stores already clear `__yo_mv_…`), clear it when the slot is moved out, and drop only a slot whose flag is set. These are Rust's drop flags. The move flag can become this flag if it starts at "empty" when the state machine is created and the abort drops only a slot whose flag says "holds a value", instead of zeroing it and dropping it anyway. The dup/drop emit-diff gate and an over-cancellation canary apply.

The test that lands with the fix: the reproducer above in `tests/move_only.test.yo`, asserting that `g_mo_disposed` does not move when the task aborts before the local is stored.
