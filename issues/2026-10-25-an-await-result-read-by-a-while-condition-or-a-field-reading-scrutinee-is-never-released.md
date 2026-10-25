# An await result read by a `while` condition or a field-reading scrutinee is never released

**Severity:** S1 — unbounded leak: inside an `io.async` body, the result of an
`await` consumed through a field read (`(await f()).n < 3` as a loop condition,
`match((await f()).s, …)` as a scrutinee) is never dropped, so every evaluation
leaks the value it holds (a `String` payload: 39 bytes per evaluation for the
scrutinee, 156 bytes for a three-iteration condition).

**Status:** open. Present on develop `b97be9b48` and the v0.2.70 seed;
`fix/cond-scrutinee-temps` (the while-condition / step / scrutinee flush branch)
does NOT cover it — the branch's flushes run, but the await result's own drop is
never scheduled on the condition/scrutinee node in a state machine. Found
2026-10-25 probing review item (d) of that branch (sm-slot coverage).

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
