# A call's argument temp inside an `if` condition operator is never released

> Found 2026-09-25 by the holder census (`HOLDER_DEEP` plus the refcount event
> log): after #888, `check src/main.yo` still left 1.1 M unreferenced `String`
> buffers at exit. 16 K of them came from one line of `_mg_canon`
> (`src/expr_info.yo`): `if(!p.starts_with(String.from("/")), …)`. Fixed in
> the same PR as this doc.

## Reproduction

```rust
ok :: (fn(p : Probe) -> bool)((p.n > i32(0)));
if(!(ok(Probe(n : x))), { … });          // Probe leaked
if((ok(Probe(n : x)) == false), { … });  // Probe leaked
if(ok(Probe(n : x)), { … });             // released
b := !(ok(Probe(n : x)));                // released
```

The emitted C released the argument temp only on the effect-escape path.

## Root cause

A call nested inside the condition's operator records its argument temps'
drops on the CONDITION node (the statement-level expression), not on its own
call node, so the call emitter's post-call flush skips them. `cond`
(`src/codegen/exprs/cond.yo`) pushed the condition's drops into the pending
set while rendering it (for short-circuit branches), but never flushed them
afterwards. A direct call condition was fine, because its drops live on its
own node.

## Fix

`_emit_cond_if_head` (both the first condition and every `else if`): after
rendering the condition, if an emittable drop is still pending on the
condition node (`has_pending_emittable_drop`), the condition is materialized
into a `bool`, the condition's drops are flushed, and the `if` branches on
the bool.

## Test

`tests/rc.test.yo`: "a call argument under ! or == in an if condition is
released" (Dispose counter).
