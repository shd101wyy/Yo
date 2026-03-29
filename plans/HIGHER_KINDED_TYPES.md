# Higher-Kinded Types (HKTs) via Comptime Function Types as Kinds

**Status: ✅ Complete**

## Problem

Yo currently cannot express type constructor polymorphism — you can't write a generic `Functor` trait
that works over `Option`, `ArrayList`, `Result(_, E)`, etc. Type constructors (like `Option`) are
already first-class comptime function values, but the type system lacks:

1. A way to declare type variables with "function-type kinds" (e.g., `F : Type → Type`)
2. A symbolic representation for `F(A)` when `F` is abstract
3. Resolution of symbolic applications when `F` becomes concrete

## Approach

Use **comptime function types as kinds** — no separate kind system needed:

| Haskell Kind  | Yo Equivalent                                                  |
| ------------- | -------------------------------------------------------------- |
| `*`           | `Type`                                                         |
| `* -> *`      | `fn(comptime(T) : Type) -> comptime(Type)`                     |
| `* -> * -> *` | `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` |

Add a `TypeApplication` type node that represents `F(A)` symbolically when `F` is abstract.
Add explicit partial application via `_` placeholder for multi-param type constructors.

### Target syntax

```rust
// Define Functor trait — F is a type constructor (kind: Type → Type)
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Trait))(
  trait(
    Inner : Type,
    map : (fn(forall(B : Type), self: Self, f: (fn(a : Self.Inner) -> B)) -> F(B))
  )
);

// Implement Functor for Option
impl(forall(A : Type), Option(A), Functor(Option)(
  Inner : A,
  map : (fn(forall(B : Type), self: Self, f: (fn(a : A) -> B)) -> Option(B))(
    match(self,
      .Some(v) => .Some(f(v)),
      .None => .None
    )
  )
));

// Or more concisely using anonymous function (types inferred from trait):
// impl(forall(A : Type), Option(A), Functor(Option)(
//   Inner : A,
//   map : ((self, f) -> (
//     match(self,
//       .Some(v) => .Some(f(v)),
//       .None => .None
//     )
//   ))
// ));

// Use Functor in generic code via forall with function-type kind
do_map :: (fn(
  forall(F : (fn(comptime(T) : Type) -> comptime(Type)), A : Type, B : Type),
  container: F(A),
  f: (fn(a : A) -> B),
  where(F(A) <: Functor(F))
) -> F(B))(
  container.map(f)
);

// Partial application — fix one parameter of a multi-param type constructor
IntResult :: Result(_, i32);  // becomes fn(comptime(OkType) : Type) -> comptime(Type)
```

## Phases

### Phase 1: TypeApplication Type Node

Add the core type representation for symbolic type constructor application.

**Files:**

- `src/types/tags.ts` — add `TypeApplication` to TypeTag enum
- `src/types/definitions.ts` — define TypeApplicationType interface
- `src/types/utils.ts` — add type guard `isTypeApplicationType()` and constructor `createTypeApplicationType()`

**Design:**

```typescript
// In tags.ts
TypeApplication = "TypeApplication";

// In definitions.ts
interface TypeApplicationType extends Type {
  tag: TypeTag.TypeApplication;
  constructor: SomeType; // The abstract type constructor variable (F)
  args: Type[]; // Applied type arguments ([A, B, ...])
  resultKind: Type; // The result type (usually Type), inferred from constructor's return type
  trait: TraitType;
}
```

**Key constraint:** TypeApplication must NEVER reach codegen. Assert in codegen entry points.

### Phase 2: Function-Typed Forall Parameters

Allow forall parameters to have function-type kinds instead of just `Type`.

**Files:**

- `src/types/definitions.ts` — add `kindFunctionType?: FunctionType` field to SomeType
- `src/evaluator/types/function.ts` — extend forall parameter parsing to accept function types
- `src/evaluator/calls/helper.ts` — extend forall argument matching to validate kind compatibility

**Design:**

- SomeType keeps `parentType: TypeHierarchyType` for universe level (unchanged)
- New `kindFunctionType?: FunctionType` field stores the function-type kind when present
- Forall parsing: when the type annotation for a forall param is a FunctionType (not TypeHierarchyType),
  store it in `kindFunctionType` and use `Type` level for `parentType`
- Forall argument matching: when `kindFunctionType` is present, validate that the concrete argument
  is a comptime function value with compatible signature

### Phase 3: TypeApplication Creation in Evaluator

When `F(A)` is evaluated and `F` is a SomeType with function-type kind, create TypeApplication.

**Files:**

- `src/evaluator/calls/function.ts` — add SomeType-with-function-kind callee handling
- `src/evaluator/exprs/_expr.ts` — potentially handle TypeApplication in expression evaluation

**Design:**
Two scenarios create TypeApplication:

1. **F is a forall SomeType with kindFunctionType:**

   - Callee evaluates to a type value containing SomeType with `kindFunctionType`
   - Validate args against `kindFunctionType.parameters`
   - Create `TypeApplicationType(constructor: F, args: [evaluatedArgTypes])`
   - Return as type value with tag Type

2. **F is a comptime parameter (UnknownValue with function type):**
   - During comptime function body evaluation (e.g., inside `Functor` definition)
   - Callee is UnknownValue whose type is `fn(comptime(T):Type) -> comptime(Type)`
   - Can't call it — create TypeApplication instead
   - The "constructor" SomeType comes from the parameter binding

**Important:** When `F` IS a concrete function value (e.g., `Option`), call it normally — no TypeApplication.
TypeApplication is only for abstract/unknown constructors.

### Phase 4: TypeApplication Resolution

Resolve TypeApplications when their constructor SomeType gets bound to a concrete type constructor.

**Files:**

- `src/evaluator/calls/helper.ts` — extend type substitution to handle TypeApplication
- `src/types/utils.ts` — add `resolveTypeApplication()` helper
- `src/evaluator/calls/comptime-fn.ts` — ensure resolution during comptime calls and handle cache interaction

**Design:**

```typescript
function resolveTypeInContext(
  type: Type,
  substitutions: Map<SomeType, Type>
): Type {
  if (isTypeApplicationType(type)) {
    const resolvedConstructor = substitutions.get(type.constructor);
    if (resolvedConstructor) {
      // Constructor is now concrete — call it with (potentially resolved) args
      const resolvedArgs = type.args.map((a) =>
        resolveTypeInContext(a, substitutions)
      );
      // Call the concrete type constructor function with resolvedArgs
      return callComptimeFunction(resolvedConstructor, resolvedArgs);
    }
    // Constructor still abstract — preserve TypeApplication with resolved args
    return createTypeApplicationType(
      type.constructor,
      type.args.map((a) => resolveTypeInContext(a, substitutions))
    );
  }
  // ... handle other types recursively (Struct fields, Enum variants, Function params, etc.)
}
```

**Key change:** The current shallow substitution in `createSpecializedFunctionInline` must become
recursive, traversing into nested types (Array element types, Struct fields, Function params/return, etc.)
to find and resolve TypeApplications.

**Comptime function caching interaction** (`comptime-fn.ts`):

- Type-returning functions are cached via `FunctionValue.calledComptimeFunctionCaches` (only when
  `isTypeHierarchyType(returnType)` is true — see `shouldCache` check).
- When `Functor(Option)` is called, the result (a Trait containing concrete types like `Option(A)`)
  is cached with `argValues: [Option]`. Subsequent calls with the same arg hit the cache.
- When `Functor(SomeType_F)` is called (during abstract evaluation from `do_map` specialization),
  the result (a Trait containing TypeApplications like `TypeApp(F, [A])`) gets cached with
  `argValues: [SomeType_F]`. Cache key matching uses ID-based SomeType comparison, so different
  SomeTypes with different IDs won't collide.
- When resolving TypeApplications post-specialization, the resolved types should NOT pollute the
  original cache — create a fresh resolved copy instead.

Substitution points:

- `createSpecializedFunctionInline` in `helper.ts` — primary specialization path
- Comptime function caching in `comptime-fn.ts` — cache key/value may contain TypeApplications
- Where-clause evaluation — resolving constraints like `where(F(A) <: Trait)`

### Phase 5: TypeApplication Compatibility

Add type compatibility rules for TypeApplication.

**Files:**

- `src/types/compatibility.ts` — add TypeApplication cases

**Rules:**

1. `TypeApp(F, [A]) ≡ TypeApp(F, [A])` — same constructor, compatible args → compatible
2. `TypeApp(F, [A]) ≡ ConcreteType` — only if constructor is resolved and application yields ConcreteType
3. `TypeApp(F, [A]) ≡ TypeApp(G, [B])` — compatible if F≡G and A≡B (structural)

### Phase 6: Explicit Partial Application

Add `_` placeholder syntax for partial application of comptime functions.

**Files:**

- `src/lexer.ts` — recognize `_` as a placeholder token (or reuse existing underscore handling)
- `src/parser.ts` — handle `_` in function call arguments
- `src/evaluator/calls/comptime-fn.ts` — implement partial application logic

**Design:**
When a comptime function call contains `_` placeholders:

1. Identify which parameters have `_` (these become the new function's params)
2. Identify which parameters have concrete values (these are captured)
3. Create a new FunctionValue:
   - Parameters: only the `_` positions, with types from original function
   - Body: calls the original function with captured + new params
   - Return type: same as original

Example: `Result(_, MyError)` →

```
fn(comptime(__0) : Type) -> comptime(Type) {
  return Result(__0, MyError);
}
```

### Phase 7: Tests and Validation

**Files:**

- `tests/higher_kinded_types.test.yo` — integration tests

**Test cases:**

1. Basic TypeApplication — forall param with function kind, F(A) in body
2. Functor trait definition and Option impl
3. Generic function using HKT (do_map)
4. Partial application with `_` placeholder
5. Multi-param type constructors (Result(\_, E))
6. Nested TypeApplication (F(F(A)))
7. TypeApplication in trait where-clauses
8. Comptime assertions on HKT types
9. Ensure TypeApplication never reaches codegen (should be fully resolved)
10. Error cases: wrong kind arity, non-type-constructor in HKT position

## Edge Cases and Risks

1. **Shallow substitution** — The current `substituteType` in `helper.ts` is shallow (only direct SomeType matches). Must be made recursive to resolve TypeApplications inside nested types. This is the riskiest change — it touches the core specialization path.

2. **Comptime function caching** — Type-returning comptime functions cache results via `CalledComptimeFunctionCache` in `comptime-fn.ts` (gated by `shouldCache = isTypeHierarchyType(returnType)`). Cache keys use ID-based SomeType matching. When a TypeApplication appears in cached results (e.g., `Functor(SomeType_F)` returns a Trait with `TypeApp(F, [A])`), resolution must create fresh copies rather than mutating cached values. Two `TypeApp(F, [A])` with same F.id and compatible A should hit the same cache.

3. **Trait resolution with abstract types** — `where(F(A) <: Functor(F))` creates a deferred constraint. Need to decide: validate eagerly (requires TypeApplication-aware trait matching) or defer until specialization.

4. **RC/ownership analysis** — TypeApplication has unknown size/semantics until resolved. The RC analyzer must handle or skip TypeApplication nodes (they should be resolved before RC analysis runs).

5. **Error messages** — TypeApplication should format nicely: `F(A)` not `TypeApplication(SomeType#42, [SomeType#43])`.

## Implementation Order

Phase 1 → Phase 2 → Phase 3 → Phase 5 → Phase 4 → Phase 6 → Phase 7

Phase 5 (compatibility) before Phase 4 (resolution) because the evaluator needs compatibility
checks while building types with TypeApplications before resolution happens.

## Implementation Notes

### Phase 1–3: Core Type System (Complete)

- `TypeApplication` added to TypeTag enum, with full type interface, guard, creator, toString, and compatibility.
- `SomeType.kindFunctionType` stores the function-type kind for HKT forall params.
- `createUnknownValue` detects function-type-kinded forall params and creates SomeType with `kindFunctionType`.
- In `evaluateFunctionCall` (function.ts), when callee is SomeType with `kindFunctionType`, creates `TypeApplicationType` instead of attempting a function call.

### Phase 4: TypeApplication Resolution (Complete)

Key challenge: generic impl re-evaluation for HKT traits.

- Added where-clause constraint storage for TypeApplications in `env.ts`:
  `typeApplicationConstraintKey()`, `addWhereClauseConstraintForTypeApplication()`, `getWhereClauseConstraintsForTypeApplication()`.
- Modified `getReceiverMethodsByNameFromEnv` to check TypeApplication constraints for method dispatch.
- Modified `parseWhereClauseConstraints` in `function.ts` to handle TypeApplication LHS.
- **Critical fix in `reEvaluateFunctionType` (impl.ts):**
  - The function type's `env` does NOT include forall params (they're in `parametersFrame`).
  - Must temporarily add unresolved forall params back into `reEvalEnv` for type expression re-evaluation.
  - But the returned `env` must NOT include these forall params — otherwise call-site forall arg processing will hit variable shadowing errors.
  - Solution: separate `reEvalEnv` (with forall params, used for re-evaluation) from `baseEnv` (without, stored in result).
- **Method call forall detection:** When `x.map(forall(i32), ...)` is processed, the call args become `[self, forall(i32), closure]`. Added detection for forall at index 1 (after prepended self) in `helper.ts`.

### Phase 5: TypeApplication Compatibility (Complete)

- `TypeApp(F, [A]) ≡ TypeApp(G, [B])` iff `F.id === G.id` and all args compatible.

### Phase 6: Partial Application with `_` (Complete)

- No lexer/parser changes needed — `_` is already tokenized as an identifier.
- Detection added in `evaluateFunctionCall` (function.ts): when calling any comptime function with `_` args (the function must have `return.isCompileTimeOnly`).
- Works on type constructors (`comptime(Type)` return) AND comptime value functions (`comptime(i32)`, `comptime(bool)`, etc.).
- Creates a synthetic `FunctionValue` that:
  - Captures non-`_` args as variables in the closure env.
  - Takes `_` positions as parameters.
  - Body is a `FnCallExpr` calling the original function with mixed captured + parameter refs.
- Examples:
  - `Result(_, MyError)` → `fn(comptime(__pa_0) : Type) -> comptime(Type)` that calls `Result(__pa_0, MyError)`.
  - `add(1, _)` → `fn(comptime(__pa_1) : i32) -> comptime(i32)` that calls `add(1, __pa_1)`.

### Phase 7: Tests (Complete)

- `tests/higher_kinded_types.test.yo` — 23 integration tests covering all features.

## Non-goals (for now)

- Associated type constructors in traits (Path B) — can be added later on top of this
- Kind inference (auto-detecting that a param should have function kind) — require explicit annotation
- Higher-rank kinds (kind of a kind) — not needed for practical HKTs
- Type-level pattern matching on TypeApplications — future work
