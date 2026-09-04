# Error Trait, TypeId, and Dynamic Downcasting — Design & Implementation Plan

## Motivation

Yo needs a robust error handling story with:

1. An **Error trait** with `source()` for error chaining (like Rust's `Error::source()`)
2. **TypeId** for runtime type identity of `Dyn` values
3. **`is`** and **`downcast`** for safe dynamic type checking and downcasting

The current `Error` trait in `std/error.yo` has placeholder TODOs for `is` and `downcast`, and the `source` method has a problematic return type (`Option(Self)` — not object-safe).

---

## Design

### 1. `SelfTrait` Keyword

**Problem**: In the `Error` trait definition, we want `source()` to return `Option(Dyn(Error))`. But `Error` is the trait currently being defined — it's not yet available as a name.

**Solution**: Introduce `SelfTrait` as a builtin keyword (analogous to `Self` for the implementing type). `SelfTrait` refers to the trait being defined.

```rust
Error :: trait(
  (source : (fn(self: *(Self)) -> Option(Dyn(SelfTrait)))) ?= ((self) -> .None),
  where(Self <: ToString)
);
```

Here `SelfTrait` resolves to `Error`, so `Dyn(SelfTrait)` = `Dyn(Error)` = `AnyError`.

**Semantics**:

- `SelfTrait` is only valid inside a `trait(...)` definition
- It evaluates to the TraitType being constructed
- It is a compile-time value (like `Self`)
- Error if used outside a trait definition

**Implementation**:

- Add `SelfTrait` to `BuiltinKeywords` in `src/expr.ts`
- In the evaluator's trait definition logic, bind `SelfTrait` in the environment to the trait being constructed
- Since trait types are created before field evaluation, `SelfTrait` can refer to the (possibly incomplete) trait type

---

### 2. `typeid` Builtin Function

A compile-time builtin that maps a type to a unique runtime `usize` identifier.

```rust
typeid(MyError)   // returns usize — unique per concrete type
typeid(i32)       // different usize for each type
```

**C codegen**: Uses address-of-static for uniqueness:

```c
// Unique static variable per type — its address is the TypeId
static const char __yo_typeid_MyError = 0;
static const char __yo_typeid_i32 = 0;

// typeid(MyError) emits:
(uintptr_t)&__yo_typeid_MyError
```

Using address-of-static guarantees uniqueness without a global counter, works across compilation units, and has zero runtime cost.

**Implementation**: `typeid` is added to `BuiltinFunctions` in `src/expr.ts`. The evaluator resolves the type argument at compile time. The codegen emits a static char per unique type and returns its address cast to `uintptr_t`.

---

### 3. Vtable `__yo_type_id` (Compiler-internal)

Every `Dyn` vtable auto-includes a `__yo_type_id` field (`uintptr_t`). This is always present regardless of which traits the Dyn includes. The cost is one extra pointer-sized value per vtable (negligible), enabling universal `downcast` support on all Dyn values.

The compiler automatically populates `__yo_type_id` with `(uintptr_t)&__yo_typeid_<concreteType>` for every concrete type used with `dyn()`. No user-facing `TypeId` trait is needed — runtime type identity is handled entirely by the compiler through the `downcast()` builtin.

---

### 4. `downcast` — Builtin Function ✅

`downcast` is a **builtin function** (like `typeid`, `sizeof`). It takes a Dyn value as the first argument and the target type as the second.

**Signature**:

```rust
downcast(dyn_value, T) // → Option(T)
```

**Usage**:

```rust
(animal : Animal) = dyn(Cat(`kitty`));

// Safe downcast with type check
match(downcast(animal, Cat),
  .Some(cat) => printf("Cat: %s\n", cat.name.as_str()),
  .None => printf("not a Cat\n")
);

// Type check only (no separate is() needed)
if downcast(animal, Cat).is_some(), {
  printf("it's a cat!\n");
};
```

**Why a builtin function instead of a method**: `downcast` takes a compile-time type parameter (`comptime(T) : Type`), which cannot be dispatched through a vtable at runtime. As a builtin function, it's simple, universal, and avoids naming conflicts with user-defined trait methods.

**`typeid` remains compile-time only**: `typeid(T)` only accepts compile-time Type values. It does NOT accept Dyn values at runtime.

**`downcast` return type**: `downcast(dyn_value, T)` always returns `Option(T)`. Since `Dyn` only wraps object types (reference-counted), `T` is always a reference type. The result is an owned RC reference with incremented refcount, safe to use independently of the Dyn value's lifetime.

**C codegen**:

```c
// downcast(animal, Cat)  =>
(animal.vtable->__yo_type_id == (uintptr_t)&__yo_typeid_Cat)
  ? (Option_Cat){ .tag = 1, .Some = __yo_incr_rc((Cat*)animal.data) }
  : (Option_Cat){ .tag = 0 }
```

**RC safety for `downcast`**: The downcast result holds a reference to the same object as the Dyn value. The codegen emits `__yo_incr_rc` on the cast pointer so the Option result owns its own reference. The evaluator uses `attachTempVariableToExpr(expr, true)` for automatic drop tracking.

**Implementation**: `downcast` in `src/evaluator/builtins/downcast.ts` + `src/codegen/exprs/downcast.ts`. Wired into `_expr.ts` and `generation.ts` dispatchers.

---

### 5. ~~`dyn_cast`~~ — Removed

`dyn_cast` has been removed. `downcast()` covers all use cases. Dyn only wraps object types, so there's no need for an unsafe unchecked cast.

---

### 6. Updated `Error` Trait

With `SelfTrait`:

```rust
Error :: trait(
  (source : (fn(self: *(Self)) -> Option(Dyn(SelfTrait)))) ?= ((self) -> .None),
  where(Self <: ToString)
);

AnyError :: Dyn(Error);
```

Usage example:

```rust
IoError :: object(message : String);
impl(IoError, ToString(to_string : ((self) -> self.*.message)));
impl(IoError, Error());  // uses default source

NetworkError :: object(
  message : String,
  cause : Option(AnyError)
);
impl(NetworkError, ToString(to_string : ((self) -> self.*.message)));
impl(NetworkError, Error(
  source : ((self) -> self.*.cause)
));

handle_error :: (fn(err : AnyError) -> unit)({
  printf("Error: %s\n", err.to_string().as_str());

  // Check specific error type and downcast
  match(downcast(err, NetworkError),
    .Some(net_err) => {
      printf("Network error: %s\n", net_err.message.as_str());
    },
    .None => ()
  );

  // Chain to source
  match(err.source(),
    .Some(inner) => handle_error(inner),
    .None => ()
  );
});
```

---

## Implementation Plan

### Phase 1: `SelfTrait` Keyword ✅

1. Add `SelfTraitType` to `EvaluatorContext`
2. Handle `SelfTrait` identifier in the evaluator (like `Self`)
3. In `evaluateTraitType`, bind `SelfTraitType: traitType` in the context before evaluating trait fields
4. Pass `SelfTraitType` through where-clause and impl contexts

### Phase 2: `typeid` Builtin & TypeId Trait ✅

1. Add `typeid` to `BuiltinFunctions` in `src/expr.ts` ✅
2. Evaluator: `src/evaluator/builtins/typeid.ts` ✅
3. Codegen: `src/codegen/exprs/typeid.ts` ✅
4. TypeId trait: can be defined in user code with `?=` default (not yet in std/)

### Phase 3: Vtable `__yo_type_id` Integration ✅

1. `__yo_type_id` field (uintptr_t) auto-included in every Dyn vtable struct ✅
2. Static `__yo_typeid_<concreteType>` vars generated per dyn impl ✅
3. Vtable populated with `.__yo_type_id = (uintptr_t)&__yo_typeid_<concreteType>` ✅
4. No user-facing TypeId trait needed — compiler handles everything ✅

### Phase 4: ~~`dyn_cast` Builtin~~ — Removed

`dyn_cast` has been removed. `downcast()` covers all use cases.

### Phase 5: `downcast` Builtin Function ✅

1. Add `downcast` to `BuiltinFunctions` — evaluator returns `Option(T)`, codegen emits tagged union ✅
2. Argument order: `downcast(dyn_value, T)` — subject first, type second ✅
3. Standalone builtin, not a method — no trait injection or method resolution changes ✅
4. `typeid` remains compile-time only (accepts Type values, not Dyn values) ✅
5. RC safety: downcast uses `__yo_incr_rc` + `attachTempVariableToExpr` for correct refcounting ✅

### Phase 6: Update `Error` Trait

1. Update `std/error.yo` to use `SelfTrait` in `source` return type ✅ (already done)
2. Remove TODO comments for `downcast` — now handled as builtin function
3. Implement `Error` for common types (String, etc.)
4. Add tests

---

## Open Questions

1. **`SelfTrait` naming**: Options include `SelfTrait`, `ThisTrait`, `Trait`, `CurrentTrait`. `SelfTrait` parallels `Self` nicely. **Decision**: `SelfTrait`. ✅

2. ~~**Boxed value type downcasting**~~: Moot — Dyn only wraps object types, so downcasting always returns `Option(T)` with an owned RC reference. No boxing involved.

3. **TypeId stability**: Address-of-static TypeIds are stable within a single program execution but not across compilations. This is fine for runtime type checking but not for serialization. (Same as Rust's `TypeId`.)

4. **Default values and SomeType**: Default values (`?=`) in traits are evaluated once during trait definition (when `Self` is abstract). They are NOT re-evaluated with concrete types during `impl`. This is why `__yo_type_id` is auto-populated by the compiler rather than using a trait default.

5. ~~**`dyn_cast` return type**~~: `dyn_cast` has been removed. `downcast(dyn_value, T)` always returns `Option(T)`.

6. **`downcast` as method vs builtin**: Considered three approaches: (a) builtin function, (b) built-in method on Dyn types, (c) blanket `impl(forall(Trait), Dyn(Trait), ...)`. **Decision**: Option (a) — builtin function `downcast(dyn_value, T)`. Simplest approach; avoids trait injection, method resolution changes, and naming conflicts with user-defined trait methods. ✅

7. **`typeid` scope**: `typeid(T)` is compile-time only — accepts Type values, not Dyn values. ✅

8. **`TypeId` trait**: No user-facing `TypeId` trait is needed. The compiler automatically populates `__yo_type_id` in every Dyn vtable. `downcast()` builtin handles all runtime type checking. ✅
