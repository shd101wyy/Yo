# std/time's read-only methods (and `Array.len`) take `self : &mut Self`, so an unmarked `Duration` cannot call them

**Severity:** S2 — under decision 47 step 2 (Generation A) a valid program is rejected: `d := t.elapsed(); d.as_secs()` is E0917 unless `d` is declared `mut(d)`.

**Status:** fixed 2026-10-17 on `feat/vbd-d47-locals-gena`, found by the
`yo fix --migrate mut-bindings` sweep over `tests/`.

## Symptom

27 methods in `std/time/duration.yo`, `std/time/instant.yo` and
`std/time/datetime.yo` only read their receiver, but they were declared
`self : &mut Self`. Examples are `Duration.as_secs`, `as_millis`,
`subsec_nanos`, `is_zero`, `add` and `sub`, `Instant.elapsed` and
`duration_since`, `SystemTime.as_unix_secs`, and `DateTime.to_unix`,
`day_of_week` and `add`. Decision 42 had rewritten the older spelling
`mut(self) : Self` to `&mut Self`. Before decision 47 that cost nothing,
because any binding could be lent `&mut`. Decision 47 makes a `&mut self`
call one of the four writes, so this program is rejected outside std:

```yo
{ Duration } :: import("std/time/duration");
main :: (fn() -> unit)({
  d := Duration.from_millis(i64(1500));
  println(d.as_secs()); // E0917: Cannot lend `&mut` (the receiver of a `self : &mut Self` method) `d`
});
export(main);
```

The prelude's `Array(T, N).len` had the same receiver, so `a.len()` on an
unmarked array was rejected too. The migration sweep marked five
`.Ok(mut(d))` pattern bindings and several locals in
`tests/time/instant.test.yo` only so that they could call these getters.

## Fix

None of the 27 bodies writes `self`, and neither does `Array.len`, so each
receiver is now `self : &Self`. A `&Self` receiver accepts every call a `&mut Self` receiver
accepted. A scan of std for other `self : &mut Self` methods whose body neither writes
nor lends `self` found only `drop`, `index_mut`, `write` and `fill` (each
writes by design) and `Watcher`'s getters (`Watcher` is a `ref` handle, so its
callers need no marker).

## Test

`tests/mut_bindings.test.yo`, "a read-only std method needs no mut on its
receiver". It calls the getters and `add` on an unmarked `Duration` and
`elapsed` on an unmarked `Instant`, and `len` on an unmarked `Array`. It fails with E0917 before the fix and
passes after.
