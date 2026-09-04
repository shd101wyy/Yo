# Carry generic type arguments on `TypeValue.Struct` (faithful port of `StructType.env`)
> **ARCHIVED 2026-09-04 — TS-ERA PORTING DOC.** The StructType.env recovery it
> ports ships in src/evaluator/types/struct.yo; the TS reference is retired
> (tag src-attic-final).


## Why

`Self.method()` dispatched inside a specialized generic method loses the type
arguments: the bare instantiated type (`HashMap(String,String)`, an object =
`Struct`) carries no record of `K=String, V=V`, so the dispatched method's
`forall` params stay abstract `SomeT`. TS recovers them from
`StructType.env` (the instantiation env). See
`issues/fixed/self-dispatch-loses-type-args.md` for the full diagnosis + minimal
cross-module reproducer.

This is the current head of the generic-method-resolution knot and blocks
`std/encoding/html.yo` (hence ~all of `check ./yo-self`).

## Design

Add `type_arguments : ArrayList(TypeValue)` to `TypeValue.Struct` (the 9th
field, after `constructor_func_id`). It holds the concrete type arguments of a
generic instantiation, in constructor-parameter order
(`HashMap(String,String)` → `[String, String]`). Empty for non-generic / not-
yet-instantiated structs. This mirrors `StructType.env` faithfully enough: a
method dispatched on the struct binds its `forall` params positionally from
`type_arguments`.

(`EnumT` may need the same later for enum generics; defer until a test needs it.
Object types are `Struct` with `is_reference_semantics=true`, so `HashMap` is
covered by the `Struct` field.)

## Stages

1. **Schema + threading.** Add the field to `types/definitions.yo`. Fix every
   positional `.Struct(...)` construction (pass the value — usually
   `ArrayList(TypeValue).new()`) and pattern match (bind/ignore the 9th field).
   ~92 sites / 49 files; build-guided (the compiler flags each arity mismatch).
   Curly `.Struct({...})` matches are unaffected. Neutral: std 150/151,
   ./tests 66/82, regressors green.
2. **Populate at instantiation.** At the comptime-fn return site
   (`calls/comptime_fn.yo`, where `constructor_func_id` is stamped from
   `all_arg_vals`), extract the type-valued args into `type_arguments`.
3. **Preserve through substitution.** `types/substitution.yo` already preserves
   `constructor_func_id`; also substitute/preserve `type_arguments`.
4. **Consume at dispatch.** In `calls/function.yo`, when binding a method's
   `forall` params: for any param not inferable from call args, bind it from the
   receiver type's `type_arguments` by position. Covers both the literal-receiver
   primary case (`HashMap(String,String).new()`) and the `Self`-dispatch
   secondary case uniformly.

## Validation (each stage)

- Minimal repro (`issues/fixed/self-dispatch-loses-type-args.md`) passes.
- `std/encoding/html.yo` error moves past `hash_map.yo:59`.
- `check ./std` per-file: only html.yo may change; regressors
  (imm_vec/imm_threading/priority_queue) stay green.
- `check ./tests` per-file: no regressions vs HEAD (baseline 66/82).
