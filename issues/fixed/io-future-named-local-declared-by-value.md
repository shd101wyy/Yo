# IoFuture named local declared as the struct BY VALUE (C compile error)

**Found**: 2026-08-27 implementing `std/async`'s `timeout()` (STD_API_AUDIT §7
P0 item 6). **Fixed**: same day, `src/codegen/utils/index.yo`
(`get_type_string`'s unresolved-SomeT extern branch), on the
`s3/async-combinators` branch.

## Symptom

Binding the result of an io-future-returning call to a NAMED local in a sync
function:

```rust
deadline := IO_timer.sleep(u64(5));
s := io.state(deadline);
```

emitted C that declared the TEMP correctly but the local by value:

```c
__yo_io_future_t* _file____priv_temp_8549 = yo_id_7097(...);  // call temp: pointer
__yo_io_future_t deadline = _file____priv_temp_8549;          // local: BY VALUE
int __raw_state_... = deadline->state;                        // pointer use
if (deadline != NULL) { __yo_decr_rc((void*)deadline); };     // pointer use
```

→ `error: invalid operands to binary expression ('__yo_io_future_t' ... and
'void *')` etc. Every USE site is pointer-shaped; only the declaration was not.

## Root cause

`get_type_string` lowers an extern-resolved FUTURE SomeT to `<name>*` (TS
utils/index.ts:660-668, "extern futures are heap-backed") — but only through
two channels: a `resolved_concrete` cell, or a `FutureTraitT` in the SomeT's
own `required_trait_types`. A named local's variable type has COLLAPSED to the
bare extern SomeT (`__yo_io_future_t`, no requirements, no resolution cell), so
it fell into the plain `extern("Yo", X : Type)` opaque-typedef branch and got
the unstarred name — while the call-temp's type (the function's return type)
still carried the resolution and got the star.

## Fix

In the unresolved-extern branch, the runtime's contractual future type name is
recognized directly: `snm == "__yo_io_future_t"` → `<name>*`, exactly as the
same function's unregistered-extern fallback already hard-codes that name.
(`_some_t_requires_future(t)` is also consulted for any future-requiring alias
SomeT that reaches this branch.)

## Consequence

With the declaration fixed, the scope-end auto-drop of such a local COMPILES —
and is itself wrong for a still-armed timer. That hole is filed separately and
stays OPEN: `issues/pending-io-future-local-drop-uaf.md`. std avoids the shape
entirely (`timeout()` uses a spawned deadline task).
