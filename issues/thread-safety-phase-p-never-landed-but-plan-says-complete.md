# `plans/THREAD_SAFETY.md` says "Complete. All 14 phases implemented" — Phase P never landed, and the hole it was to close is open

**Status: OPEN.** Found 2026-08-25 by the STD_API_AUDIT D7 scoping survey and
verified empirically on `develop` at `340a9e735`.

## The claim

`plans/THREAD_SAFETY.md:3`:

```
**Status:** Complete. All 14 phases implemented.
```

## The reality

Phase P — "**Field visibility: `_`-prefix is file-private**… A field whose name
starts with `_` is accessible only within the file that defines its containing
type" (`:18`) — is not enforced. A file outside `std/sync` reads a `Mutex`'s
interior field and the compiler is happy:

```rust
{ Mutex } :: import("std/sync/mutex");
main :: (fn(io : Io) -> unit)({
  m := Mutex(i32).new(i32(7));
  println(m._value);          // reaches straight into the synchronized interior
});
```

```
$ yo check probe.yo
check: probe.yo — evaluator OK          (rc=0)
```

Reproducer: `issues/repros/phase-p-field-privacy-not-enforced.yo`.
Nothing in the document ever marks Phase P landed
(`grep -n "Phase P" plans/THREAD_SAFETY.md` finds only its specification and
the vectors that depend on it).

## Why it matters

The plan's own threat table records the consequence. Vector **27** (`:123`):

> Unsynchronized **read** of an atomic-object's interior field (`mutex._value`
> racing with `with_lock`'s pragma'd writer) — **Phase P** (field visibility).
> Closed by promoting `_`-prefix to enforced file-private… Phase O (the write
> rule) is uniform across all field names; **Phase P is what closes the _read_
> side of the bypass**.

So the document marks vector 27 CLOSED on the strength of a phase that does not
exist. Any safe (non-pragma'd) user file can read a `Mutex`/`RwLock`/`Once`
interior while another thread mutates it under the lock — a data race the plan
asserts is impossible. `:151` lists the same gap: "Synchronized-interior fields
(`mutex._value`, `arraylist._capacity`, etc.) are accessible from any file by
convention only. → **Phase P**."

Beyond `sync`, the phase was also to close ordinary encapsulation holes
(`string._ptr`, `arraylist._capacity`), so the whole `_`-prefix convention across
`std/` is convention-only today.

## What to do

1. Correct the status line — the document is the input everything downstream
   trusts, and a false "Complete" is worse than an open TODO.
2. Re-open vector 27 in the table.
3. Decide whether to implement Phase P (a general language rule, not a
   thread-safety feature) or to record it as deliberately deferred with the
   residual risk stated.

Related: the same survey found `plans/STD_API_AUDIT.md` stale in ~10 verified
places (rows marked open that are done, deletions recommended for documented
public API, a rename listed for a module already deleted).
