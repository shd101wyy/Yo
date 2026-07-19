# yo-self: Iso lowering port — iso_api_surface GREEN; iso.test/rc have further layers

**Status:** LAYERS 1, 2, 3a, 3b all DONE. **`iso_api_surface` FLIPS 2/2.** iso.test
needs layer 3c (`^` operator `can_isolate` type-name-as-value); rc needs layer 4
(`Array_Array_*` nested-array decl). NONE of it is Gap-6 (my earlier 3b Gap-6 read
was wrong — see 3b below).
**Targets:** `tests/iso.test.yo` (3c), `tests/rc.test.yo` (4), `tests/iso_api_surface.test.yo` (GREEN).
**Class:** PORT / codegen dispatch (deterministic — mirror TS), NOT Gap-6.

## After layers 1+2 — the files advance to these NEXT layers

- **Layer 3a — `evaluate_yo_iso_extract` Phase-H type (DONE this session):** eval set
  the `__yo_iso_extract(self)` expr type to `Option(T)` (stale) while the prelude
  `extract` method is Phase-H `-> T`. Fixed to the inner `T` (mirrors TS
  evaluateYoIsoExtract "Phase H: returns T directly, no Option", rc-fns.ts:562).
  The extract method now emits `yo_id_..._ret_R_gs_...(Iso_X self){ return
__yo_iso_extract_Iso_X(self); }` returning `__yo_t23*` (=T). NOT sufficient alone.
- **Layer 3b — `.extract()` CALL SITE dispatch gate (FIXED this session; NOT Gap-6 —
  my earlier read was wrong):** the outer method call `(i2.extract)()` FTT'd through
  the general path. PROBE (has_ei=true; PROBE-MC `tid=[]`, `st_funcval=true`) showed
  the concrete method-dispatch (other_fn_call.yo:997) was gated on
  `if(tid.len() > 0)`, and `type_id_or_empty(Iso(...))` is EMPTY (Iso lives only in
  `iso_types`, not the registry `types` map) — so the whole dispatch, INCLUDING the
  expr-id-keyed method-callee side-table lookup (which HAD the resolved extract and
  needs no tid), was skipped. FIX: also enter the dispatch when
  `lookup_method_callee_value(expr_id).is_some()`. Flips **iso_api_surface (2/2)**.
  General fix — helps any method call on a tid-less receiver.
- **Layer 3c — iso.test `^` operator `can_isolate` (OPEN):** after 3b, iso.test hits
  `use of undeclared identifier '__yo_t29'` at `((bool (*)(void*))__yo_t29.can_isolate)(x)`
  — the `^(x)` Iso-construct emits the TYPE name `__yo_t29` where a value/fn is wanted
  (the "type-name-as-value" / msu class). Only iso.test uses `^`; iso_api_surface
  doesn't, so it's already green.
- **Layer 4 — `Array_Array_*` decl (rc):** `unknown type name
'Array_Array___yo_t25_u42__1_1'` + `initializing '__yo_t25 *' with ...
Array_Array_...`. A nested-array (Array of Array) C type isn't declared — reached
  only lazily during body codegen (collect_types_from_expr skips BK_TEST at :578),
  not during the collection pass. rc.test is not Gap-6-blocked (no `.extract()`), so
  this is rc's remaining root. Separate arc.

## Layer 1 (DONE this session)

`get_type_string`'s `.IsoT` arm was a `__yo_panic` stub (`codegen/utils/index.yo`).
Ported it to mirror TS getTypeString `case TypeTag.Iso` (`src/codegen/utils/index.ts:788`):
build `Iso_<sanitize(strip_stars(childCName))>`, register in `iso_types` (idempotent),
return the name. Added `_strip_stars` helper (String has no `replace`; sanitize would
turn `*`→`_u42_`). Result: iso.test advances from the panic (rc=134) to
`unknown type name 'Iso___yo_t23'` / `undeclared __yo_create_iso_*` — because
`generate_iso_type_declarations` is still a NO-OP stub.

## Layer 2 (DONE this session) — `generate_iso_type_declarations`

Ported the full TS `generateIsoTypeDeclarations` (`src/codegen/types/
generation.ts:1047`) into `generation.yo` (was a `()` stub): 6 passes over
`iso_types` emitting the Iso struct + create/extract/dispose decls & impls. Added
the `struct_generated`/`create_generated`/`extract_generated`/`dispose_generated`
flags to `IsoTypeInfo`. Inner-value drop = `__yo_decr_rc` (every Iso child is an RC
value). All 3 files now compile past the struct-decl layer. Reference (what was
ported): `context.iso_types` passes —

1. **Struct decl + create decl** (skip if `struct_generated`):
   ```
   typedef struct { // Iso wrapper struct
     __yo_ref_header_t header;
     _Atomic bool extracted;
     <childTypeCName> value;
   } Iso_X_struct;
   typedef Iso_X_struct* Iso_X;
   Iso_X __yo_create_iso_Iso_X(<childTypeCName> value);   // decl
   ```
2. **Extract decl**: `<childTypeCName> __yo_iso_extract_Iso_X(Iso_X iso);`
3. **Dispose decls** (if `struct_generated`): `void __yo_iso_dispose_Iso_X(Iso_X);`
   - `static void __yo_dispose_iso_Iso_X(void* ptr);`
4. **Create impl** (skip if `create_generated`): malloc, `header.ref_count=1`,
   `borrow_count=0`, GC init IF `context.needs_cycle_gc` (`gc_mark=__YO_GC_UNMARKED;
gc_flags=0`), then the dispose wiring — IF needs_cycle_gc:
   `header.dispose_fn = __yo_dispose_iso_Iso_X;` ELSE allocate a dispose type id
   from `context.dispose_type_ids` (see async.yo:1223-1226 for the exact
   allocate-or-reuse pattern) and emit `header.type_id = <id>;`. Then
   `atomic_store(&iso->extracted, false); iso->value = value; return iso;`.
5. **Dispose impls** (skip if `dispose_generated`; needs `iso_type`): drop the inner
   value IFF `!atomic_load(&extracted)`. Drop code = child type's `___drop` C fn if
   present (look up via type_trait_methods registry keyed by child type id +
   `___drop`, like the forward_ref fix), else `__yo_decr_rc((void*)iso->value)`.
   Emit public `__yo_iso_dispose_Iso_X` + static `__yo_dispose_iso_Iso_X` wrapper.
6. **Extract impl** (skip if `extract_generated`): `atomic_exchange(&extracted, true)`;
   if was true → `fprintf(stderr,"panic: ...already-extracted..."); abort();` else
   `return iso->value;`.

## Prereqs / dependencies (all EXIST in yo-self)

- `IsoTypeInfo` (utils/index.yo:96) currently `ref(struct(child_type_c_name, iso_type))`
  — ADD `structGenerated`/`createGenerated`/`extractGenerated`/`disposeGenerated`
  bool fields (default false), mutated in-place (it's a `ref` struct).
- `context.needs_cycle_gc` — EXISTS (codegen_c.yo:77).
- `context.dispose_type_ids` — EXISTS (codegen_c.yo:115); async.yo:1223-1226 shows
  the allocate/emit pattern to reuse.
- child `___drop` lookup — reuse `get_type_trait_methods_by_name(childTypeId,"___drop")`.
- `register_iso_type` / `has_iso_type` — EXIST (utils/index.yo:406/412); constructor/
  extract emitters (`codegen/exprs/iso.yo`) already call them and get_type_string.

## Why it's mechanical

All deps exist; it's a straight template translation. The only care points: the
ref-struct flag mutation, the dispose-id allocate-or-reuse, and the `___drop`
registry lookup (fallback to `__yo_decr_rc` covers `Box(i32)` — the iso.test child).
Gate as usual; my change can't affect the self-compile (yo-self uses no Iso, so the
old panic never fired there — stage2/stage3 stay identical).
