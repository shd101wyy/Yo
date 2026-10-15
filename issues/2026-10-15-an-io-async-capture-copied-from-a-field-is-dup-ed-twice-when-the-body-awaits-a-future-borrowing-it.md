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

With leak verdicts on (`YO_TEST_LEAK_VERDICT` unset), A5's `tests/async/channel.test.yo` fails 6 of 22 (develop: 1, `Test channel Stream combinators`, the `for_each` family of `issues/local-leak-verdicts-fail-28-async-tests-ci-cannot-see.md`). The new failures are every test that awaits `Receiver.recv`: "async Sender/Receiver deliver values in order", "async Channel.pair hands back both halves over one channel", "async: buffered values arrive before the disconnect", "async: dropping the last Sender resolves a SUSPENDED recv as Disconnected", "async: producer tasks with cloned Senders fan in, and the last one closes". The fix lands the reproducer above as a `pragma(Pragma.NeedsLeakVerdict)` test.
