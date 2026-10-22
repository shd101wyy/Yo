# An argument lent both `&mut` and `&` to one call inside an `io.async` body gets no caller-owned share

**Severity:** S1 — inside an `io.async` body, `f(&mut xs, &xs)` on a collection let a callee that replaces `xs` read freed memory through its `&` argument.

**Status:** fixed 2026-10-22 (branch `fix/async-aliased-argument-share`). Found 2026-10-21 while fixing the synchronous case
(`issues/fixed/2026-10-21-an-argument-lent-both-mut-and-shared-to-one-call-loses-its-caller-owned-share.md`).

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
_clobber :: (fn(a : &mut ArrayList(i32), b : &ArrayList(i32)) -> unit)({
  mut(i) := i32(0);
  while(runtime(i < i32(3)), {
    a = ArrayList(i32).new();
    a.push(i);
    i = (i + i32(1));
  });
  println(`b.len = ${b.len()}`);
});
run :: (fn(io : Io) -> i32)({
  task := io.async((io : Io) => {
    mut(xs) := ArrayList(i32).new();
    xs.push(i32(1));
    xs.push(i32(2));
    io.await(yield(io), io);
    _clobber(&mut xs, &xs);
    io.await(yield(io), io);
    i32(xs.len())
  });
  io.await(task, io)
});
main :: (fn(io : Io) -> unit)({
  println(run(io));
});
export(main);
```

`yo compile … --sanitize address --allocator system` and run:
`heap-use-after-free` in `_clobber`'s `b.len()`. Measured with the tree
binary of `test/decision43-n0-corpus` at ad962a451 (which fixes the same
call outside a state machine) and with the branch's tree binary before that
fix (c9323e0a2).

## Cause

The evaluator records Phase 5.2's caller-owned `+1` on the `&xs` argument
(`set_expr_as_needs_to_call_dup_for_borrowed_projection(..., force : true)`,
`src/evaluator/utils.yo`) together with its post-call `___drop` on the call
node, and since the sync fix the pair optimizer keeps it
(`mark_call_scoped_share_dup`). But the state-machine call path emitted only
a by-value parameter's share for a slot argument: `_materialize_arg`
(`src/codegen/exprs/other_fn_call.yo`) passes a `sm->` slot read with no
dup unless `_arg_carries_param_share` holds, and that predicate recognized
only `is_by_value_param_share_dup`. The fused-await twin
`_fused_arg_carries_param_share` (`src/codegen/exprs/async.yo`) did the
same. The emitted call was `f(&sm->var_xs, sm->var_xs)` with no `+1`
around it, so the callee's first `a = …` freed the list `b` points to. The
post-call drop was skipped too (its dup temp was never declared, so the
deferred-drop gate skipped it), which is why the bug showed as a
use-after-free rather than an over-release.

## Fix

Both predicates now also accept a call-scoped share
(`is_call_scoped_share_dup`), renamed `_arg_carries_call_share` and
`_fused_arg_carries_call_share`. That mark covers every `+1`
`set_expr_as_needs_to_call_dup_for_borrowed_projection` synthesizes: the
aliased argument's and also a borrowed projection's (`f(&r.name)`, where
`r` is a task slot or a capture). A state machine now takes and releases
both, as the plain call path already did. The dup is emitted on the slot's own
spelling, as the by-value share already was. Its result temp has a task
slot, so Rule 1 of `generate_deferred_dup_expressions` stores it there, and
the call's own post-call drop releases it through that slot:

```c
T* tmp = (T*)__yo_incr_rc((void*)(sm->var_xs));
sm->var_tmp = tmp;
f(&(sm->var_xs), tmp);
__yo_decr_rc((void*)(sm->var_tmp)); memset(&(sm->var_tmp), 0, sizeof(sm->var_tmp));
```

Emitting these dups in state machines made one more bug reachable from a
task's own body: a synthesized dup's result temp was declared only at the
first fused site of a wrapper awaited twice, so the second site used an
undeclared temp. The compiler's own `release_store_lock(&lock)`, which lends
`lock.file`, broke the stage-2 C that way. The bug was already on develop
through a wrapper's synchronous prologue (since #1528); it has its own doc,
`issues/fixed/2026-10-22-a-dup-temp-in-a-wrapper-awaited-twice-is-undeclared-at-the-second-site.md`,
and is fixed on the same branch.

A `&mut` wrapper parameter keeps an await unfused ("a wrapper parameter is
mut"), so `f(&mut xs, &xs)` itself never reaches the fused-await path.
The fused predicate's change applies to a projection argument that a fused
wrapper's `&` parameter receives. `emit_fused_await` already emits that
argument's post-call drop through
`generate_deferred_drop_expressions(&site.call, …)`.

Measured on `src/main.yo` (the develop binary at c8d297cc1 and this fix's
binary, each emitting this branch's `src/main.yo` with `--emit-c
--optimize 2`): the emitted C gains 157 call-scoped shares in state
machines. Of these, 153 are `__yo_incr_rc` on an Rc handle and 4 are
`__yo_venum_dup` on an enum value. Each is stored in its dup temp's task
slot and released after its call by a matching `__yo_decr_rc` or
`__yo_venum_drop` through that slot. Stores and drops match per slot, and
no dup or drop is removed. They are borrowed projections of captures and
slots in the compiler's own `io.async` bodies (`ctx.project_dir`,
`pkg.url`, `manifest.path`, `resp.body`, …). The task slots already existed
in the state structs, so no layout changes. The other hunks renumber 22
`temp_dup_enum_N` locals. `clang -fsyntax-only` accepts the emitted C.

## Test

`tests/async_await.test.yo`, "an argument lent both &mut and & to one call
in an io.async body keeps its share": a task-slot `ArrayList(_AliasBox)` lent
`&mut` and `&` to a statement call, a bound call and an awaited call whose
callees replace it three times. Before the fix the test runner's ASan build
reports `heap-use-after-free`; after it the borrowed lists keep their
lengths and every box is released exactly once.

The declaration gate's two tests are listed in
`issues/fixed/2026-10-22-a-dup-temp-in-a-wrapper-awaited-twice-is-undeclared-at-the-second-site.md`.

## Relation to decision 28 and decision 43

The call stays accepted until the overlap rule lands (decision 28's
value-root rule with V2b, or O3 step 2 with N1;
`plans/backlog/REFERENCES_AND_ORIGINS.md` §7). Until then the `+1` is what
keeps it sound.
