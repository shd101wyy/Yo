# An argument lent both `&mut` and `&` to one call inside an `io.async` body gets no caller-owned share

**Severity:** S1 — inside an `io.async` body, `f(&mut xs, &xs)` on a collection still lets a callee that replaces `xs` read freed memory through its `&` argument.

**Status:** open. Found 2026-10-21 while fixing the synchronous case
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

## Cause (as far as read)

The evaluator records Phase 5.2's caller-owned `+1` on the `&xs` argument
(`set_expr_as_needs_to_call_dup_for_borrowed_projection(..., force : true)`,
`src/evaluator/utils.yo`), and since the sync fix the pair optimizer keeps
it. But the state-machine call path emits only a by-value parameter's share
for a slot argument: `_fused_arg_carries_param_share`
(`src/codegen/exprs/async.yo`) says "the caller-owned +1 of a borrowed
projection [is] not emitted in a state machine", and `other_fn_call.yo`'s
`sm_share` does the same for a plain call. The emitted call is
`f(&sm->var_xs, sm->var_xs)` with no `+1` around it, so the callee's first
`a = …` frees the list `b` points to.

## What a fix needs

Emit the dup and its post-call drop for a slot argument in a state machine
as the plain call path does, or hold the share in a temporary that does not
cross a suspension (the call has no `await` inside it, so the `+1` never
needs a slot). The test is the reproducer above as a `tests/async_await.test.yo`
case, under the test runner's ASan build.

## Relation to decision 28 and decision 43

The call stays accepted until the overlap rule lands (decision 28's
value-root rule with V2b, or O3 step 2 with N1;
`plans/backlog/REFERENCES_AND_ORIGINS.md` §7). Until then the `+1` is what
keeps it sound.
