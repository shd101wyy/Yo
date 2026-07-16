# yo-self GC traverse_fn treats a value-struct field as a pointer (`if(struct)`)

## Status: OPEN (latent; exposed by type-resolution reordering, not yet triggered on the committed corpus)

## Symptom

Compiling `yo-self/main.yo` with a yo-self build in which type-resolution order shifted slightly
(observed while trialing an emitter change, since reverted) produced 2 clang errors in the emitted C:

```
stage2p.c:232173:3: error: statement requires expression of scalar type
  ('__yo_t290' (aka 'struct __yo_t290_struct') invalid)
stage2p.c:232173:49: error: passing '__yo_t290' (aka 'struct __yo_t290_struct')
  to parameter of incompatible type 'void *'
```

The offending function is a **GC traverse_fn** — the compositional cycle-tracer emitted for a
HashMap Bucket-like type `struct { key : Option(K), value : V }`:

```c
static inline void yo_id_12__struct...__ret_unit(__yo_t857 self, __yo_t291* slot) {
  switch ((*(slot)).key.tag) {
  case __YO_T3_SOME:
    if ((*(slot)).key.data.Some.value) { ((void(*)(void*))self)((*(slot)).key.data.Some.value); }
    break;
  }
  if ((*(slot)).value) { ((void(*)(void*))self)((*(slot)).value); }   // <-- BUG: .value is a value-struct
  ((void)0);
}
```

Here `(*(slot)).value` has type `__yo_t290`, a **value struct** (not a pointer). The traverse emitter
assumes every traced field is a pointer and emits `if (field) { tracer(field); }`, which is invalid for
a value-struct field: `if(struct)` is not scalar, and `tracer(struct)` passes a struct where `void*` is
expected. A value-struct field must instead be traced by recursively invoking **its own** traverse_fn on
`&field` (or inlining the field's traced sub-fields), exactly as the value-struct RC drop path inlines
`switch(field.tag){…__yo_decr_rc(field.data.X.value)…}` rather than `__yo_decr_rc(field)`.

## Why it is latent

The SAME yo-level Bucket type resolved to a struct whose `.value` field is a **pointer** in the
committed-green emission (`/tmp/stage2.c`: param `__yo_t600* slot`, compiles clean, 0 errors) but a
**value-struct** in the reordered emission (`__yo_t291* slot`). So whether the bug fires depends on
which concrete `V` the Bucket monomorphization that receives a traverse_fn ends up with — a function of
type-registration/resolution ORDER. The committed corpus (118 files) never instantiates the
value-struct-`V` Bucket-with-traverse combination, so the bug is invisible to the corpus gate; only the
full `main.yo` self-emit reaches it, and only under a particular resolution order.

## ROOT CAUSE CORRECTED (2026-07-13): it is the #30 type-identity collision, NOT a traverse-emitter bug

Attempted fix (reverted): guard the reference-visit branch in `_traverse_value` on the ACTUAL C
representation (`get_type_string(ty)` ends in `*`). **This is a no-op and does NOT fix it** —
`is_reference_struct_type(ty) == true` _implies_ `get_type_string(ty)` ends in `*`, so the guard's
condition is always satisfied when the branch is entered.

The real mechanism: the trace fn `yo_id_12...(self, __yo_t291* slot)` is generated for a Bucket
instantiation whose `value` field type `V` is **reference-semantics** (`get_type_string(V)` =
`__yo_t290*`), so `_traverse_value` correctly emits the pointer edge `if((*slot).value){visit}`. BUT the
C struct `__yo_t291` that `slot` points at was laid out for a **different** Bucket instantiation whose
`value` field is a **value struct** (`__yo_t290 value;`). Two distinct Bucket(K,V) instantiations —
one with ref-V, one with value-V — collapsed onto the same C type id (`__yo_t291`). The trace fn (built
from the ref-V bucket's field list) and the struct layout (built from the value-V bucket's field list)
therefore disagree on `.value`'s representation. This is exactly **task #30 — stable type identity for
same-fielded generic instantiations** (a same-name/same-field-count collision that ignores field
reference-semantics). `_traverse_value` and the struct-layout emitter are each internally consistent
with THEIR bucket instance; the bug is that the two instances share one C id.

## Where to fix (CORRECTED)

In the codegen TYPE-IDENTITY layer (`yo-self/codegen/` — mirror of TS `src/codegen/types/collection.ts`

- the CodegenTypeEntry keying, tasks #29/#30): the C-type-id assigned to a generic struct
  instantiation must incorporate each field's REFERENCE-SEMANTICS (value vs ref), not just name +
  field-count + field-type-name. Two Bucket(K,V) instantiations that differ only in whether `V` is a
  value struct or a ref(struct) MUST get distinct C ids, so their struct layout and their trace fn agree.

`_traverse_value` (constructors.yo) is CORRECT and needs no change — it already branches value-struct →
recurse-fields, ref → pointer-edge, value-enum → switch (verified against TS `emitTraverseValue`,
generation.ts:2741). A guard there on `get_type_string` ending in `*` is a NO-OP (see above) and must
NOT be added.

Repro path: re-apply the reverted emitter DECL_RE fix (commit 9d29e8569, reverted at 324087cdf) — the
type-registration reorder it causes makes the value-V and ref-V Bucket instantiations collide on
`__yo_t291`; `clang -fsyntax-only /tmp/stage2.c` then shows the 2 errors. Add a corpus test that forces
BOTH a `HashMap(K, ValueStructWithRcField)` and a `HashMap(K, RefStructType)` live in one program so the
two instantiations coexist and the collision is corpus-visible.

## Interaction with the perf/leak work

Discovered while attempting the perf-parity fix (making yo-self emit as many drops as TS to stop the
`__yo_gc_collect` thrash — see issues/yo-self-fixpoint-eval-phase-leak.md). The emitter change was
reverted (no-regression gate: it broke the main.yo self-compile via this latent bug). This bug should be
fixed FIRST (it is a correctness landmine that any reordering can trip), then the drop-scheduling
parity work resumed.
