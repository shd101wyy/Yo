# `yo doc` type-function entries omit enum variants and trait-declared methods — everywhere, not just the prelude

**Severity:** S3 — every parameterised enum and trait in generated docs renders without its variants / declared methods (index-level info only)

**Status: OPEN.** Found 2026-10-04 while verifying
`issues/fixed/yo-doc-renders-std-prelude-as-an-empty-module.md` — that fix
restored the prelude's parameterised declarations to the doc set, and the
verification pass showed what they (and every non-prelude twin) still lack.

## Symptom

`yo doc ./std --format json` (develop tip, 2026-10-04):

- `prelude`'s `Option` renders as a `type-function` with `typeParams` and a
  `signature`, but `variants: []` — no `None`, no `Some`.
- `prelude`'s `Eq` renders as a `trait-function` with `methods: []` — no
  `(==)`, no `(!=)`. Same for `Ord`, `Index`, `Add`, the whole
  operator-trait family, `From`/`Into`/`TryFrom`/`TryInto`.
- This is NOT prelude-specific: `io/index`'s `Seek` — the one non-prelude
  `trait-function` in `std` — renders `methods: []` too (measured both
  before and after the prelude fix, so it is not a regression from it).
- Not everything is missing: `ArrayList` (a struct type-function) renders
  72 methods, `HashMap` 53 — because those come from the impl registry,
  which is keyed by NAME, not from the instantiated type.

Zero `type-function` entries anywhere in `std`'s docs carry variants
(measured over the whole post-fix doc.json).

## Root cause

`_resolve_inner_type` (`src/doc/builder.yo:2323`) resolves a type-constructor
entry's inner type by reading the fn's REGISTERED type
(`get_func_type(func_id)`) and returning its result — but only when that
result is NOT a `TypeUni`:

```rust
.Func({ result }) => {
  is_type_uni_result := match(result, .TypeUni(_) => true, _ => false);
  if(!is_type_uni_result, {
    return(result);
  });
},
...
return(field_type);
```

Every type/trait constructor is declared `-> comptime(Type)` /
`-> comptime(Trait)`, whose registered result IS a `TypeUni` — so the helper
falls through and hands back the FN type itself. Downstream,
`is_enum_type` / `is_trait_type` / `is_struct_type` on an fn type are all
false, `build_doc_module`'s specific branches never fire, and the entry lands
in the generic type-function arm (`fields`/`variants` `.None`). Struct
type-functions still show METHODS because `_extract_generic_impl_info` keys
on impl registrations by name; enum variants and trait-DECLARED methods have
no such side channel — they live only in the instantiated type.

Resolving the inner type for real means CALLING the constructor with fresh
comptime parameters inside the doc builder (`Option(SomeT)` / `Eq(SomeT)`),
which the current helper deliberately avoids; that is the design decision
this issue is filed against.

## Acceptance

`Option` documents `None`/`Some` as variants; `Eq` documents `(==)`/`(!=)`
as methods; `Seek` documents its method. With
`issues/fixed/yo-doc-renders-std-prelude-as-an-empty-module.md` landed, this
is also what unblocks the rest of the trait-doc inheritance coverage
(`_inherit_trait_method_docs` can only donate docs for methods the trait's
own entry carries).
