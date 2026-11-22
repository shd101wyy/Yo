# An `Arc` of a generic type with an explicit marker impl is rejected inside a type function

**Severity:** S2 — a valid generic type holding `Arc(Mutex(T))` (or an `Arc` of any generic type whose `Send`/`Sync` comes from an explicit generic impl) is rejected at its definition with E0602, so the Rust-shape sharing `std/sync` teaches could not appear in a generic struct.

**Status:** fixed 2026-11-21 (the `std/sync` values reshape, VERDICTS-70 row 4).

## Reproducer

```yo
{ Mutex } :: import("std/sync/mutex");
Shared :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(
  struct(_m : Arc(Mutex(T)))
);
main :: (fn() -> unit)({
  _s := Shared(i32)(_m : Arc.new(Mutex(i32).new(i32(1))));
  ()
});
export(main);
```

```text
error[E0602]: Type Mutex(T : (Send)) does not implement required trait Send.
  |
3 |   struct(_m : Arc(Mutex(T)))
```

The same with a user type: `P(T) :: struct(_p : *usize)` with `impl(generic(T : Type), P(T), Send())` and `impl(generic(T : Type), P(T), Sync())`, then `H(T) :: struct(_a : Arc(P(T)))`. A type whose markers are DERIVED from its fields (`struct(_n : usize)`) was accepted; only an explicit generic impl failed. Reproduced on develop `50928986a` with the old (atomic-cell) `Mutex` too.

## Root cause

A type function's body is evaluated with its parameter abstract (`T : (Send)`), and `Arc(V)`'s `where(V <: (Send, Sync, Escapable))` is checked there (`src/evaluator/calls/helper.yo`, the marker where-clause pass). The pass defers a bound type that still carries a type variable, but asked `get_all_some_types`, which walks fields and elements and NOT an instantiation's type arguments. `Mutex(T)` (its `T` sits behind a `Box`'s pointer) and `P(T)` (no field mentions `T`) carry `T` only there, so the pass judged them as concrete. The generic impl matcher (`try_match_generic_impl`) then could not bind the impl's `T` to the abstract `T` outside a definition-time trial (`all_bound=false` under `YO_DEBUG_DISPATCH=1`), so the impl did not match and the check failed.

## Fix

The deferral asks `type_mentions_some_type`, the walk that includes type arguments (it already gates decision 36's open-pattern query). The instantiation (`Shared(i32)`) is concrete and is checked there.

Test: `tests/send-sync.test.yo`, "a generic type holding an Arc(Mutex(T)) is accepted and judged at its instantiation" (E0602 before, passes after).
