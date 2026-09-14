# A function taking an `Impl(Future(T, E))` PARAMETER emits the Future's typedef inside another struct — so `std/async` cannot grow a future-taking combinator

**Status:** OPEN.
**Found:** 2026-09-14, probing whether `plans/backlog/ASYNC_DEADLINE_COMBINATOR.md`'s
recommended **Option B** (`with_deadline` in `std/async`) is writable today.
It is not, and this is why.
**Pre-existing:** reproduces identically on the **v0.2.32 seed**, so it is not
new and not seed-gated — it has simply never been hit, because nothing in
`std/` takes a future as a parameter.
**Severity:** blocks an API shape the async library needs. Loud (a C compile
error), but `yo check` is green, so the error points at the user's program.
**Reproducer:** `issues/repros/an-async-closure-capturing-a-future-parameter-emits-a-nested-typedef.yo`

## Symptom

```rust
_take :: (fn(fut : Impl(Future(i32, Io)), io : Io) -> Impl(Future(i32, Io)))(
  io.async(e => e.io.await(fut, e.io))
);
```

```
error: type name does not allow storage class to be specified
error: field has incomplete type 'struct __yo_t_9416080281748826554_struct'
error: unknown type name '__yo_t_9416080281748826554'
```

`yo check` reports `— evaluator OK`.

## Root cause — an on-demand declaration flushed into an open struct body

The emitted C shows it directly. The closure's CAPTURE struct opens, and the
Future interface type's "on-demand" forward declaration is written into the
middle of it:

```c
struct __yo_t_10253227764582054840_struct { //  : <struct:capture_1648255385441334408>
typedef struct __yo_t_9416080281748826554_struct __yo_t_9416080281748826554; // Forward declaration (on-demand)
struct __yo_t_9416080281748826554_struct { // Generic Future interface for Future[Future](i32) Io : Io
  __yo_ref_header_t header;
  int state;  // 0 = cold, -1 = completed, -2 = aborted
  ...
};
  __yo_t_9416080281748826554* fut;   // the capture field that demanded it
};
```

A `typedef` is a storage-class specifier and is not legal inside a struct body
— hence the first error — and the nested `struct` definition is not what the
`fut` field then needs, hence the second and third.

So this is an emission-ORDERING bug, not a type-shape bug: the type itself is
correct and complete. The capture field is the FIRST use of the Future
interface type, the on-demand emitter writes the declaration at the point of
first use, and that point happens to be inside a struct currently being
emitted. It belongs before the enclosing struct.

Same family as the repo's existing note that codegen emits the `#include` set
BEFORE any body, so `add_c_include` from a value/expr generator is a silent
no-op: a declaration must be registered with the collection pass, not emitted
where it is discovered.

## Why it has never been hit

`Impl(Future(T, E))` appears as a parameter type in exactly one place in the
tree — `std/prelude.yo`'s BUILTIN declarations for `io.await`, `io.state` and
`io.spawn` (and their `__yo_io_*` twins). Those are compiler intrinsics, not
ordinary Yo functions, so they never go through this path. No `std/` function
takes a future; `plans/backlog/ASYNC_DEADLINE_COMBINATOR.md` already records
the consequence from the other side — "`join_all`, `race`, `any` and `timeout`
are all the same blocking-poll shape, and all take `JoinHandle`s rather than
futures — so there is nothing in `std/async` to compose with."

## What it blocks

`plans/backlog/ASYNC_DEADLINE_COMBINATOR.md` recommends "**B, then A**": add
`with_deadline` to `std/async` and re-express `std/http/client.yo`'s
`_fetch_deadline` over it. `with_deadline` must take the future it is racing:

```rust
with_deadline :: (fn(generic(T : Type), fut : Impl(Future(T, IoExn)), limit : Duration, io : Io)
  -> Impl(Future(Result(T, TimeoutError), IoExn)))
```

That signature hits this defect on its first line. **Option B is not writable
until this is fixed** — the doc's recommendation should be read as blocked, not
merely unstarted. Measured with a concrete (non-generic) `i32` future as well,
so it is not the `generic(T)` either.

Option A (hand-roll the race in `std/http/server.yo`) does not take a future as
a parameter and is unaffected.
