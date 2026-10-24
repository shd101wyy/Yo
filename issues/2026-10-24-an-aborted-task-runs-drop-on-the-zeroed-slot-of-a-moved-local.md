# An aborted task runs `Drop` on the zeroed slot of a moved local

**Severity:** S2 — the user's `Drop` runs a second time, on a phantom
all-zero value: a drop counter is off by one, and a file-descriptor wrapper
would `close(0)`. No memory error (a zero `String` drops as a no-op).

**Status:** open. Found 2026-10-24 while probing
`fix/s1-return-before-break-move`. Present on develop `48b8e93a1` and on that
branch alike. Sibling of
`issues/2026-10-23-an-exit-inside-an-unmoved-async-locals-own-initializer-drops-its-zeroed-slot.md`
(a different trigger, the same phantom value).

## Reproducer

```yo
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
{ sleep } :: import("std/sys/timer");
(mut(g_d) : i32) = i32(0);
Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_d = (g_d + i32(1));
    })
  )
);
take :: (fn(sink(f) : Fd) -> i32)(f.n);
main :: (fn(io : Io) -> unit)({
  h := io.spawn(
    io.async((io : Io) => {
      f := Fd(n : i32(7));
      io.await(yield(io), io);
      take(f);
      io.await(sleep(u64(50)), io);
    }),
    io
  );
  io.await(yield(io), io);
  io.await(yield(io), io);
  io.await(yield(io), io);
  h.abort();
  _r := h.await(io);
  d := g_d;
  println(`drops=${d} (want 1)`);
});
export(main);
```

Prints `drops=2`. The second run of `drop` sees `n == 0`.

## Root cause

The task's abort dispose (`<task>_state_dispose_locals`) zeroes a slot whose
move flag is set and then drops it unconditionally:

```c
if (sm->__yo_mv_var_f) { memset(&(sm->var_f), 0, sizeof(sm->var_f)); }
yo_dispose_Fd(&(sm->var_f));
```

A zero RC handle or `String` drops as a no-op, so for those the pattern is
sound. A value type with a `Drop` impl runs its destructor on the zero value.

## Fix direction

Skip the drop of a flagged slot (`if (!flag) drop(...)`) instead of zeroing
it first, at least for a type whose drop glue calls a user `Drop`
(`type_is_move_only`). The emitter is the escape-dispose block in
`src/codegen/exprs/async.yo` (the "A slot whose value was moved out still
holds it" comment).
