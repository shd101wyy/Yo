# yo-self: Iso lowering port — layer 1 DONE, runtime decls/impls remain

**Status:** LAYER 1 DONE (get_type_string `.IsoT` arm). LAYER 2/3 (runtime) OPEN.
**Targets:** `tests/iso.test.yo`, `tests/rc.test.yo`, `tests/iso_api_surface.test.yo` (3 files).
**Class:** PORT (deterministic — mirror TS), NOT Gap-6 / not a bug hunt.

## Layer 1 (DONE this session)

`get_type_string`'s `.IsoT` arm was a `__yo_panic` stub (`codegen/utils/index.yo`).
Ported it to mirror TS getTypeString `case TypeTag.Iso` (`src/codegen/utils/index.ts:788`):
build `Iso_<sanitize(strip_stars(childCName))>`, register in `iso_types` (idempotent),
return the name. Added `_strip_stars` helper (String has no `replace`; sanitize would
turn `*`→`_u42_`). Result: iso.test advances from the panic (rc=134) to
`unknown type name 'Iso___yo_t23'` / `undeclared __yo_create_iso_*` — because
`generate_iso_type_declarations` is still a NO-OP stub.

## Layer 2/3 (OPEN) — port `generate_iso_type_declarations`

`yo-self/codegen/types/generation.yo:1097` is `fn(context) -> unit)(())` — a stub.
Port the full TS `generateIsoTypeDeclarations` (`src/codegen/types/generation.ts:1047`
— **176 lines**). It iterates `context.iso_types` in these passes:

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
