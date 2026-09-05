# Plan: Add `forall` Support to `impl`
> **ARCHIVED 2026-09-04 — NOT ADOPTED (TS-era planning prompt).** Generic impls
> shipped via the `impl(generic(T : Type), ...)` channel (e.g. std/prelude.yo's
> `Arc(T) : Send`); the `impl(forall(...))` spelling proposed here was not adopted.


Support `impl(forall(T : Type), Data(T), Copy())` syntax to enable generic module implementations for type constructors like `Data(T)`.

Also support `where` clause for constrained generic impls:

```rust
impl(forall(T : Type), where(T <: Copy), Array(T, Size), Copy());
```

## Syntax Variants

1. `impl(ReceiverType, Module(...))` - Direct impl (existing)
2. `impl(forall(...), ReceiverTypePattern, Module(...))` - Generic impl (3 args)
3. `impl(forall(...), where(...), ReceiverTypePattern, Module(...))` - Constrained generic impl (4 args)

Note: `where` must come after `forall` and is optional. `forall` must be the 1st arg if present, `where` must be the 2nd arg if present.

## Steps

### 1. Parse `forall` and `where` as first arguments in `impl`

**File:** `src/evaluator/values/module.ts` - `evaluateModuleValue`

- Detect 3-argument case: `impl(forall(...), ReceiverTypePattern, Module(...))`
- Detect 4-argument case: `impl(forall(...), where(...), ReceiverTypePattern, Module(...))`
- Reuse forall parameter parsing logic from `evaluateAnonymousFunctionExpr` in `src/evaluator/values/anonymous_function.ts`
- Create `SomeType` for each forall parameter using `createSomeType`
- Parse `where` constraints (reuse logic from function's where clause handling)

### 2. Create generic impl registry

**File:** `src/evaluator/values/module.ts`

- Add `GenericImpl` interface storing:
  - `forallParameters` - the type parameters (T, Size, etc.)
  - `whereConstraints` - the constraints from where clause (T <: Copy, etc.)
  - `receiverTypePattern` - contains SomeTypes (e.g., `Data(T)`)
  - `moduleType` - the module being implemented (e.g., Copy)
  - `moduleValue` - the module value
  - `sourceModulePath` - for cleanup on re-evaluation
- Add `genericImplRegistry: Map<string, GenericImpl[]>` keyed by module type name
- Add `clearGenericImplsFromModule(modulePath)` for cleanup on re-evaluation

### 3. Evaluate receiver type pattern with SomeTypes in scope

- Add forall parameter SomeTypes to environment before evaluating `Data(T)`
- Apply where clause constraints to the SomeTypes (add to their module fields like in function where clause)
- The resulting type will contain SomeTypes (e.g., `struct(value: T)` where T is SomeType)
- Store this pattern type in the generic impl registry (don't attach to a concrete type)

### 4. Update `typeImplementsTrait`

**File:** `src/evaluator/exprs/subtype_of.ts`

- After checking direct impls, check `genericImplRegistry` for matching patterns
- Add `findMatchingGenericImpl(concreteType, moduleType)` that:
  1. Unifies concrete type against patterns (e.g., `Data(i32)` matches `Data(T)` with `T=i32`)
  2. Checks that the unified type bindings satisfy the where constraints (e.g., `i32 <: Copy`)
- Use existing `synthesizeType` infrastructure for unification

### 5. Update module manager

**File:** `src/module-manager.ts`

- Call `clearGenericImplsFromModule` alongside `clearImplsFromModule` before re-evaluation

## Further Considerations

1. **Should generic impls be lazily instantiated?** When `Data(i32) <: Copy` is checked, we could either just return true, or actually instantiate and attach the impl to `Data(i32)`. Lazy instantiation would be cleaner but requires changes to method lookup. Recommend: just check for match, don't instantiate.

2. **How to handle builtin types like `Array(T, Size)`?** The same pattern should work - `Array` returns a type when called. Need to verify `Array` is implemented as a function returning `comptime(Type)` like `Data`. If not, may need special handling.

3. **Cleanup strategy for generic impls?** The `sourceModulePath` tracking should work the same way as direct impls - store it and filter on re-evaluation.

4. **Where clause constraint checking:** When matching a generic impl, we need to verify that the concrete type bindings satisfy all where constraints. For example, `impl(forall(T), where(T <: Copy), Array(T, 5), Eq())` should only match `Array(i32, 5)` if `i32 <: Copy`.
