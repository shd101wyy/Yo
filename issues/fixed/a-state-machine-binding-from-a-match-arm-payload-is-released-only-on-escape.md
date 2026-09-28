# A state-machine binding from a `match` arm's payload is released only on escape

**Status: FIXED 2026-09-28** (`src/codegen/exprs/return.yo`). Found while
fixing `issues/fixed/an-awaited-match-scrutinee-is-never-released.md`.

## Reproduction

```rust
(g_d : i32) = i32(0);
P :: ref(struct(n : usize));
impl(P, Dispose(dispose : (fn(self : Self) -> unit)({ g_d = (g_d + i32(1)); })));
optp :: (fn(n : usize) -> Option(P))(Option(P).Some(P(n : n)));
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    io.await(yield(io), io);
    kept := match(
      optp(usize(5)),
      .Some(p) => p,
      .None => P(n : usize(0))
    );
    return(kept.n);
  });
  r := io.await(task, io);
  println(`r=${r} disposed=${g_d}`);   // r=5 disposed=0; expected 1
});
export(main);
```

The same body without the `io.await` (not a state machine) prints
`disposed=1`. An awaited scrutinee behaves the same.

## What the C shows

`kept` is a cross-boundary local (`sm->var_kept_<id>`). The arm `incr`s the
payload into it. The completion state releases the scrutinee temp but not
`kept`: the only `__yo_decr_rc(sm->var_kept_…)` is in the state machine's
dispose, under `if (sm->state == -2)` (escape). One reference leaks per
run.

## Expected

The completion state releases `kept` exactly once, like the synchronous
scope-end drop.

## Root cause

The drop is scheduled and reaches the completion state's pending-drop gate,
`_keep_pending_drop`. Its env path keeps a drop only if the target's C name
is on the emitter's block-scope stack (`declared_scopes`), which records
C *declarations*. A state-machine local hoisted into the struct is never
declared as a C local; it is `sm->var_<id>`. So the gate rejected it as out
of scope (a debug trace of the gate printed `kept noscope`). Every hoisted RC
local of a state machine whose body ends in an explicit `return(...)` was
released only on the escape path. A body with no `return` takes a different
path (`state_machine.yo`'s "Drop local variables before completion"), which
does not consult the gate.

## Fix

`_drop_target_is_state_machine_field` resolves the target the way
`_generate_sm_atom` renders it:
- the owner id for an alias binding, then the SSA remap;
- a match-arm destructure is a C local.

A local with an `sm->` field is in scope for the whole resume function, so
the env path keeps its drop. The escape path is unchanged: the SM's dispose
releases these fields at `state == -2`, and dropping them inline too would
be a double release.

## Test

"Test an awaited match scrutinee whose payload escapes is released once"
(`tests/async_await.test.yo`). It fails before the fix (exit 6, zero
disposals, with the leak verdict off) and passes after.
