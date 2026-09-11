# `ArrayList(Waker)` inside `std/async/channel` loses its GC tracer

**Status:** OPEN. Found 2026-09-11 while rewriting the async `Channel` over
wakers (`plans/backlog/WAKER_BASED_SCHEDULING.md` stage 3). It blocks that
rewrite; the async `Mutex` half of the same stage landed, because the identical
construction works there.

## Symptom

Adding waiter queues of type `ArrayList(Waker)` to `Channel(T)` **and parking
on them** makes `ArrayList(T)`'s `Trace` impl fail to evaluate:

```
error: No matching call found with arguments:
(base.add)(i)
    --> std/collections/array_list.yo:862:30
    |
862 |             tracer.visit(base.add(i));
```

`base` comes from `match(self._ptr, .Some(base) => …)`, so it is `*(T)`, and
`add` is an unconstrained blanket impl on `*(T)` in the prelude. It resolves
everywhere else; here it does not, which says `base`'s element type is not
resolved to `Waker` at that point rather than that `add` is missing.

## Reproducer

`issues/patches/async-channel-over-wakers.patch` applied to
`std/async/channel.yo`, then any program that uses the channel:

```rust
{ Channel } :: import("std/async/channel");
main :: (fn(io : Io) -> unit)({
  ch := Channel(i32).new(usize(2));
  t := io.async((io2 : Io) => {
    _s := io2.await(ch.send(i32(5), io2), io2);
    v := io2.await(ch.recv(io2), io2);
    return(match(v, .Some(x) => x, .None => i32(-1)));
  });
  _r := io.await(t, io);
});
export(main);
```

## Bisected

Against `develop`'s `std/async/channel.yo`, adding pieces one at a time:

| what was added | result |
| --- | --- |
| the two `ArrayList(Waker)` FIELDS only | **ok** |
| fields + a `Park` in `recv` | **FAILS** |
| fields + a `Park` in `send` | **FAILS** |
| fields + both | **FAILS** |

So the fields alone are fine; parking on them is what breaks the tracer. And
it is not any of these, each ruled out by removing it and re-testing:

- the `Stream` impl on `Channel(T)` — removed, still fails;
- `Sender(T)` / `Receiver(T)` and their `Dispose`/`Clone` — removed, still fails;
- the `while(runtime(…))` wake-all helpers — replaced with single wakes, still fails;
- an `Acyclic()` impl on `Waker` — added, still fails;
- field ORDER in the struct — moved, no effect.

## The part that makes it a compiler bug rather than a std mistake

**A structurally equivalent module compiles and runs.** `Holder(T)` below has
the same fields, the same two async methods (one returning
`Impl(Future(Result(unit, T)))`, one `Impl(Future(Option(T)))`), the same
`Park`-and-suspend loop, the same `remove(usize(0))`, and even the same
`std/sys/timer` import — and it works:

```rust
Holder :: (fn(comptime(T) : Type) -> comptime(Type))(
  ref(struct(_buf : ArrayList(T), _cap : usize, _closed : bool,
             _sw : ArrayList(Waker), _rw : ArrayList(Waker)))
);
impl(generic(T : Type), Holder(T),
  put  : (fn(self : Self, value : T, io : Io) -> Impl(Future(Result(unit, T))))(…),
  take : (fn(self : Self, io : Io) -> Impl(Future(Option(T))))(…));
```

`std/async/mutex.yo` is the shipped version of the same thing — it holds an
`ArrayList(Waker)`, parks on it, and is green — which is why stage 3's mutex
half landed and the channel half did not.

## Two probes that narrow it a long way

**1. The element type is UNRESOLVED, not missing a method.** Replacing
`tracer.visit(base.add(i))` with `tracer.visit(base)` in the tracer changes the
error to:

```
error[E0605]: Type mismatch for parameter "slot":
- Expected: *(T)
- Got     : *(T)
    --> std/prelude.yo:242:31
```

Two different `T`s that print identically — the signature of a stale
substitution. `ArrayList(Waker)`'s `Trace` is being instantiated with the
element type still bound to `ArrayList`'s own generic parameter rather than to
`Waker`, so `*(T)` has no methods and `.add` cannot resolve. That is the
[[side-tables-stale-under-substitution]] family, not a missing impl.

**2. It only happens on the ASYNC path.** The same patched channel used
SYNCHRONOUSLY — `try_send`/`try_recv`, no `io.async` anywhere — gets past the
evaluator cleanly. (It then fails to LINK, for an unrelated reason worth its
own line: `Waker`'s `Dispose` calls `__yo_waker_release` and `wake` calls
`__yo_waker_wake`, and those externs are only emitted when the async runtime
is, so a program that holds a `Waker` without ever using `io.async` has no
definition for them. The channel's `close()` wakes waiters synchronously, so a
sync-only user of a waker-based channel would hit exactly that.)

So the trigger is: a cycle-capable type carrying an `ArrayList` of an RC'd
element, whose `Trace` is derived while the ASYNC transform is running. The
async `Mutex` does not hit it, which is the contrast to explain.

## Where to look

`tracer.visit(base.add(i))` is evaluated when the collector's `Trace` is
derived for `ArrayList(Waker)`. The failure is that `base`'s type is an
unresolved element type at that point — the "side-tables stale under
substitution" family. Two questions to answer first:

1. Is `ArrayList(Waker)`'s `Trace` being instantiated from a DIFFERENT context
   in the channel than in the mutex (a nested async capture struct, say), and
   does the element type survive that path?
2. Does the park inside the method body change WHEN the tracer is derived —
   i.e. is the derivation now happening during the async transform, before the
   element type is bound?

## Impact

`plans/backlog/WAKER_BASED_SCHEDULING.md` stage 3's channel half, and
therefore stage 4 (the combinators, which wait on channels). The async
`Channel` keeps its 1 ms timer tick until this is fixed — a millisecond floor
on every hand-off, capping a producer/consumer pair at ~1000 values/second.
The patch is kept in `issues/patches/` so the rewrite is not re-derived from
scratch once the tracer resolves.
