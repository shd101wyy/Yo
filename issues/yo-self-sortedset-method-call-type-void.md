# yo-self: `SortedSet(i32).new().is_empty()` call-result type lost → assert specialized with `void flag`

Status: OPEN — 9-line differential isolated 2026-07-17. One of the two
remaining big #69/#70 emission layers (the other: struct-mismatch t42/t49
in arc/hash_map batches).

## Repro (src/tests/fixme.yo shape; TS prints ok, s1 emits 7 clang errors)

```rust
open(import("std/string"));
open(import("std/fmt"));
{ assert } :: import("std/assert");
{ SortedSet } :: import("std/imm/sorted_set");
main :: (fn() -> unit)({
  s := SortedSet(i32).new();
  assert(s.is_empty(), "new set should be empty");
  println(`ok`);
});
export(main);
```

s1's emitted C declares the assert specialization as
`static inline void yo_id_5002_str_id_str_rtparam1_comptime_str_ret_unit(void flag, __yo_str msg);`
— the `flag` param typed VOID and contributing NO signature segment: the
`s.is_empty()` call's RESULT TYPE was missing at the assert call's
specialization time.

## Context

- `SortedSet(T)` methods come from a specific-pattern generic impl WITH a
  where clause: `impl(forall(T), where(T <: (Eq(T), Ord(T), Send)),
SortedSet(T), is_empty : (fn(self : Self) -> bool)(...))`
  (std/imm/sorted_set.yo:28-39). Resolution path:
  `_try_find_receiver_method` → `get_receiver_methods_by_name_from_env` →
  generic-impl fallback → `find_methods_from_generic_impls` →
  `try_match_generic_impl` (base-name prefilter now admits
  `SortedSet(T)` vs `SortedSet(i32)`; where-clauses on specific patterns
  are SKIPPED by design) → candidate method type substituted via
  `substitute(spec_s, ftype)`.
- The class predates this session's resolution fixes (round-1
  async_await already showed void-param leftovers), but files now reach
  it after the earlier layers were fixed.

## Hunt plan

Probe `find_methods_from_generic_impls`' candidate for `is_empty` on
`SortedSet(i32)` (the [FMGI]/[TMGI] pattern from the session — NEVER
inside `->` handlers): print the substituted `method_type`. Expected
`fn(self : SortedSet(i32)) -> bool`; suspicion: the substitution leaves
`Self`/return unresolved (bool is fine — more likely `self`'s type or the
whole Func meta), or the CALL path discards the candidate's type and
re-derives from a FuncVal that carries none (`FuncVal values carry no
type` — the known reconstruction gap), leaving the call expr's ExprInfo
type unit. Then compare with TS `findMethodsFromGenericImpls`'
`shouldCreateSpecializedValue` / type-only-specialization flow
(impl.ts:1337-1392) for where the type is preserved.
