# A synthesized dup's temp in a wrapper awaited twice is undeclared at the second fused site

**Severity:** S2 — a valid program fails in the C compiler (`use of undeclared identifier`) when one task awaits twice a wrapper whose fused block takes a call-scoped share; `yo check` passes.

**Status:** fixed 2026-10-22 (branch `fix/async-aliased-argument-share`). Found while fixing
`issues/fixed/2026-10-21-an-aliased-argument-in-an-async-body-gets-no-caller-owned-share.md`;
latent on develop since the synchronous share landed (#1528).

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
Bx :: ref(struct(tag : i32));
clobber :: (fn(a : &mut ArrayList(Bx), b : &ArrayList(Bx)) -> usize)({
  (mut(i) : i32) = i32(0);
  while(runtime(i < i32(3)), {
    a = ArrayList(Bx).new();
    a.push(Bx(tag : i));
    i = (i + i32(1));
  });
  b.len()
});
pro :: (fn(io : Io) -> Impl(Future(usize, Io)))({
  mut(ys) := ArrayList(Bx).new();
  ys.push(Bx(tag : i32(3)));
  n := clobber(&mut ys, &ys);
  io.async((io : Io) => {
    io.await(yield(io), io);
    n
  })
});
twice :: (fn(io : Io) -> Impl(Future(usize, Io)))(
  io.async((io : Io) => {
    a := io.await(pro(io), io);
    b := io.await(pro(io), io);
    a + b
  })
);
main :: (fn(io : Io) -> unit)({
  println(io.await(twice(io), io));
});
export(main);
```

With the develop binary at c8d297cc1, `yo compile` fails in clang:

```text
error: use of undeclared identifier '_file____home_temp_98409701699865171060'
    size_t _file____home_temp_69745953908407627780 = yo_id_…((…**)((&(__yo_v_ys))), (…*)(_file____home_temp_98409701699865171060));
```

The temp is declared inside the first `pro(io)` site's C block and used
inside the second site's block.

## Cause

A fused await site emits its wrapper's body inline, once per site, so a task
that awaits `pro(io)` twice emits `pro`'s prologue twice in one C function.
The prologue runs on the plain call path, which takes the aliased argument's
caller-owned `+1` since #1528 (`mark_call_scoped_share_dup`). That dup renders
as a bare `__yo_incr_rc(...)`, and `generate_deferred_dup_expressions`
(`src/codegen/exprs/drop_dup.yo`) declares its result temp unless it is
"already declared". That test read the function's `declared_c_var_names`,
a set that only grows. The second copy found the name from the first copy,
whose C block had already closed, and emitted the assignment without a
declaration.

The state-machine share fix in the companion issue made the same shape
reachable from a task's own body. A task awaiting a wrapper twice whose `&`
parameter receives a borrowed projection (the compiler's own
`release_store_lock(&lock)`, which lends `lock.file`) broke the stage-2 C
of `src/main.yo` the same way.

## Fix

The gate asks the emitter's open block-scope stack (`scope_stack_contains`
over `declared_scopes`) whether the temp is declared in a scope that is still
open. That is the liveness signal the drop gates already use. A second fused
site declares its own copy of the temp.

## Test

`tests/async_await.test.yo`:

- "an aliased call in a wrapper's prologue compiles at each fused site of one
  task" is the reproducer's shape. The develop binary at c8d297cc1 fails to
  C-compile it; the fixed binary compiles it, each prologue's borrowed list
  keeps its length, and every box is released exactly once.
- "a borrowed projection's share is declared at each fused site of one wrapper"
  is the projection shape. Develop compiles it because it takes no share
  there. The companion fix without this gate fails to C-compile it.
