# A higher-kinded return type `F(A)` is never applied at the call site

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 2).
**Status:** FIXED 2026-09-24 (Phase 2.4 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Was: a completeness bug — a
documented feature (kind-annotated `generic(F : ...)`) could not be used as a result type.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
identity :: (fn(generic(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type), x : F(A)) -> F(A))(x);
main :: (fn() -> unit)({
  o := Option(i32).Some(i32(1));
  r := identity(o);
  (r2 : Option(i32)) = r;
});
export(main);
```

```
error[E0601]: Incompatible types: Expected Option(i32), Given TypeApp(F, [A])
```

## Mechanism (READ)

`F(A)` is represented as `TypeAppT(constructor : SomeT, args)` (`src/types/definitions.yo`). The
forall binder binds `F` and `A` at the call, but the result type is substituted without
re-applying the bound constructor to the bound arguments, so the `TypeAppT` node survives. The
message also leaks the internal `TypeApp` spelling.

## Fix direction

After forall binding, normalize every `TypeAppT` whose constructor is now bound by evaluating the
constructor on the substituted arguments (through the CTFE memo, so the result shares identity
with a direct `Option(i32)`).

## Root cause (2026-09-24, MEASURED)

The READ mechanism above was half the story. The return re-evaluation that applies `F(A)`
already exists (`_evaluate_funcval_runtime_call`'s `hkt_ret_binder` arm re-evaluates the
declared return EXPRESSION with the binders in scope); it produced nothing because `F` was never
BOUND: no synthesis case unified a `TypeApp(F, [A])` parameter with a nominal instantiation like
`Option(i32)`, so only an explicit `identity(generic(Option, i32), x)` worked. With the Phase 2.4
E0613 check the repro reported `Cannot infer the type parameter "F"`.

## Fix

- `src/value.yo`: `g_type_ctor_values`, the constructor VALUE per constructor func-id, recorded by
  `evaluate_comptime_fn_call` whenever a comptime function returns a type.
- `src/evaluator/types/synthesizer.yo`: TypeApp (`F(A)`) against a nominal instantiation — the
  instantiation's constructor id (`Struct.constructor_func_id` / `lookup_enum_cfid`) and type
  arguments (`type_arguments` / `lookup_enum_type_arguments`) — binds `F` to the constructor's
  value and each argument pairwise.
- `_funcval_bind_foralls`' structural fallback accepts a function-VALUE binding.

The re-evaluation then reduces `F(A)` to the canonical `Option(i32)` through the ctor memo.

## Verification

The repro compiles and prints the payload. `tests/type_soundness.test.yo` ("F(A) infers F and A"
for `Option(i32)` and `ArrayList(i32)`); `tests/higher_kinded_types.test.yo` 20/20.
