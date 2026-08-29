# `Dyn(trait)` whose method returns `Impl(Future(...))` splices a struct definition into the middle of the vtable typedef

**Status: FIXED** (2026-08-29, `src/codegen/types/generation.yo`
`generate_dyn_declaration`: the vtable's member lines are collected FIRST —
`_dyn_vtable_method_line` returns the line instead of emitting it — so any
on-demand typedef that resolving a member type triggers lands before the
`typedef struct … {` opens; the header, members and footer are then emitted
together). Regression test: `tests/dyn.test.yo` "Dyn(trait) with a
Future-returning method dispatches through the vtable"; repro
`issues/repros/dyn-trait-future-method-vtable-splice.yo`. Found 2026-08-25 by the STD_API_AUDIT D5 survey. Blocks one of
the two spellings of D5's "BufReader/BufWriter wrap ANY Reader/Writer".

## Symptom

```rust
Wrap :: ref(struct(_inner : Dyn(AR)));   // AR.read : (fn(self, io) -> Impl(Future(usize, IoExn)))
// constructed with dyn(x)
```

`yo check` is green; `yo compile --release` fails at clang with 7 errors:

```
p5bin.c:522:1:  error: type name does not allow storage class to be specified
p5bin.c:522:32: error: field has incomplete type 'struct __yo_t22_struct'
p5bin.c:533:3:  error: unknown type name '__yo_t22'
p5bin.c:5044:7: error: use of undeclared identifier '__yo_t22'
```

The emitted C shows the cause — the on-demand `Future` struct is emitted INTO the
middle of the still-open vtable typedef:

```c
typedef struct __yo_t2_vtable_s { // Vtable for dyn(AR)
  uintptr_t __yo_type_id;
typedef struct __yo_t22_struct __yo_t22;      // Forward declaration (on-demand)
struct __yo_t22_struct {                       // Generic Future interface
  ...
};
  __yo_t22* (*read)(void* self, __yo_t4 io);
} __yo_t2_vtable;
```

## Root

An emission-ORDERING bug: building the vtable's member list requests the return
type on demand, and that request emits its typedef immediately — while the
enclosing struct body is open. The on-demand emission needs to be hoisted ahead
of the vtable, or deferred until the vtable body is closed.

Unlike most codegen bugs in this family this one is LOUD (clang rejects it), so
it cannot ship silently — but it does make the feature unusable.

## Where to look

`src/codegen/` — vtable emission and the on-demand type emitter.
