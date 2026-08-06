# `forall` instantiation is lost when calling polymorphic functions through struct fields

**Status:** RESOLVED (2024-XX). Fixed in commit `9c5b14a6` by propagating
`ioBuiltin` markers from extern function types to struct field types in
`src/evaluator/calls/type.ts`.

**Original context:** Discovered while migrating `std/prelude.yo` IO from
`module(...)` to `struct(...)` (Phase 3 of `plans/archive/UNIFY_MODULE_AND_STRUCT.md`).

## Root cause

The real failure mode was not a forall-freshness bug per se — it was that
extern function fields (like `io_async`, `io_await`, `io_spawn`) carry an
`ioBuiltin` marker that the IO-call paths use to invoke the specialized
runtime path. `module-type.ts` propagates that marker to the module's field
types when constructing the module value (lines 205-208). The struct
constructor in `type.ts` did not, so when IO was a struct, those field types
lost the marker and `io.await(...)` etc. fell back to a generic polymorphic
call. Because the underlying functions are extern (no body), generic
specialization cannot infer `T` from argument types and returns `T` as the
result type — which then fails downstream type checks (e.g. `IOError.check`
expecting `i32`).

## Fix

`src/evaluator/calls/type.ts` now mirrors `module-type.ts`:

```typescript
if (argType.ioBuiltin && isFunctionType(memberElement.type)) {
  memberElement.type.ioBuiltin = argType.ioBuiltin;
}
```

## Remaining follow-up

Migrating `std/prelude.yo` IO to `struct(...)` still fails the
`tests/async_await.test.yo` "lazy async" test with a C codegen error
(forward-declared future-trait struct never gets a definition emitted).
That is a codegen issue, tracked separately, and does not block runtime
given/using (Phase 4) which can be exercised on user-defined structs.

## Symptom

Naively rewriting

```rust
IO :: module(
  await : (fn(forall(T : Type, ...(E)), fut : Impl(Future(T, ...(E))), using(...(E))) -> T),
  ...
);
```

to

```rust
IO :: struct(
  await : (fn(forall(T : Type, ...(E)), fut : Impl(Future(T, ...(E))), using(...(E))) -> T),
  ...
);
```

makes call sites that depend on `forall(T)` being inferred fresh per-call
fail at type checking. Concretely, `std/process/command.yo` lines around 198:

```rust
io.async((using(io, exn)) => {
  ...
  pid := io.await(IO_process.spawn(...));
  ...
  IOError.check(pid)
})
```

errors with:

```
Error: Type mismatch for parameter "result":
    Expected: i32
    Got:   T

  IOError.check(pid)
                ^
```

`IOError.check` expects `result : i32`, and `pid` is supposed to be inferred
to `i32` via `await`'s `forall(T)`. With `IO :: module(...)` this works.
With `IO :: struct(...)` (still nominal, same field shape) the `T` leaks.

## Reproduction

```bash
cd /Users/yiyiwang/Workspace/Yo
sed -i.bak 's/^IO :: module(/IO :: struct(/' std/prelude.yo
./yo-cli compile std/process/command.yo --release --emit-c --skip-c-compiler
# → Error: Type mismatch for parameter "result": Expected: i32, Got: T
```

Migrating only `Exception` to struct (without touching IO) does **not**
trigger the issue. It is specifically about IO's polymorphic `await` being
called through a struct field.

## Hypothesis

When `IO` is a `module(...)`, fields are implicitly compile-time. Accessing
`io.await` produces a function value whose `forall` parameters are still
"fresh" — the call site instantiates `T` and the spread `...(E)` per call.

When `IO` is a `struct(...)`, fields are runtime by default. Either:

- `evaluateTypeField` evaluates the field's function type once and freezes
  `T` in some shared frame (vs `evaluateModuleField` which may re-evaluate or
  push a fresh frame per access), **or**
- the struct constructor `IO(async: __yo_io_async, ...)` runs a compatibility
  check that unifies the polymorphic `__yo_io_async`'s `T` with the field
  type's `T` and pins both, **or**
- `property-access.ts`'s struct branch returns the value directly while the
  module branch creates a fresh-typed view per access.

The struct and module branches in `property-access.ts` look structurally
similar (both retrieve `value.fields[idx]`), so the most likely culprit is in
field-type evaluation (`src/evaluator/types/field.ts` vs
`src/evaluator/types/module.ts`) or in the struct constructor at
`src/evaluator/types/function.ts:2289-2295`.

## Workaround

Marking struct fields as `::` (compile-time only) preserves forall behavior
but changes the struct's kind from `Type(0)` to `Type(1)` (i.e. it acts like
the old `Module` metaclass), which then breaks
`comptime(Type)` return-type annotations on functions that build effect
records (e.g. `ResumableException`'s
`(fn(...) -> comptime(Module))(struct(...))` would need to stay `Module`).

## Impact

Blocks Phase 3e/3f of the Module/Struct unification: `std/prelude.yo`'s
`IO`, `std/error.yo`'s `Exception`/`ResumableException`, and any user-facing
`module(...)` cannot be migrated to `struct(...)` until forall freshness
is preserved on nominal struct field calls.

## Failed fix attempts

### Attempt 1: Mirror module-type.ts `specializedType` setting in struct constructor

`src/evaluator/calls/module-type.ts:217-231` sets
`argValue.specializedType = moduleFieldType` for function-typed module
fields. Hypothesis: this preserves the field's polymorphic forall as a
"fresh template" for instantiation per call, instead of letting forall
bindings leak into `argValue.type` across calls.

Tried adding the same logic to `src/evaluator/calls/type.ts`
(`tryToCallTypeWithArguments`) right after the type-compatibility check.

**Result: Did NOT fix the bug.** `pid := io.await(...)` still infers `T`
instead of `i32`. The actual divergence is elsewhere — likely deeper in
the call-specialization path, where struct field calls take a different
code path than module field calls. Possible suspects:

- `src/evaluator/calls/function.ts:520` — module values are handled as
  callable via the `"Call"` element extraction; struct values are not.
- `src/evaluator/calls/helper.ts:2359` (`isModuleType(param.type)`) and
  `:3571` — implicit-parameter resolution has module-specific branches.
- `src/evaluator/calls/comptime-fn.ts:270` —
  `isModuleType(returnedType)` affects comptime-vs-runtime function
  dispatch for the call itself.

A correct fix likely needs to add struct-aware branches to several of
these sites, or unify the dispatch entirely. This is non-trivial and
warrants a focused investigation in a follow-up session.

## Related

- `plans/archive/UNIFY_MODULE_AND_STRUCT.md` — Phase 3 status notes.
- `tests/algebraic_effects.test.yo` — proves struct(...) DOES work for
  monomorphic effect records (60/60 pass including 2 new struct-based
  effect tests).
- Tracking todo: `p3-forall-struct-field`.
