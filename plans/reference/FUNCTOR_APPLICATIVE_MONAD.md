# Concrete Methods for Option and Result — std/prelude.yo

**Status: ✅ Complete**

## Goal

Add practical functional methods (`map`, `and_then`, `filter`, `map_err`, etc.) directly to `Option` and `Result` in `std/prelude.yo`. No HKT traits — just straightforward instance methods.

The HKT infrastructure exists for users who need generic Functor/Applicative/Monad — they can define those traits in their own code (see `tests/higher_kinded_types.test.yo` for examples).

---

## Design

### Approach: Concrete methods only

Instead of baking Haskell's typeclass hierarchy (Functor/Applicative/Monad) into the prelude, we add methods directly to `Option` and `Result` impl blocks — like Rust, Swift, and Kotlin.

**Why not HKT traits in prelude?**

- Most users just want `option.map(f)`, not `Functor(F)` generic programming
- Concrete methods don't need explicit `forall` args — types are inferred from closures
- Zero cognitive overhead — method names are self-documenting
- Users who need generic HKT programming can define their own traits

### Implemented methods

#### Option(T)

| Method           | Signature                                                                     | Description                            |
| ---------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| `map`            | `(forall(B), self, f: Impl(Fn(a: T) -> B)) -> Option(B)`                      | Transform inner value                  |
| `and_then`       | `(forall(B), self, f: Impl(Fn(a: T) -> Option(B))) -> Option(B)`              | Transform + flatten (monadic bind)     |
| `filter`         | `(self, pred: Impl(Fn(a: T) -> bool)) -> Option(T)`                           | Keep `Some` if predicate passes        |
| `or_else`        | `(self, f: Impl(Fn() -> Option(T))) -> Option(T)`                             | Fallback if `None`                     |
| `flatten`        | `(self: Option(Option(T))) -> Option(T)`                                      | Unwrap nested Option                   |
| `map_or`         | `(forall(B), self, default: B, f: Impl(Fn(a: T) -> B)) -> B`                  | Map with default on None               |
| `map_or_else`    | `(forall(B), self, default_fn: Impl(Fn() -> B), f: Impl(Fn(a: T) -> B)) -> B` | Map with lazy default on None          |
| `ok_or`          | `(forall(E), self, err: E) -> Result(T, E)`                                   | Convert to Result with error on None   |
| `ok_or_else`     | `(forall(E), self, err_fn: Impl(Fn() -> E)) -> Result(T, E)`                  | Convert to Result with lazy error      |
| `and`            | `(forall(B), self, optb: Option(B)) -> Option(B)`                             | Return optb if self is Some, else None |
| `or`             | `(self, optb: Option(T)) -> Option(T)`                                        | Return self if Some, else optb         |
| `unwrap_or_else` | `(self, f: Impl(Fn() -> T)) -> T`                                             | Unwrap with lazy fallback              |

#### Result(OkType, ErrorType)

| Method           | Signature                                                                                      | Description                     |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------------------------------- |
| `map`            | `(forall(B), self, f: Impl(Fn(a: OkType) -> B)) -> Result(B, ErrorType)`                       | Transform Ok value              |
| `map_err`        | `(forall(F), self, f: Impl(Fn(e: ErrorType) -> F)) -> Result(OkType, F)`                       | Transform Err value             |
| `and_then`       | `(forall(B), self, f: Impl(Fn(a: OkType) -> Result(B, ErrorType))) -> Result(B, ErrorType)`    | Transform + flatten (bind)      |
| `or_else`        | `(forall(F), self, f: Impl(Fn(e: ErrorType) -> Result(OkType, F))) -> Result(OkType, F)`       | Fallback on Err                 |
| `and`            | `(forall(B), self, res: Result(B, ErrorType)) -> Result(B, ErrorType)`                         | Return res if Ok, else Err      |
| `or`             | `(forall(F), self, res: Result(OkType, F)) -> Result(OkType, F)`                               | Return self if Ok, else res     |
| `ok`             | `(self) -> Option(OkType)`                                                                     | Convert Ok to Some, Err to None |
| `err`            | `(self) -> Option(ErrorType)`                                                                  | Convert Err to Some, Ok to None |
| `map_or`         | `(forall(B), self, default: B, f: Impl(Fn(a: OkType) -> B)) -> B`                              | Map with default on Err         |
| `map_or_else`    | `(forall(B), self, default_fn: Impl(Fn(e: ErrorType) -> B), f: Impl(Fn(a: OkType) -> B)) -> B` | Map with lazy default on Err    |
| `unwrap_or_else` | `(self, f: Impl(Fn(e: ErrorType) -> OkType)) -> OkType`                                        | Unwrap with lazy fallback       |

Note: All callback parameters use `Impl(Fn(...))` (statically dispatched closures) instead of bare `fn(...)` (function pointers). This allows callers to capture variables from their scope using `(x) => expr` syntax.

---

## Implementation Notes

### Compiler bug fixes required

Two compiler bugs were discovered and fixed during implementation:

1. **Nested forall SomeType inference** (`src/evaluator/values/anonymous-function.ts`): When a forall type param `B` appears nested inside a return type (e.g., `fn(a: T) -> Option(B)`), `B`'s concrete type wasn't being inferred from the closure body evaluation. Fixed by adding `resolveNestedSomeTypes` helper that recursively walks type trees.

2. **cond/match expectedType override** (`src/evaluator/exprs/cond.ts`, `match.ts`): `cond` and `match` forced result types to `expectedType` even when it contained unresolved SomeTypes (e.g., `Option(B)`), losing the concrete type info from branch evaluation. Fixed by checking `typeContainsSomeType` before using expectedType.

### Implementation structure in prelude.yo

- **Option combinators**: New `impl(forall(T : Type), Option(T), ...)` block after existing Option impl
- **Option flatten**: Separate `impl(forall(T : Type), Option(Option(T)), ...)` block (specialized self type)
- **Result combinators**: New `impl(forall(OkType : Type, ErrorType : Type), Result(OkType, ErrorType), ...)` block after existing Result impl
- **Option→Result conversions**: Separate impl block after Result definition (needs Result to be defined first)

### Method naming: `and_then` not `flat_map`

Yo follows Rust's naming convention: `and_then` instead of Haskell's `>>=`/`bind` or Scala's `flatMap`. This is consistent with the overall Rust-inspired design of the standard library.

---

## Phases

### Phase 1: Option methods (map, and_then) — ✅ Done

### Phase 2: Option methods (filter, or_else, flatten, map_or, map_or_else, ok_or, ok_or_else, and, or, unwrap_or_else) — ✅ Done

### Phase 3: Result methods (map, map_err, and_then, or_else, and, or, ok, err, map_or, map_or_else, unwrap_or_else) — ✅ Done

### Phase 4: Tests + regression — ✅ Done

- 54 tests in `tests/option_result_combinators.test.yo`
- Tests cover all methods on both Some/None and Ok/Err
- Chaining tests verify multi-method pipelines
- All existing test suites pass (HKT 12/12, fn 16/16, closure 8/8, comptime_option_result 12/12, etc.)

### Phase 5: Documentation — ✅ Done

- Plan doc updated with implementation notes

---

## Future Work (out of scope)

- `zip` method (requires a named Pair/Tuple type — anonymous structs are nominal)
- HKT traits (Functor/Applicative/Monad) in `std/alg/` or user-defined
- `>>=` operator for monadic bind
- `do` notation / for comprehension syntax sugar
- Traversable, Foldable traits
