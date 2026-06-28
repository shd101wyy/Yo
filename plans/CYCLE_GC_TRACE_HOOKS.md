# Compositional cycle tracing (`Trace` hooks)

Status: IN PROGRESS (2026-06-27). **Phase 1 DONE in both compilers.** Cycle tracing
is organized around a **mandatory** first-class `Trace` trait defined in
`std/prelude.yo` (§3.3): auto-derived for structs/enums, hand-implemented for every
RC-capable container (`ArrayList`, `HashMap`, …) and open to user containers.

**Phase 1 (compositional `traverse_value` + struct/enum auto-derive) — ✅ DONE
(both compilers).** The struct and enum traverse generators delegate per field to
a single compositional `emitTraverseValue` / `_traverse_value` that descends inline
through value structs, **newtypes** (C-transparent typedef alias → recurse the inner
type with the same access), value enums (incl. `Option`, with nullable-pointer-opt),
tuples, and inline arrays, stopping at managed handles (atomic skipped). yo-self
needed one companion fix: `_patch_self_shell` (types/creators.yo) now recurses into
`EnumT` variant fields like the `.Struct` branch, so the recursive self-shell nested
in `Option(Self)` is patched to the real enum and `can_type_form_rc_cycle` detects
the cycle (TS has no shell — its `Self` is a shared ref). Validated: `Option(Self)`
ref-enum cycle fully reclaims 0→2→0 in BOTH compilers; corpus 85/85 0-diff (new
`tests/codegen-bootstrap/ref_enum_option_cycle.yo`); TS `check ./std` 152; TS
`cycle_collector.test.yo` 15/15 (+2 ref-enum `Option(Self)` blocks). (Orthogonal:
the self-hosted `yo-self-bin check ./std` SIGSEGVs ~50 files in — a pre-existing
Phase-4/6 evaluator deep-recursion/NULL-deref, reproduced on the newtype-only
binary, unrelated to cycle GC.)

Phases 2–5 (Trace trait + GcTracer, container impls, drop-on-reassign, bilingual
docs) remain. The user-facing API is a clean `Trace` trait with `trace(self,
tracer)` + `tracer.visit(child)` — no `__yo_`-looking names in Yo source.

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
  // Trace every managed object directly held by `self`, descending inline through
  // value structure. Call `tracer.visit(child)` once per outgoing edge (per element
  // for containers); never touch the raw callback.
  trace : (fn(self : Self, tracer : GcTracer) -> unit)
});
```

`GcTracer` is an opaque handle (defined in `std/prelude.yo`) that carries the
collector's edge-registration callback. It exposes exactly one method — a compiler
intrinsic that is the per-VALUE edge tracer (`traverse_value`, §3.2), monomorphized
per `T`:

```rust
// GcTracer.visit(child): trace one outgoing edge.
//   T managed handle (ref struct/enum, non-atomic) → register the edge;
//   T value struct / enum / tuple / array          → recurse into child;
//   otherwise (primitive, raw ptr, atomic, unit)   → nothing.
visit : (fn(self : Self, forall(T), child : T) -> unit)
```

The raw type-erased call (`((void(*)(void*))callback)(child)`) is emitted only by the
compiler inside `visit`'s managed-handle case — it has **no user-facing name**.

**Who implements `Trace`:**

- **structs / enums (incl. `Option` and every value type)** — `trace` is
  **auto-derived** by the codegen (= `traverse_value` over the runtime fields /
  active-variant fields; phase 1). Users never write it, and **`Option(Self)` and
  value enums need NO hand-written impl** — the derived traverse already descends
  through them inline. The type's `header.traverse_fn` *is* this derived body.
- **containers** (`ArrayList`, `HashMap`, … and any user container) — **hand-implement
  `Trace` in std**, because the elements live in a malloc'd buffer that a field walk
  cannot reach. Iterate the buffer and call `tracer.visit` per element (and per
  key+value for maps):

```rust
// std/collections/array_list.yo  (uget = unchecked element access)
impl(ArrayList(forall(E), where(E <: Trace)), Trace(
  trace : (fn(self : Self, tracer : GcTracer) -> unit)({
    i := usize(0);
    while(i < self._length, {
      tracer.visit(self.uget(i)); // managed elem → register edge; value → recurse
      i = (i + usize(1));
    });
  })
));
```

`Trace` is **mandatory**: every reference type that can transitively hold a managed
reference has a `trace` (derived for struct/enum, written for containers), so the
collector never misses an edge. The constructor sets `header.traverse_fn` to the
type's `trace` (the auto-derived body, or the container's hand-written one).

### 3.4 The `GcTracer` ABI

`GcTracer` wraps the C `void(*)(void*)` callback the collector owns (internally a raw
pointer), so `Trace` impls stay ordinary Yo with no first-class C-function-pointer
type and no `__yo_`-looking names in user code. `tracer.visit` is the only entry
point; the codegen lowers it to the per-value traverse (§3.2), emitting the raw
indirect call only at a managed-handle leaf. The auto-derived struct/enum traverse
lowers identically, so derived and hand-written impls are ABI-identical and freely
compose (e.g. `ArrayList(Option(Self))` works: the container impl calls
`tracer.visit` on an `Option(Self)` value, which descends the value-enum, which
registers the inner `Self` handle edge).

## 4. Companion fix — drop-on-reassign (no-leak completeness)

Independently of tracing, yo-self leaks the **overwritten** value on a managed-field
reassignment: `a.next = b` saves the old `a.next` to a temp but never `decr_rc`s it
(TS does). Required for "no leaks." Tracked as gap #3 in
`issues/yo-self-cycle-gc-runtime-port.md`.

**Precise root (RE-DIAGNOSED 2026-06-28 from emitted C — supersedes two earlier wrong
framings):** NOT "fix the codegen save" (the save is emitted) and NOT "un-stub
`attach_temp_variable_to_expr`" (that fn IS fully implemented in
`yo-self/evaluator/utils.yo:105` — it registers the temp; the "no-op stub" comments in
`recur.yo:20`/`assignment.yo:13,718` are STALE, predating its porting). The actual gap,
from comparing the emitted C of the ref-enum cycle (TS `0→2→0` vs yo-self `0→4→2`): for
`a.next = b` where `next : Self` (a ref-**enum** managed field), yo-self emits the old
value SAVE (`temp = a->data.ECons.next; // Save old value`) but emits **neither** (1) a
`__dup` on the RHS (TS: `a->next = __dup(b)`; yo-self: `a->next = b`) **nor** (2) any
scope-end `__drop` — not the saved temps, *not even the locals* `a`/`b`. TS drops all
four. Net: the two overwritten `ENil` terminators are held at RC=1 by dead save-temps and
survive trial deletion (nothing else points at them) → leak (`after=2`); the `a↔b` ECons
cycle still collects. So yo-self's assignment dup/drop **scheduling** doesn't treat
ref-enum managed-field writes as RC-managed (no deferred dup on RHS, no deferred drop of
the saved old value). **Fix:** schedule the deferred `dup(RHS)` + deferred
`drop(saved-old-value)` for ref-enum (verify ref-struct) managed-field reassignment in
yo-self's assignment evaluator/codegen, mirroring TS. ⚠️ Delicate RC change — validate
corpus 0-diff + `ref_enum_cycle` returning to baseline (`after==before`) + TS-ASan.
Likely localized to the ref-enum field-write path (ref-struct field writes + variable
reassignment already emit correct RC). Repro: `src/tests/fixme.yo` (count-printing).

## 5. Implementation phases

1. **`traverse_value` core + struct/enum auto-derive** (both compilers). The struct
   and enum `traverse_fn` generators delegate per field to the compositional
   `traverse_value`. Delivers `Option(Self)`, nested value-enums, tuples, inline
   arrays, and reference-enum-in-value-enum. This *is* the auto-derived `Trace`
   behaviour for struct/enum.
2. **`Trace` trait + `GcTracer`** (`std/prelude.yo` + both compilers): define the
   `Trace` trait (`trace : fn(self, tracer : GcTracer)`) and the opaque `GcTracer`
   with its one intrinsic method `visit` (= `traverse_value` exposed as a per-value
   intrinsic; the type-erased call is emitted internally at managed-handle leaves).
   Wire the codegen so a type carrying an explicit `Trace` impl uses that impl as its
   `traverse_fn`; struct/enum without one keep the auto-derived body from phase 1.
3. **Container `Trace` impls**: `ArrayList`, then `HashMap` (and any other RC-capable
   std container), in std. Also teach `can_type_form_rc_cycle` to see THROUGH a
   container to its element type (the elements sit behind a raw buffer pointer, so the
   field walk alone never reaches them). Delivers `ArrayList(Self)` /
   `HashMap(_, Self)` cycles — the real self-host `TypeValue.field_types :
   ArrayList(Self)` shape.
4. **drop-on-reassign** fix (§4) so totals return to baseline (no terminator leak).
5. **Docs** (bilingual): update `docs/en-US/CYCLE_COLLECTION.md` and
   `docs/zh-CN/CYCLE_COLLECTION.md` to document compositional tracing and the `Trace`
   / `GcTracer` API — struct/enum/`Option`/value types are auto-derived; only
   containers implement `Trace`.

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

## 8. Implementation map (TS anchors — discovered)

Phase-2 status: the prelude API + the `__yo_gc_trace_child` intrinsic codegen are
**implemented on TS and validated neutral** (TS check ./std 152, `Option(Self)`
still collects, the old yo-self binary loads the new prelude unchanged). What is
WIP / remaining, with the concrete hooks:

- **Intrinsic (DONE, TS)**: `BuiltinFunctions.__yo_gc_trace_child` (expr.ts:1237);
  `generateYoGcTraceChild` (codegen/exprs/gc.ts) → `emitTraverseValue(childCode,
  childType, context, new Set(), tracerCode)`; dispatch in codegen/exprs/generation.ts
  next to `__yo_gc_collect`. `emitTraverseValue` (codegen/functions/generation.ts) now
  takes a `visitExpr` and emits the cast-call `((void(*)(void*))visitExpr)(access)`;
  exported and relaxed to `CodeGenContext`. **Port these to yo-self** (expr.yo BF
  constant, codegen/exprs/gc.yo, generation.yo dispatch, the `_traverse_value`
  visitExpr+cast in codegen/functions/constructors.yo).
- **traverse_fn selection (item 5)**: in the constructor, if the type has an explicit
  `Trace` impl, set `header.traverse_fn = (void(*)(void*,void(*)(void*)))<traceCName>`
  instead of `__yo_traverse_<cName>`. Find `<traceCName>` via a `findUserTraceMethodForType`
  modeled on `findUserDisposeMethodForType` (generation.ts:142) + `findDisposeTraitValue`
  (:84). GcTracer is a newtype over `*(u8)` so the trace method's C signature is
  `void(<cName>*, u8*)` — the fn-ptr cast bridges it to the traverse_fn ABI.
- **no-RC-churn element access (item 6) — ✅ SOLVED (design, validated by analysis)**:
  `tracer.visit` takes the element's SLOT POINTER, never the element by value:
  `visit : fn(forall(T), self : Self, slot : *(T))`, body `__yo_gc_trace_child(self,
  slot)`, lowering to `emitTraverseValue("(*(slot))", T)` — a RAW deref read, exactly
  like the auto-derived `visit(obj->field)` (no dup, no drop, RC-neutral). A by-value
  managed handle would be dup'd at the call then dropped at `visit`'s scope end, and at
  RC=1 the drop frees the still-referenced element MID-COLLECTION (UAF) and corrupts the
  collector's concurrent trial-decrement. The ArrayList impl reads the buffer raw:
  `match(self._ptr, .Some(base) => while(i < _length) { tracer.visit(base &+ i); ... })`.
  Prelude: `extern __yo_gc_trace_child : fn(forall(T), tracer : GcTracer, slot : *(T))`;
  `generateYoGcTraceChild` derives the pointee `T` from the slot arg's `PtrType`.
- **detection through container (item 7)**: `can_type_form_rc_cycle` /
  `typeCanFormCyclicRcReference` walk only `field_types`; a container's elements sit
  behind a raw `?*(E)` buffer field, invisible to the walk. Add: for a struct that
  implements `Trace`, also walk the buffer ELEMENT type — a `bufferElementType` helper
  extracts the pointee of a `*(E)` / `Option(*(E))` field; the existing `visited`-set
  recursion then closes the cycle (`ArrayList(Self)` → element `Self` → already-visited).
  Resolve the container's Trace impl with its OWN env (`type.env`), not the root's
  threaded env (impls are visible in the defining module, not necessarily the root's).

- **✅ PHASE 3 (TS): DONE — container cycles collect. The blocker was NOT task #30.**
  The earlier "struct-identity fragmentation (task #30)" diagnosis was a **red herring**.
  The id_738-vs-id_704 fragmentation I chased was an artifact of an earlier instrumented
  build; in the real run `Node.children` references a single consistent `ArrayList(Node)`
  (id_704), and `synthesizeTypes`' funcId-unification path resolves both `dispose` and
  `trace` for it. Resolution/delegation was never the wall.
  - **The true root: the buffer-blind `Acyclic` auto-derive.** `autoDeriveAcyclicForStructType`
    marked a ref struct `Acyclic` whenever `!canTypeFormRcCycle`, and *both* of those
    looked only at the struct's declared fields. A container's elements live behind a raw
    `?*(E)` buffer pointer, not in a field of type `E`, so the field walk saw no managed
    refs → `ArrayList(Node)` was wrongly marked `Acyclic`. `canTypeFormRcCycle` then
    short-circuits to `false` for any `Acyclic` type, so `Node`'s cycle was never found →
    `needsCycleGC=false` → nothing GC-tracked (`mid=0`).
  - **The fix (commit ee3d7b82b):** make both halves *element-aware* via a shared
    `bufferElementType(fieldType)` helper (`src/types/utils.ts`) that extracts the pointee
    `E` from an `Option(*(E))` (`?*(E)`) buffer field (bare `*(E)` is intentionally NOT
    matched — a non-owning raw pointer).
    - `canTypeFormRcCycle` (src/types/utils.ts): after the field walk, also walk each
      field's `bufferElementType` and recurse — so `ArrayList(Node) → Node → ArrayList(Node)`
      converges and the cycle is found.
    - `autoDeriveAcyclicForStructType` (src/evaluator/types/utils.ts): a ref struct is
      `Acyclic` only if **every** `?*(E)` buffer element is itself `Acyclic`
      (`allBufferElementsAcyclic`) **and** `!canTypeFormRcCycle`. So `ArrayList(Node)` is
      correctly withheld from `Acyclic` (stays visible to detection) while `ArrayList(i32)`
      stays `Acyclic`.
  - **Validated (TS):** `ArrayList(Self)` two-node cycle now tracks then collects (0→4→0),
    ASan-clean on an RC=1 cycle (the slot-pointer no-RC-churn API above), `tests/cycle_collector.test.yo`
    16/16, no std regression, corpus 85/85.
- **✅ PHASE 3 (yo-self DETECTION): DONE (commit 9241f3e0d).** The element-aware Acyclic +
  buffer-walk fix is mirrored 1-to-1 in `yo-self/types/utils.yo` (`buffer_element_type` +
  buffer-walk in `can_type_form_rc_cycle` and the `_type_refs_back_to_cyclic` sref re-root,
  inlined via `recur` since yo-self forbids top-level mutual recursion) and
  `yo-self/evaluator/types/utils.yo` (`_all_buffer_elements_acyclic`). The self-hosted
  compiler now **detects** the container cycle (`tracked_count` 0→4; was 0→0). Corpus 85/85
  0-diff.
- **✅ PHASE 3 (yo-self COLLECTION): DONE (commits 8c97d0f34 part 1/2 + 846f8d483 part 2/2).**
  yo-self now COLLECTS container cycles (`ArrayList(Self)` tracked 0→4→0, full reclaim),
  matching TS. It was a genuine machinery divergence from TS, resolved in two parts:
  - **The divergence:** TS has `collectTraceMethodsFromGenericImpls`, whose
    `findMethodsFromGenericImpls` returns a *specialized* (emittable) FuncVal. yo-self
    specializes impl methods *lazily at call sites* (`try_to_call` →
    `create_specialized_function_inline`); `trace` has no call site, and yo-self's
    `find_methods_from_generic_impls` returns a *generic* (non-emittable) FuncVal (same
    func_id, generic body — only forall captures injected).
  - **Part 1/2 — codegen delegation plumbing (inert until part 2):** `gc.yo`
    `generate_yo_gc_trace_child` → slot-deref `(*(slot))` form (was by-value);
    `drop_dup.yo` `get_trace_function_for_type` = `_method_c_name(type, "trace")`;
    `constructors.yo` ref-struct + ref-enum traverse generators delegate
    `${traceCName}(obj, (void*)visit)` when a trace is registered, else the field walk.
  - **Part 2/2 — eval-time collector:** `collection.yo`
    `collect_trace_methods_from_generic_impls` walks the RC struct/enum types in
    `context.types`, and for each carrying a generic `Trace` impl drives
    `create_specialized_function_inline` to monomorphize `trace` for the concrete
    container (building the callee env with the impl's forall captures *and* the
    self/tracer params bound — try_to_call normally does the latter), then registers the
    specialized FuncVal under the concrete id (`register_type_trait_method`) + in
    `context.functions` + collects its signature types (GcTracer) and body calls. Gated to
    register only a real FuncVal (create_specialized can soft-fall-back to unit → a no-op
    leaves the auto-derived field walk → "still leaks", never a crash/miscompile). Codegen
    has no EvalContext/exn of its own, so `compile_module` takes the live ctx / module env /
    exn threaded from `run_compile`; the collector runs after `compute_needs_cycle_gc`,
    gated on `needs_cycle_gc`. (Divergence from TS's compile_module signature is necessary:
    yo-self's effect-based evaluator can't self-construct an exn handler the way TS
    self-constructs a context object — the emitted C is identical.)
  - **Validated:** `ArrayList(Self)` 0→4→0 (was 0→4→4 detect-only); corpus 86/86 PASS,
    DIFF 0, SELF-FAIL 0 (added `tests/codegen-bootstrap/arraylist_self_cycle.yo`, which
    PASSES differentially — both back ends agree).
