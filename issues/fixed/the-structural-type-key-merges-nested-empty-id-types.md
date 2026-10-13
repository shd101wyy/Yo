# The structural type key merges nested empty-id types

**Severity:** S2 — distinct types get one structural key, so the
representation memos give a wrong answer (`type_representation_contains_raw_ptr`
reports a raw pointer 45 levels down as absent) and `intern_type` can merge
two different types into one.

**Status: FIXED 2026-10-13.** Found when develop went red on c2fe7d0e1
(run 38333980990, both attempts): `tests/internal/types_utils.test.yo` ›
"raw-ptr predicate: a Ptr 45 levels down is found" failed with exit 134.

## Cause

#1329 (VBD V4 prep) stopped comparing `TypeValue` objects by address in the
representation-predicate memo and cycle path (`src/types/utils.yo`), the
universe memo (`types/hierarchy.yo`) and substitute's memo
(`types/substitution.yo`). Two same-id types now compare by
`type_memo_key`, which is `type_intern_key`.

`type_intern_key` (`src/types/intern.yo`) renders a Struct, EnumT, TraitT or
SomeT it has already visited as just its token, `S:<id>` plus the type
arguments. That is right for a type with an id: the token names it. An
**empty** id names nothing. The test's chain of 45 `Nest(inner : …)` structs
has id `""` and no type arguments, so every inner `Nest` rendered as `S:` and
every level from the second up had the same key. The cycle path then took the
second level for the first and returned false. Before #1329 the path compared
object addresses, so the levels were told apart.

Empty-id types exist outside tests: comptime struct values
(`src/value.yo`) and source namespaces (`src/types/creators.yo`).

#1329 merged without its `tests/internal` shards (they were cancelled by a
later push), which is how the failure reached develop.

## Fix

A visited token short-circuits the render only when its id is non-empty, in
all four arms. An empty-id type is rendered in full; the existing depth cap
(600) still ends a genuine object cycle such as the test's self-containing
struct.

## Test

- `tests/internal/types_utils.test.yo` › "raw-ptr predicate: a Ptr 45 levels
  down is found" fails before the fix and passes after.
- New: "type_memo_key: nested empty-id structs of different depth key apart"
  checks the key directly.
