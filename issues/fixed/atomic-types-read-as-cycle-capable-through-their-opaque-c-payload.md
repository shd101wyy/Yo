# `AtomicI32` (and every struct holding one) reads as cycle-capable, because its opaque C payload is a SomeT

**Found:** 2026-09-26, implementing `plans/PARALLELISM_SOUNDNESS.md` Phase 2 (a `^v` test over a
struct holding a shared `AtomicI32` counter).
**Status:** FIXED 2026-09-26 (the Phase 2 PR).
**Class:** wrong answer from a type predicate (over-conservative): valid `^v` rejected at compile
time, and the affected types tracked by the cycle collector for nothing.

## Repro

```rust
{ AtomicI32 } :: import("std/sync/atomic");
comptime_print(Type.can_form_rc_cycle(AtomicI32));   // printed `true`
```

and a `^v` over `ref(struct(items : ArrayList(i32), hits : AtomicI32))` failed with
"Cannot isolate value of type containing Rc type that can form cycles".

## Root cause

`AtomicI32 :: atomic(ref(struct((*) : atomic_int)))`, and `atomic_int` comes from
`c_include("<stdatomic.h>", atomic_int : Type, ...)`: an opaque C type, represented as a SomeT
placeholder registered in `g_extern_type_names`. `_type_refs_back_to_cyclic`
(`src/types/utils.yo`) answers `true` for EVERY SomeT ("could resolve to anything"), so the one
field of every atomic reads as a possible back-edge.

## Fix

The SomeT arm answers `!is_extern_type_name(name)`: an extern/`c_include` opaque type is a C value
that holds no Yo reference and cannot close a cycle; a genuine type variable stays conservative.
(A cycle through an opaque handle was never collectable anyway: the collector cannot traverse
into one.) Test: `tests/iso.test.yo` "an AtomicI32 cannot form a reference cycle" (a module-level
`Type.can_form_rc_cycle(AtomicI32)` asserted false) and "^ does not descend into an atomic object".
