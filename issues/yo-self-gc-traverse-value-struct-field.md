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

## Where to fix

The GC traverse (Trace) emitter in `yo-self/codegen/` (the compositional tracer that walks a type's
fields — mirror of the TS `src/codegen/types/` Trace/traverse emission). For each traced field it must
branch on the field's TypeValue shape:

- pointer / ref-struct / ref-enum field → `if (field) { tracer(field); }` (current behavior, correct)
- value-struct field → recurse into the field's own traced sub-fields (call the
  field type's traverse_fn on `&field`, or inline)
- value-enum field → `switch(field.tag){ case …: <trace payload> }` (as the
  drop path already does)

Cross-check against the TS emitter (`src/codegen/types/*` traverse/trace generation) for the exact
value-struct / value-enum field handling and port it faithfully. Add a corpus test with a
`HashMap(K, ValueStructWithRcField)` (or a plain `struct{ v : ValueStruct }` that is cycle-tracked) so
the value-struct-field traverse path is covered.

## Interaction with the perf/leak work

Discovered while attempting the perf-parity fix (making yo-self emit as many drops as TS to stop the
`__yo_gc_collect` thrash — see issues/yo-self-fixpoint-eval-phase-leak.md). The emitter change was
reverted (no-regression gate: it broke the main.yo self-compile via this latent bug). This bug should be
fixed FIRST (it is a correctness landmine that any reordering can trip), then the drop-scheduling
parity work resumed.
