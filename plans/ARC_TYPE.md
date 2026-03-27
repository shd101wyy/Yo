# Arc(T) — Atomic Reference Counted Shared Ownership

## Overview

`Arc(T)` is a compiler builtin type that provides **shared ownership with atomic reference counting**. It complements `Iso(T)` (unique ownership transfer) by enabling multiple threads to hold references to the same value.

| Property        | `Iso(T)`                           | `Arc(T)`                     |
| --------------- | ---------------------------------- | ---------------------------- |
| RC type         | Atomic                             | Atomic                       |
| Purpose         | Ownership transfer                 | Shared ownership             |
| Construction    | Requires unique ownership          | Free — wraps any value       |
| Copying         | Atomic dup                         | Atomic dup                   |
| Send            | Always                             | Always                       |
| Access          | `extract()` → Option(T) (one-shot) | `(*)` dereference (borrowed) |
| Cycle detection | Not supported                      | Not supported                |

## Motivation

Sync primitives (`Channel`, `Mutex`, `Cond`, etc.) are `object` types with non-atomic RC. They are thread-safe internally (protected by mutexes/condvars) but their RC is not. `Arc(T)` provides the atomic RC wrapper needed to share them across threads.

```rust
{ Channel } :: import "std/sync/channel";
{ Thread } :: import "std/thread";

ch := arc(Channel(i32).new(usize(10)));  // ch : Arc(Channel(i32))

t := Thread.spawn(() => {
  ch.(*).send(i32(42));   // Deref Arc, call Channel.send
});

val := ch.(*).recv().unwrap();
t.join();
```

---

## Design

### Type Definition

```typescript
// src/types/tags.ts
Arc = "Arc",

// src/types/definitions.ts
interface ArcType extends Type {
  tag: TypeTag.Arc;
  childType: Type;       // The inner type being arc-wrapped
  trait: TraitType;       // Contains ___dup (atomic), ___drop (atomic)
  env: Environment;
}
```

### Construction

```rust
// Explicit construction via Arc(T) type constructor
ch := Channel(i32).new(usize(10));
arc_ch := Arc(Channel(i32))(ch);   // ch moved into Arc

// Convenience helper function (like box() for Box)
arc_ch := arc(Channel(i32).new(usize(10)));  // arc_ch : Arc(Channel(i32))
```

The `arc()` helper function:

```rust
arc :: (fn(forall(T : Type), value : T) -> Arc(T))
  Arc(T)(value)
;
```

`Arc(T)(value)` moves `value` into the Arc. After construction, the original binding is consumed (like `own()`). The inner value's non-atomic RC stays at 1 — Arc's atomic RC manages the shared lifetime.

### Dereference via `(*)`

```rust
arc_ch := Channel(i32).new(usize(10));
arc_ch.(*).send(i32(42));      // Deref → Channel(i32), call send
arc_ch.(*).close();            // Deref → Channel(i32), call close
```

`arc.(*)` returns a **borrowed** reference to the inner value (ownership remains with Arc). This is the same borrowing semantics as pointer `.(*)` dereference — the result has `isOwningTheRcValue = false`.

**Safety note**: `(*)` dereference is "unsafe" in the sense that storing the result in a variable could bypass Arc's lifetime management. A safer alternative (for later):

```rust
// Future: exclusive access via closure
arc_ch.with((ch) => {
  ch.send(i32(42));
});
```

### Send Trait

```rust
impl(forall(T : Type), Arc(T), Send());
```

`Arc(T)` unconditionally implements `Send`, regardless of whether `T` implements `Send`. This is safe because:

- Arc's RC is atomic (thread-safe increment/decrement)
- The inner value's non-atomic RC stays at 1 (only Arc holds it)
- The inner value's data is accessed through the Arc only

### Channel Integration

`Channel.new` returns `Self` as before. Users wrap in Arc explicitly:

```rust
{ Channel } :: import "std/sync/channel";
{ Thread } :: import "std/thread";

// Single-thread: use Channel directly
ch := Channel(i32).new(usize(10));
ch.send(i32(42));

// Cross-thread: wrap in Arc
arc_ch := arc(Channel(i32).new(usize(10)));
t := Thread.spawn(() => {
  arc_ch.(*).send(i32(42));
});
val := arc_ch.(*).recv().unwrap();
t.join();
```

---

## RC Optimization

Arc uses the same Phase 1.5 dup/drop cancellation as regular Rc objects:

- `isOwningTheSameRcValueAs` tracking applies
- Dup/drop pairs are cancelled within the same scope
- The only difference: codegen emits `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic`

The evaluator treats Arc values identically to object values for ownership tracking. The distinction is purely at the codegen level.

---

## C Codegen

### Struct Layout

```c
// Arc struct — same as Iso but without the `extracted` flag
typedef struct {
  __yo_ref_header_t header;   // ref_count (used atomically), gc_mark, gc_flags, dispose_fn
  ChildType value;           // Inner value
} Arc_T_struct;
typedef Arc_T_struct* Arc_T;
```

### Constructor

```c
Arc_T __yo_create_arc_Arc_T(ChildType value) {
  Arc_T arc = (Arc_T)__yo_malloc(sizeof(Arc_T_struct));
  arc->header.ref_count = 1;
  arc->header.gc_mark = __YO_GC_UNMARKED;
  arc->header.gc_flags = 0;
  arc->header.dispose_fn = __yo_dispose_arc_Arc_T;
  arc->value = value;
  return arc;
}
```

### Dup / Drop (reuse existing atomic functions)

```c
// Same functions as Iso — already exist in the runtime:
void* __yo_incr_rc_atomic(void* ptr);      // atomic_fetch_add
void  __yo_decr_rc_atomic(void* ptr);      // atomic_fetch_sub, free on 0
```

### Dispose

```c
void __yo_dispose_arc_Arc_T(Arc_T arc) {
  // Drop the inner value (non-atomic, since only Arc holds it)
  ChildType___drop(arc->value);  // or __yo_decr_rc
}
```

### Dereference

```c
// arc.(*).send(42) compiles to:
Channel_i32_send(arc->value, 42);
```

`arc->value` is a direct field access — no function call, zero overhead. The inner value pointer is the same `object` pointer that `Channel` methods expect.

---

## Implementation Plan

### Phase 1: Type System Foundation ✅

**Files**: `src/types/tags.ts`, `src/types/definitions.ts`, `src/types/guards.ts`, `src/types/creators.ts`, `src/expr.ts`

1. Add `Arc = "Arc"` to `TypeTag` enum
2. Add `ArcType` interface (tag, childType, trait, env)
3. Add `isArcType()` type guard
4. Add Arc to `isRcType()` — returns true for Arc types
5. Add `Arc` to `BuiltinKeywords` in `src/expr.ts`
6. Add `createArcType()` factory with cache
7. Add Arc cases to: `typeToString`, `typeContainsRcType`, `typeOfType` (hierarchy), `areTypesCompatible`, `occursCheck`, `synthesizeTypes`

### Phase 2: Evaluator — Type Construction ✅

**Files**: `src/evaluator/calls/arc.ts` (new), `src/evaluator/exprs/_expr.ts`, `src/evaluator/calls/function.ts`, `src/evaluator/context.ts`, `src/evaluator/trait-checking.ts`, `src/evaluator/types/utils.ts`, `src/evaluator/builtins/rc-fns.ts`

1. Handle `Arc(T)` as a type constructor — when evaluating `Arc`, create an ArcType with the given childType
2. Handle `Arc(T)(value)` construction — create the Arc value, move inner value
3. Register `___dup` and `___drop` trait functions using atomic operations
4. Add `__yo_arc_dispose` builtin function + evaluator handler
5. Add `ArcType` to `SelfType` unions for code synthesis

### Phase 3: Evaluator — Dereference ✅

**Files**: `src/evaluator/exprs/property-access.ts`

1. Handle `.(*)` on ArcType — return borrowed reference to inner type
2. Set `isOwningTheRcValue = false` on the dereferenced result
3. Allow method chaining: `arc.(*).method()`

### Phase 4: Codegen ✅

**Files**: `src/codegen/exprs/arc.ts` (new), `src/codegen/types/generation.ts`, `src/codegen/exprs/drop-dup.ts`, `src/codegen/exprs/generation.ts`, `src/codegen/exprs/property-access.ts`, `src/codegen/types/collection.ts`, `src/codegen/utils/index.ts`

1. Emit Arc struct typedef (header + value field, no extracted flag)
2. Emit constructor function (`__yo_create_arc_*`)
3. Emit dispose function (`__yo_arc_dispose_*`) — drops inner value if RC type, no-op otherwise
4. Route Arc dup/drop to `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic` (same as Iso)
5. Emit dereference as `arc->value` field access
6. Track `arcTypes` in `CodeGenContext` (like `isoTypes`)

### Phase 5: Standard Library Updates ✅

**Files**: `std/prelude.yo`

1. Add `impl(forall(T : Type), Arc(T), Send())` — Arc implements Send
2. Add `arc()` helper: `arc :: (fn(forall(T : Type), own(value) : T) -> Arc(T)) Arc(T)(value);`
3. No changes to Channel or other sync primitives — users wrap in Arc when needed

### Phase 6: Testing ✅

Verified with ASAN — no memory leaks or errors:

1. Arc(i32) — primitive inner type, construct, deref, copy, drop
2. Arc(Counter) — object inner type, construct, deref, copy, drop
3. Method delegation via `.(*)` dereference
4. Pass Arc to functions (automatic dup/drop)
5. Direct `Arc(T)(value)` constructor and `arc(value)` helper

Still TODO:

- Arc + Thread: capture Arc value in thread closure
- Arc + Channel cross-thread: producer/consumer with `arc(Channel(T))`

---

## Open Questions

1. **`with` method for safe exclusive access** — Should we add `arc.with((inner) => { ... })` that provides a scoped borrowed reference? This prevents storing the dereferenced value. Can be added later.

2. **Cycle detection** — Arc values are excluded from thread-local cycle detection (same as Iso). This is fine for sync primitives which don't form cycles.

3. **`Arc(T)` where T is a value type** — Allowed. `Arc(i32)` is valid even though `i32` is already Send.

4. **Interaction with `Iso`** — Can you do `Iso(Arc(T))` or `Arc(Iso(T))`? Probably should be disallowed — both provide atomic RC, nesting is redundant.
