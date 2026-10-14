# Is the async `Mutex(T)` a copyable handle over `Rc` state, or a move-only value shared as `Rc(Mutex(T))`?

**Kind:** design question: an open decision, not a defect. Filed 2026-10-14
by V3 async A5 (`plans/VALUES_BY_DEFAULT.md` §3.13), which had to pick one
to land.

## The question

§3.13 A5 says: "The async `Mutex(T)` is move-only, and tasks share it as
`Rc(Mutex(T))`." §3.13 A2 says the borrowing futures it enables include "the
async `Mutex.lock(self : &Self, io)`". A2's amended `Rc` rule (2026-10-07,
audit #1251 finding 1) then rejects, with E0909, every future that borrows a
place crossing an `Rc`/`Arc` deref, a shared `&` borrow included, because no
run-time mark is held across the suspension.

The three lines cannot all hold. A move-only `Mutex` whose `lock` future
borrows `self`, reached through an `Rc`, is exactly the rejected shape.
Measured 2026-10-14 with v0.2.62:

```yo
M :: struct(_locked : bool, _n : i64);
impl(M, Dispose(dispose : (fn(self : &Self) -> unit)(())));
impl(
  M,
  lock : (fn(self : &Self, io : Io) -> Impl(Future(unit)))(
    io.async({ &self }(io : Io) => {
      _x := self._n;
      return(());
    })
  )
);
main :: (fn(io : Io) -> unit)({
  m := rc(M(_locked : false, _n : i64(1)));
  m2 := m;
  t := io.async({ m2 }(io : Io) => {
    io.await(m2.lock(io), io); // E0909: borrows `(m2.(*))` across its suspension
    ()
  });
  io.await(t, io);
});
```

E0909's own help names the way out: "pass the handle and derive the place
inside the future". A `lock` future that holds the handle instead of
borrowing the mutex borrows nothing, so it is first-class.

## What A5 landed

The async `Mutex(T)` is `struct(_st : Rc(_MutexState(T)))`, the shape A5
gives the async `Channel(T)` ("keeps its state behind `Rc`"):

- a copy of a `Mutex` is another handle on the same lock, which is how
  several tasks contend for one;
- `lock`'s and `with_lock`'s futures hold their own copy of the handle, so
  they borrow nothing, a task may own them, and they work through an
  `Rc(Mutex(T))` too;
- the methods take `self : &Self` and write the state through the `Rc`.

Tests: `tests/async/mutex.test.yo` ("a Mutex copy shares the lock with a task
that owns it", "a Mutex shared through an Rc locks across an await").

## The alternatives

1. **The landed shape: a copyable handle over `Rc` state.** Sharing is a
   copy today, and an explicit `clone()` once V2c makes `Rc` copies explicit
   (decision 17). Same as `Channel(T)`, and as `std/sync`'s `Channel(T)`
   ("the fused MPMC handle, stays copyable through its `Arc`").
2. **A move-only value, shared as `Rc(Mutex(T))`, whose `lock` future holds
   the `Rc`.** `lock` would have to be a method on `Rc(Mutex(T))` (or take
   `self : &Rc(Self)`), which decision 32's wrapper/payload name rule and
   auto-deref make awkward, and every other method keeps `&Self`. The
   `Mutex` itself would need a `Dispose` with no work to do, only to make it
   move-only.
3. **A move-only value whose `lock` future borrows it**, used only through
   `{ &m }` capture lists in awaited, never spawned, tasks. Spawned tasks
   could not share a lock at all, which removes the reason the async mutex
   exists (a critical section spanning awaits across tasks).

## Recommendation

Keep alternative 1, and amend §3.13's A5 line to "The async `Mutex(T)` keeps
its state behind `Rc`, like the async `Channel(T)`; its futures hold a copy
of the handle". It is the only shape that keeps `Rc` sharing and spawned
tasks working under A2's `Rc` rule without an inert `Dispose`. When V2c makes
an `Rc` copy explicit, copying a `Mutex` becomes `m.clone()` with no other
change.
