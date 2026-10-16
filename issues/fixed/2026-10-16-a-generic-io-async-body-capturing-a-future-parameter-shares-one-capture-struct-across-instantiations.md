# A generic io.async body capturing a future parameter shares one capture struct across instantiations

**Severity:** S2 — a generic function whose `io.async` body captures its `Impl(Future(T, E))` parameter fails to compile when it is called with two futures of one generic producer at different `T` (`timeout(h1.join(io), …)` and `timeout(h2.join(io), …)` for an `i32` and a `bool` task): the second instantiation reuses the first's capture struct, an evaluator unify error or invalid C.

**Status:** FIXED 2026-10-16 on `feat/vbd-v3-a4-future-operands` (VBD V3 A4), which found it: `std/async`'s `timeout` and `select` now take futures, and `tests/net/tcp.test.yo` times out two join futures of different result types.

## Symptom

```yo
{ assert } :: import("std/assert");
{ timeout } :: import("std/async");
{ Duration } :: import("std/time/duration");
main :: (fn(io : Io) -> unit)({
  h1 := io.spawn(io.async((io : Io) => i32(3)), io);
  r1 := io.await(timeout(h1.join(io), Duration.from_millis(i64(500)), io), io);
  h2 := io.spawn(io.async((io : Io) => true), io);
  r2 := io.await(timeout(h2.join(io), Duration.from_millis(i64(500)), io), io);
  assert(r1.is_ok() && r2.is_ok(), "both in time");
});
export(main);
```

```text
error[E0601]: Cannot unify incompatible types: "i32" and "bool"
   --> std/async/index.yo:438:23
```

The same shape in user code (a generic `wrap(fut)` whose `io.async({ fut }(io : Io) => …)` awaits `fut`, called with two such join futures) reaches C and clang rejects it: `incompatible pointer types initializing '…89204496961865559763_state_t *' with an expression of type '…89204496961865559761_state_t *'`, one capture struct field typed with the first instantiation's state machine. Seed v0.2.63 does the same.

Two futures from different `io.async` literals do not collide, nor does one producer used twice at one `T`.

## Root cause

`create_capture_type_and_value` (`src/evaluator/utils/closure.yo`) reuses a capture struct by a key built from the closure's position and each field's `type_to_string`, plus, for a `SomeT` field, the `type_to_string` of its resolution. Both join futures are the one `io.async` of `JoinHandle(T).join` and print alike (`Impl(Future(Option(T), Io))`, with the binder's name), so both instantiations of `timeout`'s body got one key, one struct and one closure.

## Fix

The key also carries the `type_key` of the end of the field's resolution chain, the C identity codegen names the state machine by, which differs between the two instantiations.

## Verification

`tests/async/combinators.test.yo` "A4: timeout over join futures of two result types" (an `i32` and a `bool` join under `timeout`, then under `select`) fails to compile before the fix and passes after; `tests/net/tcp.test.yo` (two `timeout(….join(io), …)` calls) compiles again.
