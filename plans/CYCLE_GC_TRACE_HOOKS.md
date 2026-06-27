# Compositional cycle tracing (`Trace` hooks)

Status: PLANNED (2026-06-27). Both compilers (`src/` and `yo-self/`). Cycle tracing
is organized around a **mandatory** first-class `Trace` trait defined in
`std/prelude.yo` (§3.3): auto-derived for structs/enums, hand-implemented for every
RC-capable container (`ArrayList`, `HashMap`, …) and open to user containers.

## 1. The problem

The cycle collector (QuickJS-style trial deletion / Bacon–Rajan) is **correct given
one contract**: every object's `traverse_fn(obj, visit)` must call `visit()` on
*every* directly-referenced reference-counted (RC) child. The collector decrements
RC across internal object→object edges; objects left at RC=0 are garbage.

Our generated `traverse_fn` only walks **direct** reference fields. It does **not**:

- descend through a **value-enum-wrapped** reference — `next : Option(Self)`;
- descend through **container-wrapped** references — `items : ArrayList(Self)`,
  `m : HashMap(K, Self)`;
- visit **reference-enum** fields inside an embedded value-enum (the struct
  traverse's value-enum case filters reference-*struct* fields only).

A missed edge is **conservative**: the child's internal RC is never decremented, so
it looks externally referenced → false "live root" → never collected → **leak**. It
cannot free a live object (safe), but it leaks. Measured: `tracked 0→2→0` (TS) vs
`0→4→2` (yo-self) on a two-node ref-enum cycle — the `ENil` terminators leak.

**Real impact:** the Phase-4 self-host types are exactly these shapes —
`TypeValue.Struct.field_types : ArrayList(Self)`, `AstExpr.FnCall.args :
ArrayList(Self)`, `Option(Self)` everywhere. Their cycles cannot be reclaimed today.

## 2. This is NOT an algorithm change

QuickJS, Nim ORC, and our collector are all **the same Bacon–Rajan synchronous
trial-deletion algorithm**. The difference is purely *traversal completeness*:

- QuickJS hand-writes a `gc_mark` per built-in class (fixed type set → all complete).
- Nim ORC auto-generates a **`=trace` hook** per type that recurses through `object`
  fields, descends `Option`/`ref`, and **iterates `seq`/containers**.

So "adopt Nim's approach" = adopt **complete, compositional, compiler-generated
tracing**. We keep the collector and generate complete trace hooks. We do **not**
switch algorithms.

## 3. Design: a `Trace` contract realized as compositional traversal

### 3.1 Contract

`traverse_fn(obj, visit)` for an object visits every **direct managed child** of
`obj`, descending *inline* through value structure (value structs, value enums incl.
`Option`, tuples/unions) and *iterating* containers, but **stopping at managed
handles** (it `visit()`s them; the collector calls *their* `traverse_fn` later).

This is exactly Nim's `=trace`. We model it as a `Trace` contract:

- **Managed handle** (`ref(struct)`/`ref(enum)`, non-atomic) as a *field*: a single
  graph edge → `visit(field)`, stop (do not recurse — the collector will).
- **Value struct / newtype** as a field: recurse each field inline.
- **Value enum** (incl. `Option`) as a field: `switch(tag)` → recurse the active
  variant's fields. (Nullable-pointer-optimized `Option(handle)` collapses to the
  bare pointer → `visit(field)`.)
- **Tuple / union**: recurse each component inline.
- **Container** (`ArrayList`, `HashMap`, …): a managed handle, so `visit(field)`;
  the container's *own* `traverse_fn` iterates its element buffer.
- **Atomic ref / raw pointer / primitive / unit**: nothing.

### 3.2 The codegen primitive: `traverse_value`

A single recursive codegen helper drives everything:

```rust
// pseudo-signature (both compilers)
traverse_value(emitter, access_expr : String, ty : TypeValue, visited : Set, context)
```

It emits C that visits the managed children of the value at `access_expr`, applying
the table above and recursing on field/element types. `visited` (type-id set) guards
against unbounded *codegen* recursion on recursive value types (in practice
recursion stops at managed handles, which never recurse the codegen, but the guard
is kept for safety — mirrors `can_type_form_rc_cycle`).

Then:

- **struct `traverse_fn`** = `traverse_value(obj->field_i, field_i_ty)` for each
  runtime field.
- **enum `traverse_fn`** = `switch(obj->tag)` → per active variant,
  `traverse_value(obj->data.V.field_j, field_j_ty)` for each field.

This subsumes the current per-field logic and adds value-enum descent + tuples for
free, in one place used by both the struct and enum traverse generators.

### 3.3 The `Trace` trait — MANDATORY, defined in `std/prelude.yo`

Cycle tracing is organized around a first-class trait so that **every** type that
can transitively hold a managed reference participates uniformly and extensibly —
including user-defined containers. A container's elements live in a malloc'd buffer
(not named fields), so a field-walk cannot reach them; the container must expose its
own element iteration. The `Trace` trait is that contract:

```rust
// std/prelude.yo
Trace :: trait({
  // Visit every managed object directly held by `self`, descending inline through
  // value structure. `visit` is the collector's edge-registration callback,
  // type-erased to an opaque pointer (a C `void(*)(void*)`); never call it
  // directly — go through the `__yo_gc_trace_child` / `__yo_gc_visit` intrinsics.
  __yo_gc_traverse : (fn(self : Self, visit : *(u8)) -> unit)
});
```

Two codegen intrinsics bridge Yo `Trace` impls and the C collector:

- **`__yo_gc_trace_child(child : T, visit : *(u8))`** — the per-VALUE edge tracer
  (exactly `traverse_value`, §3.2), monomorphized per `T`: `T` managed handle →
  `__yo_gc_visit` it; `T` value struct/enum/tuple/array → recurse via
  `child.__yo_gc_traverse(visit)`; otherwise nothing. This is what container impls
  call per element.
- **`__yo_gc_visit(visit : *(u8), child)`** — invoke the type-erased callback:
  lowers to `((void(*)(void*))visit)((void*)child)`.

**Who implements `Trace`:**

- **structs / enums** — `__yo_gc_traverse` is **auto-derived** by the codegen
  (= `traverse_value` over the runtime fields / active-variant fields). Users never
  write it; the type's `header.traverse_fn` *is* this derived body.
- **containers** (`ArrayList`, `HashMap`, … and any user container) — **hand-implement
  `Trace` in std**, iterating the element buffer and calling `__yo_gc_trace_child`
  per element (and per key+value for maps):

```rust
// std/collections/array_list.yo
impl(ArrayList(forall(E), where(E <: Trace)), Trace(
  __yo_gc_traverse : (fn(self : Self, visit : *(u8)) -> unit)({
    i := usize(0);
    while(i < self.length, {
      __yo_gc_trace_child(self.uget(i), visit); // managed elem → visit; value → recurse
      i = (i + usize(1));
    });
  })
));
```

`Trace` is **mandatory**: every reference type that can transitively hold a managed
reference has a `__yo_gc_traverse` (derived for struct/enum, written for containers),
so the collector never misses an edge. The constructor sets
`header.traverse_fn = <type's __yo_gc_traverse>`.

### 3.4 Visit-callback ABI

`visit` is passed as an opaque `*(u8)` (the C `void(*)(void*)` the collector owns)
and is only ever *called* through `__yo_gc_visit` / `__yo_gc_trace_child`, which the
codegen lowers to the raw indirect call. This keeps `Trace` impls in ordinary Yo (no
first-class C-function-pointer Yo type needed) while the call site is plain C. The
auto-derived struct/enum traverse uses the same intrinsics, so derived and
hand-written impls are ABI-identical and freely compose (e.g.
`ArrayList(Option(Self))` works: the container impl calls `__yo_gc_trace_child` on an
`Option(Self)`, which descends the value-enum, which `visit`s the `Self` handle).

## 4. Companion fix — drop-on-reassign (no-leak completeness)

Independently of tracing, yo-self leaks the **overwritten** value on a managed-field
reassignment: `a.next = b` saves the old `a.next` to a temp but never `decr_rc`s it
(TS does). Required for "no leaks." Fix yo-self's assignment codegen to `decr_rc` the
saved old value when the field type is RC-managed (mirror the TS reference). Tracked
as gap #3 in `issues/yo-self-cycle-gc-runtime-port.md`.

## 5. Implementation phases

1. **`traverse_value` core + struct/enum auto-derive** (both compilers). The struct
   and enum `traverse_fn` generators delegate per field to the compositional
   `traverse_value`. Delivers `Option(Self)`, nested value-enums, tuples, inline
   arrays, and reference-enum-in-value-enum. This *is* the auto-derived `Trace`
   behaviour for struct/enum.
2. **`Trace` trait + intrinsics** (`std/prelude.yo` + both compilers): define the
   trait; add `__yo_gc_trace_child` (= `traverse_value` exposed as a per-value
   intrinsic) and `__yo_gc_visit` (the type-erased call). Wire the codegen so a type
   carrying an explicit `Trace` impl uses that impl as its `traverse_fn`; struct/enum
   without one keep the auto-derived body from phase 1.
3. **Container `Trace` impls**: `ArrayList`, then `HashMap` (and any other RC-capable
   std container), in std. Delivers `ArrayList(Self)` / `HashMap(_, Self)` cycles —
   the real self-host `TypeValue.field_types : ArrayList(Self)` shape.
4. **drop-on-reassign** fix (§4) so totals return to baseline (no terminator leak).

Each phase: build → run the cycle tests (totals return to baseline, not just
"dropped") → corpus 0-diff → `check ./std` → TS-ASan on the new cycle programs (the
yo-self ASan binary hangs for an unrelated pre-existing reason; the emitted runtime
is a verbatim port so TS-ASan is representative).

## 6. Tests to add

- `tests/cycle_collector.test.yo`: `Option(Self)` ref-struct + ref-enum cycle;
  `ArrayList(Self)` cycle; `HashMap(_, Self)` cycle. Assert
  `tracked_count == 0` after collect (full reclaim, no leak).
- `tests/codegen-bootstrap/`: differential variants (TS ↔ yo-self identical output),
  asserting **full** reclaim (`after == before`) once §4 lands.
- A `TypeValue`-shaped micro-cycle (struct with `ArrayList(Self)`) as the
  self-host-representative regression.

## 7. Risks / invariants

- **Atomic types never participate** — `traverse_value` must skip `atomic(ref(...))`.
- **Generic instantiations only** — skip any type still carrying a `SomeType` (no
  concrete layout); matches the existing traverse/ctor guards.
- **Nullable-pointer-optimized `Option`** must be visited as the bare pointer, not
  switched.
- **Codegen recursion** terminates at managed handles; keep the `visited` type-id
  guard for defensive safety on inline recursive value types.
- **Correctness is safety-critical**: over-visiting (a wrong pointer) risks
  use-after-free; under-visiting only leaks. Prefer the conservative direction when
  unsure, and ASan-validate.
- **1-to-1 port**: TS and yo-self must emit identical C; validate via corpus 0-diff.
