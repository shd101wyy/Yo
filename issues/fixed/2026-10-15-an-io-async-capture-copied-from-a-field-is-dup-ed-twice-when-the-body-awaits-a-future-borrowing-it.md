# An io.async capture copied from a field is dup'ed twice when the body awaits a future borrowing it

**Severity:** S1 — the capture's `Rc` is incremented once more than the state machine's dispose releases, so its target is never freed; since #1379 every async channel whose `Receiver.recv` is called leaks its shared state (and every value still buffered in it), once per channel, without bound in a program that creates channels.

**Found:** 2026-10-15, landing #1379 (V3 async A5). Its Tier 1 ran with `YO_TEST_LEAK_VERDICT=0`, as CI does; the same files with leak verdicts on (the local default) report the leak. Develop's compiler has the bug too (reproduced with a develop build at `0684c9c40`); A5 only exposes it in std, because its `Receiver.recv` became `io.async({ ch : self._ch }(io : Io) => { got := io.await(ch.recv(io), io); … })`.

## Reproducer

```yo
S :: struct(x : i32);
Ch :: struct(_st : Rc(S));
impl(Ch,
  get : (fn(self : &Self, io : Io) -> Impl(Future(i32)))(
    io.async((io : Io) => {
      y := self._st.x;
      return(y);
    })
  )
);
Rx :: struct(_ch : Ch);
impl(Rx,
  get : (fn(self : &Self, io : Io) -> Impl(Future(i32)))(
    io.async({ ch : self._ch }(io : Io) => {
      got := io.await(ch.get(io), io);
      got
    })
  )
);
main :: (fn(io : Io) -> unit)({
  r := Rx(_ch : Ch(_st : rc(S(x : i32(1)))));
  f := r.get(io);
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system -o r && ./r`:

```text
SUMMARY: AddressSanitizer: 12 byte(s) leaked in 1 allocation(s).
```

The same with `v := io.await(r.get(io), io);` in place of `f := r.get(io);` leaks the same 12 bytes. Without the inner `io.await(ch.get(io), io)` (the body reads `ch._st.x` directly) nothing leaks.

Through std (A5's tree), `rx := Channel(i32).receiver(usize(8)); tx := rx.sender(); f := rx.recv(io);` leaks 176 bytes in 5 allocations: the 64-byte `_ChannelState` and its buffers.

## Root cause (from the emitted C)

The builder of `Rx.get`'s future dups the capture twice and keeps only one of the two:

```c
__yo_t_Ch _tmp = __yo_v_self._ch;
__yo_t_Ch temp_dup_struct_0 = _tmp;
temp_dup_struct_0._st = __yo_incr_rc(temp_dup_struct_0._st);   // dup #1
temp_dup_struct_0;                                              // ...discarded
__yo_cap cap = { .__yo_v_ch = _tmp };
__yo_t_Ch temp_dup_struct_1 = cap.__yo_v_ch;
temp_dup_struct_1._st = __yo_incr_rc(temp_dup_struct_1._st);   // dup #2, kept
cap.__yo_v_ch = temp_dup_struct_1;
```

The state machine's dispose releases the capture once (`if (!sm->__yo_mv___capture___yo_v_ch) __yo_decr_rc(...)`), so dup #1 is never released. The discarded `temp_dup_struct_0;` statement is the capture-list initializer's own copy of `self._ch`; when the body does not lend the capture to an awaited future, it does not appear, so the extra dup is tied to that lend.

## Tests that observe it

With leak verdicts on (`YO_TEST_LEAK_VERDICT` unset), A5's `tests/async/channel.test.yo` fails 6 of 22 (develop: 1, `Test channel Stream combinators`, the `for_each` family of `issues/fixed/local-leak-verdicts-fail-28-async-tests-ci-cannot-see.md`). The new failures are every test that awaits `Receiver.recv`: "async Sender/Receiver deliver values in order", "async Channel.pair hands back both halves over one channel", "async: buffered values arrive before the disconnect", "async: dropping the last Sender resolves a SUSPENDED recv as Disconnected", "async: producer tasks with cloned Senders fan in, and the last one closes". The fix lands the reproducer above as a `pragma(Pragma.NeedsLeakVerdict)` test.

## The same builder retained a moved capture (`{ inner }`)

`_build_async_capture_struct_literal` (`src/codegen/exprs/async.yo`) gave every capture field that did not match one of the closure's own `___dup` expressions a retain of its own (`_rc_field_retain_line`). Two kinds of field reached that wrap without needing it:

- **A capture-list entry.** Decision 35 evaluates each by-value entry as a field store (`set_expr_as_needs_to_call_dup`), so a copy already carries its dup on the initializer and a move carries none; the closure has no capture dups at all. A renamed entry (`{ ch : self._ch }`, `{ m : t }`, `{ m : String.from("x") }`) emitted its initializer's dup AND the wrap's retain: the double dup above. A same-name entry (`{ s }`) skipped its initializer and took the wrap's retain instead, which is the same count for a copy but one too many for a move.
- **A moved capture.** A future is move-only (§3.13 A1), and so are wakers, parks and channel halves since A5. `{ inner }` consumes `inner` (`generate_captured_variable_dup_expressions` moves a capture that is not implicitly copyable: no dup, and the owner's scope-end drop is skipped), so the retain was a reference nobody released. `outer := io.async({ inner }(io : Io) => { return(io.await(inner, io)); })` leaked `inner`'s 80-byte state machine; the coordinator's `aaleak.yo` measured it on `0684c9c40` and seed v0.2.63.

## Fix

Each field's reference is now taken exactly once (`_build_async_capture_struct_literal`):

- a capture-list entry, under its own name or a new one, is its evaluated initializer through `emit_deferred_dup_or_code`, which emits the copy's dup or nothing for a move, and takes no retain;
- an implicit capture that is not implicitly copyable (`type_requires_explicit_copy`) and has no dup of its own was moved, and takes no retain;
- every other implicit capture read by name is a copy and is retained once, as before.

A fused await site builds its capture after the wrapper's own emission took the dups off the closure, so `DeferredAsyncBlock` now carries them (`capture_dups`) for the same decision.

Tests (in-language, so CI sees them with leak verdicts off): `tests/async/sm_ownership.test.yo`, "a renamed capture copied from a field is retained once when the body awaits through it" (this doc's reproducer with a `Drop` counter), "a renamed by-value capture of a parameter or a fresh value is retained once", "a future moved into a capture list is released by the future that owns it", "a future and a copy captured by a nested io.async inside a state machine are each released once". Each of the first three fails on develop `b0c4630d3`.

With leak verdicts on, `tests/async/channel.test.yo` goes from 6 failures to 1 (the remaining one, "Test channel Stream combinators", is `timeout`'s join wait: `issues/fixed/2026-10-16-the-thread-exit-release-leaks-a-join-wait-and-a-waker-token-posted-after-the-last-tick.md`), `tests/async_await.test.yo` from 3 to 0, `tests/async_future_parameter.test.yo` from 2 to 0, `tests/async/waker.test.yo` from 3 to 0 and `tests/async/join_handle.test.yo` from 1 to 0.
