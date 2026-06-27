# Compositional cycle tracing (`Trace` hooks)

Status: PLANNED (2026-06-27). Both compilers (`src/` and `yo-self/`).

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

### 3.3 Containers — the one piece that needs explicit help

A container's elements live in a malloc'd buffer, not in named fields, so a
field-walk cannot reach them. The container must expose an element-iterating
`traverse_fn`. We realize the **`Trace` trait** here:

- `Trace` marks a type as "has traceable contents." Structs/enums get their `Trace`
  behaviour **auto-derived** (= the `traverse_value` walk, emitted by codegen).
- **Std containers** (`ArrayList`, `HashMap`) carry `Trace`; the codegen emits their
  element-iterating `traverse_fn` from their known buffer layout, e.g.:

```rust
// __yo_traverse_ArrayList(T):   (T is RC-relevant)
for (size_t i = 0; i < obj->length; i++) {
    traverse_value(((T*)obj->data)[i], T, visit);
}
// HashMap: iterate occupied buckets → traverse_value(key), traverse_value(value)
```

  When `T` (and `K`/`V`) contain no managed refs, the loop body is empty → skip the
  whole traverse (and the type isn't a cycle root anyway).
- **Phase 2 (extensibility):** expose `Trace` to user-defined containers — a user
  type with a raw element buffer implements `Trace` and the collector dispatches to
  it. Deferred until the visit-callback ABI (below) is firmed up; the std-container
  path above already covers every real case incl. the self-host `TypeValue`.

### 3.4 Visit-callback ABI (the bootstrapping subtlety)

The collector's visitor is `void (*visit)(void*)`. In Phase 1 the entire traverse is
**codegen-emitted C**, so `visit` is just the C function pointer the collector
passes — no Yo-level closure/ABI work. A user-facing Yo `Trace` trait (Phase 2)
would need a Yo type for that callback (a `*(extern "C" fn(*(u8)) -> unit)` or
equivalent); that is the only reason Phase 2 is deferred, not Phase 1.

## 4. Companion fix — drop-on-reassign (no-leak completeness)

Independently of tracing, yo-self leaks the **overwritten** value on a managed-field
reassignment: `a.next = b` saves the old `a.next` to a temp but never `decr_rc`s it
(TS does). Required for "no leaks." Fix yo-self's assignment codegen to `decr_rc` the
saved old value when the field type is RC-managed (mirror the TS reference). Tracked
as gap #3 in `issues/yo-self-cycle-gc-runtime-port.md`.

## 5. Implementation phases

1. **`traverse_value` core + struct/enum rewire** (both compilers). Delivers
   `Option(Self)`, nested value-enums, tuples, and reference-enum-in-value-enum.
   Validate against a `ref_enum_option_cycle` test.
2. **Container traverse** for `ArrayList` then `HashMap` (both compilers). Delivers
   `ArrayList(Self)` / `HashMap(_, Self)` cycles — the real self-host shapes.
3. **drop-on-reassign** fix (§4) so totals return to baseline (no terminator leak).
4. **Phase 2 (optional, later):** user-facing `Trace` trait + visit ABI.

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
