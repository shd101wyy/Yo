# `forall` instantiation is lost when calling polymorphic functions through struct fields

**Status:** Open. Discovered while migrating `std/prelude.yo` IO from
`module(...)` to `struct(...)` (Phase 3 of `plans/UNIFY_MODULE_AND_STRUCT.md`).

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

## Related

- `plans/UNIFY_MODULE_AND_STRUCT.md` — Phase 3 status notes.
- `tests/algebraic_effects.test.yo` — proves struct(...) DOES work for
  monomorphic effect records (60/60 pass including 2 new struct-based
  effect tests).
- Tracking todo: `p3-forall-struct-field`.
