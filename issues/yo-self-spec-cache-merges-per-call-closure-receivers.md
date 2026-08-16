# yo-self's specialization cache merges receivers that differ only in a closure-`F` type argument — one spec serves three C types

**Status: FIXED 2026-08-16** (the wasm legs' third `--bail` casualty on
PR #127: `tests/iter_filter_closure.test.yo`, batch 74 — after the era-split
and sizeof fixes let the suite run past batches 46/61).

## Symptom

Three `iter.filter(<closure>)` call sites → three `filter` specs and three
`IterFilter` C types (`__yo_t2/__yo_t14/__yo_t16`), but only ONE blanket
`Iterator.next` spec, typed `(__yo_t2* self)`. The other two call sites pass
their own pointers to it:

```
error: incompatible pointer types passing '__yo_t14 *' to parameter of
       type '__yo_t2 *' [-Wincompatible-pointer-types]
```

2 diagnostics — warnings on native clang (tests "pass"; latent since the
family landed), hard errors on emcc 6 / clang 16+ / GCC 14+.

Reproducer: `issues/repros/iter-filter-closure-capture-merge.yo`
(compile with `--emit-c` and syntax-check with
`-Wincompatible-pointer-types`; `yo compile` passes `-w`, so rc alone
proves nothing). TS emits three `next` specs, zero diagnostics.

## Root cause

`_find_specialization_cache` compares runtime parameter types with
`are_types_compatible_exact`. The three receivers are
`IterFilter(CountIter, F)` instantiations sharing the def-era `F` SomeT —
compat-EQUAL by id — while the per-call closure identity lives only in `F`'s
resolution cell chain. codegen's `type_key` DOES resolve that chain
(`_tk_resolve_arg_slot`: `F → __impl_fn → <capture struct>`), so the three
receivers get three C types; the cache reused one spec across all three.

The existing `clfid` cache-key extras cover closures passed as ARGUMENTS
(that is why `filter` itself split correctly); a closure buried in a
RECEIVER'S type arguments had no discriminator. TS cannot collide here: each
instantiation is a distinct object with a unique type id and the cache
compares with strict type-ID matching (helper.ts:2290), plus per-object
`specializedFunctionCaches`.

## Fix

In `_find_specialization_cache`'s runtime-type compare: after an exact-compat
match, when the type's type_arguments carry a SomeT
(`_collect_type_arg_somes` > 0), also require **`type_key` equality** — the
exact identity the emitted C is keyed by. Two types that would lower to
different C structs can never share a specialization. The extra check is
scoped to the tyarg-SomeT family, so plain concrete types keep the cheap
compare and def-era bare↔bare reuse is untouched.
