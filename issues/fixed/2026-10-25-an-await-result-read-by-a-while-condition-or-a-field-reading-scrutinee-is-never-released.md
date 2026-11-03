# An await result read by a `while` condition or a field-reading scrutinee is never released

**Severity:** S1 — unbounded leak: inside an `io.async` body, the result of an
`await` consumed through a field read (`(await f()).n < 3` as a loop condition,
`match((await f()).s, …)` as a scrutinee) is never dropped, so every evaluation
leaks the value it holds (a `String` payload: 39 bytes per evaluation for the
scrutinee, 156 bytes for a three-iteration condition).

**Status:** FIXED 2026-11-02 on `fix/s1-await-field-read-leak`. Found
2026-10-25 probing review item (d) of `fix/cond-scrutinee-temps`; still
present on develop `b02a4c908`, fused (`YO_ASYNC_FUSION=1`, the default) and
not fused alike.

Not the same bug as `issues/fixed/an-awaited-match-scrutinee-is-never-released.md`
(2026-09-28): that one covered the WHOLE-await scrutinee (`match(await f(), …)`),
whose subject temp is materialized from `sm->await_result_<k>` and now releases
correctly (verified: the whole-value await scrutinee is clean today). Here the
scrutinee/condition reads a FIELD of the awaited value, and the awaited value
itself is a C LOCAL `__yo_await_value<k>` (no later await in the same statement
can suspend before it is consumed), which no drop channel releases.

## Reproducer (scrutinee form)

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ yield } :: import("std/async");
Rec :: struct(n : i32, s : String);
mk :: (fn(x : i32) -> Rec)(Rec(n : x, s : String.from("payload")));
mkf :: (fn(x : i32, io : Io) -> Impl(Future(Rec, Io)))(
  io.async(e => {
    e.io.await(yield(e.io), e.io);
    mk(x)
  })
);
main :: (fn(io : Io) -> unit)({
  println(`${io.await(run2(io), io)}`);
});
run2 :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async(e => {
    m := match(e.io.await(mkf(2, e.io), e.io).s, "payload" => i32(1), _ => i32(0));
    m
  })
);
export(main);
```

`--sanitize address --allocator system`, `ASAN_OPTIONS=detect_leaks=1`:
`SUMMARY: AddressSanitizer: 39 byte(s) leaked in 2 allocation(s)` — the
`"payload"` `String` held by the awaited `Rec`. The condition form
(`while(e.io.await(mkf(j, e.io), e.io).n < i32(3), { j = (j + i32(1)); })`)
leaks 156 bytes in 8 allocations for three iterations. The same shapes outside
a state machine are released correctly by
`fix/cond-scrutinee-temps` (its ASan probe matrix is otherwise clean).

## Where to look

The emitted resume function (probes `rd2`/`rd1` in that branch's `tmp/`) ends
the await with `T __yo_await_value<k> = …;`, reads `.s` into the scrutinee's
slot (correctly dup'd and released), and never emits a drop of
`__yo_await_value<k>` itself: `__yo_await_value0.__yo_v_s` is `__yo_incr_rc`'d
for the slot, but the value's own reference count is never decremented. A
whole-value await scrutinee consumes the value through the match's materialized
subject (the 2026-09-28 fix's `sm->await_result_<k>` path); a FIELD-READING
consumer leaves the await value an unnamed C local that no scope-end channel
owns — the await-result analysis (`g_local_await_results`,
`src/codegen/exprs/await.yo` / `async.yo`) decides when a result needs a slot,
and this shape schedules no drop either way. A place to start: give a C-local
await result consumed by a field read the same treatment a call temp gets
(`_store_temp_var_to_state_machine_if_needed`-shaped ownership), or schedule
its drop on the enclosing condition/scrutinee node so the existing flushes
release it.

## Cause

The "Where to look" guess above was half right: the await result's drop IS
scheduled. The evaluator mints an owning temp for the `io.await(...)` call
(`variable_name`) and schedules its scope-end drop on the scrutinee's /
condition's one-expression frame (`YO_DEBUG_SCOPE_DROPS=1`: `[sd] … owning=true
… e7=true` for the temp). Codegen then skipped that drop: the state machine's
await emitter (`emit_inline_await`, and the fused path through it) stored the
result in a C local `__yo_await_value<k>` and returned that name, and never
declared the temp. `generate_deferred_drop_expressions` (and
`has_pending_emittable_drop`, which decides whether the while condition's
flush runs at all) skip a drop whose target is a temp missing from
`declared_c_var_names` (the guard against drops of elided temps). Two shapes:

- **Scrutinee** (`match(io.await(f, io).s, …)`): the temp has no task slot,
  nothing declares it, and its drop is skipped.
- **While condition**: the temp has a task slot (the condition is re-evaluated
  after every iteration's suspension), and the result was stored into it, but
  the temp was still never declared as a C local, so the condition flush
  (`_emit_while_cond_break`) found nothing emittable and the slot was never
  released.

A whole-value consumer (`x := io.await(…)`, a whole-value scrutinee) takes the
value over, and a destructuring re-declares the operand under its temp's name,
which is why those shapes were clean.

## Fix

`_bind_await_result_to_temp` (`src/codegen/async/state_machine.yo`, formerly
`_store_await_result_into_temp_slot`): when the result is kept in a C local
(no later await in the statement can suspend before it is consumed) and holds
an RC or move-only value, the await's owning temp is declared as a C local
under its own name (`T <temp> = __yo_await_value<k>;`, through
`get_variable_type_string`, which registers it), stored into its task slot
when it has one, and the await's code is the temp's name. This is the
convention every call temp follows (`T tv = <call>;` then
`_store_temp_var_to_state_machine_if_needed`) and what the synchronous await
(`generate_await`) already did. The temp's scheduled drop now runs: the
scrutinee's flush releases it once the arms read their own subject, and the
while condition is materialized into a bool and its drops flushed before the
branch, once per evaluation. A result kept in a task field
(`f(await a, await b)`) is unchanged: a C local copy would not survive the
later await.

## Tests

`tests/async/sm_ownership.test.yo`: "an await result read by a field-reading
match scrutinee is released" (fused and not fused; released 0 of 2 before, 2
after) and "an await result read by a while condition is released on every
evaluation" (two loops, 7 evaluations; released 0 of 7 before, 7 after). The
reproducers above are clean under `--sanitize address` with
`ASAN_OPTIONS=detect_leaks=1` (39 B / 156 B leaked before).

