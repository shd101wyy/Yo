# Generalized Algebraic Data Types (GADTs)

## Status: ✅ Implemented

## Overview

GADTs extend Yo's enum types by allowing each constructor to specify the exact instantiation of the type parameter it returns. This enables the type system to **refine type variables during pattern matching**, giving each match branch more precise type information.

### Motivation

With regular enums, all constructors produce the same type:

```rust
// Regular enum — all variants return Expr(T) for the same T
Expr :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(Lit(T), Add(Expr(T), Expr(T)))
);
```

This prevents expressing "a literal integer expression has type `Expr(i32)`" while "a boolean expression has type `Expr(bool)`". GADTs solve this:

```rust
// GADT — each constructor specifies its own return type
Expr :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntLit(i : i32) -> recur(i32),
    BoolLit(b : bool) -> recur(bool),
    Add(a : Expr(i32), b : Expr(i32)) -> recur(i32),
    Eq(a : Expr(i32), b : Expr(i32)) -> recur(bool),
    If(cond : Expr(bool), then : Expr(T), else_ : Expr(T))  // unconstrained T
  )
);
```

Now `Expr(i32)` can only be an `IntLit`, `Add`, or `If`, while `Expr(bool)` can only be `BoolLit`, `Eq`, or `If`. Pattern matching refines `T` in each branch:

```rust
eval :: (fn(forall(T : Type), e : Expr(T)) -> T)(
  match(e,
    .IntLit(i) => i,        // T refined to i32, returning i32 ✓
    .BoolLit(b) => b,       // T refined to bool, returning bool ✓
    .Add(a, b) => (eval(a) + eval(b)),  // T = i32
    .Eq(a, b) => (eval(a) == eval(b)),  // T = bool
    .If(c, t, f) => cond(eval(c), eval(t), eval(f))  // T stays abstract
  )
);
```

### Use cases

1. **Type-safe expression/AST evaluators** — the return type of `eval` is automatically correct per branch
2. **Typed DSLs** — embed a mini-language with guaranteed type safety
3. **Type-safe serialization formats** — `Format(i32)` vs `Format(str)` constructors
4. **Type-safe printf** — format string constructors constrain argument types
5. **Type-level proofs** — equality witnesses, length-indexed lists

## Syntax

### Arrow syntax: `-> recur(ConcreteType)`

```rust
MyExpr :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntLit(i : i32) -> recur(i32),
    BoolLit(b : bool) -> recur(bool),
    EqExpr(a : MyExpr(i32), b : MyExpr(i32)) -> recur(bool),
    If(cond : MyExpr(bool), then : MyExpr(T), else_ : MyExpr(T))
  )
);
```

**Design rationale:**

- `->` mirrors function return type syntax — each constructor is conceptually a function producing a specific type instantiation
- `recur` reuses the existing keyword for self-reference — just as `recur(args)` calls the enclosing function, `recur(i32)` applies the enclosing type constructor
- When `-> recur(...)` is omitted, it defaults to `-> recur(T)` (or `-> recur(T1, T2, ...)` for multi-parameter types) — the unconstrained case, identical to regular enum behavior
- `=` is unavailable (already used for custom discriminants: `Red = 0`)
- `:` would be ambiguous with parameter type annotations inside `(...)`

### Multi-parameter GADTs

```rust
// Type-safe key-value store
Entry :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))(
  enum(
    IntToStr(key : i32, value : str) -> recur(i32, str),
    StrToInt(key : str, value : i32) -> recur(str, i32)
  )
);
```

### GADTs with custom discriminants

Custom discriminants and GADT return types can coexist:

```rust
Packet :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Header(len : u32) -> recur(u32) = 0,
    Data(payload : Slice(u8)) -> recur(Slice(u8)) = 1,
    Eof -> recur(unit) = 255
  )
);
```

## Semantics

### Constructor typing

Each GADT constructor is typed as a function from its fields to a specific instantiation of the enum:

```
IntLit : (fn(i : i32) -> Expr(i32))
BoolLit : (fn(b : bool) -> Expr(bool))
If : (fn(forall(T : Type), cond : Expr(bool), then : Expr(T), else_ : Expr(T)) -> Expr(T))
```

When constructing a GADT value, the type checker verifies the fields match and the resulting type matches the declared return type.

### Type refinement in match branches

This is the core GADT feature. When pattern matching on `(e : Expr(T))`:

```rust
match(e,
  .IntLit(i) => {
    // Here the type checker knows T = i32
    // Because IntLit -> recur(i32), and e : Expr(T), so T must equal i32
    // `i` has type i32
    // Return type in this branch can be i32 (which equals T)
  },
  .BoolLit(b) => {
    // T = bool, b : bool
  },
  .If(c, t, f) => {
    // T remains abstract (unconstrained)
    // c : Expr(bool), t : Expr(T), f : Expr(T)
  }
)
```

**Implementation approach:** When the match scrutinee has type `Expr(T)` and a branch matches constructor `.IntLit` which returns `recur(i32)`, unify `T` with `i32` in that branch's environment. This is a local type refinement — it only applies within the branch body.

### Type annotation requirement

Like Haskell and OCaml, functions that consume GADTs generally need explicit type annotations. Yo already requires these for forall functions, so this is consistent:

```rust
// Must annotate return type — the compiler can't infer it across refined branches
eval :: (fn(forall(T : Type), e : Expr(T)) -> T)( ... );
```

### Exhaustiveness with GADTs

Exhaustiveness checking becomes type-aware. If `e : Expr(i32)`, then `.BoolLit` and `.Eq` branches are **unreachable** (they return `Expr(bool)`, which can't unify with `Expr(i32)`). The exhaustiveness checker should:

1. Filter variants whose return type **can unify** with the scrutinee's type
2. Only require those reachable variants to be covered

```rust
eval_int :: (fn(e : Expr(i32)) -> i32)(
  match(e,
    .IntLit(i) => i,
    .Add(a, b) => (eval_int(a) + eval_int(b)),
    .If(c, t, f) => cond(eval(c), eval_int(t), eval_int(f))
    // No .BoolLit or .Eq needed — they can't produce Expr(i32)
  )
);
```

### No existential types (initially)

Existential types (constructors that introduce new type variables not in the enum's parameters) add significant complexity:

```rust
// NOT supported initially:
SomeContainer :: enum(
  Wrap(forall(T : Type), value : T, show : (fn(T) -> str))  // T is existential
);
```

This can be added later if needed. For the initial implementation, all type variables in constructor fields must come from the enum's outer forall parameters.

## Runtime representation

**GADTs have the same C representation as regular enums.** The type refinement is purely a compile-time concern — at runtime, a GADT is just a tagged union:

```c
// Expr(T) generates the same C code regardless of T:
typedef enum {
  Expr_IntLit = 0,
  Expr_BoolLit = 1,
  Expr_Add = 2,
  Expr_Eq = 3,
  Expr_If = 4
} Expr_tag;

typedef union {
  struct { int32_t i; } IntLit;
  struct { bool b; } BoolLit;
  struct { Expr_i32* a; Expr_i32* b; } Add;
  struct { Expr_i32* a; Expr_i32* b; } Eq;
  // If needs polymorphic fields — handled via type specialization
} Expr_data;

struct Expr_struct {
  Expr_tag tag;
  Expr_data data;
};
```

No special codegen needed — all GADT logic is erased.

## Interaction with existing features

### HKT

GADTs and HKT are orthogonal. A GADT can be used as an HKT type constructor:

```rust
Functor :: (fn(comptime(F) : (fn(comptime(T) : Type) -> comptime(Type))) -> comptime(Type))(
  trait(
    map : (fn(forall(A : Type, B : Type), self : F(A), f : Impl(Fn(a : A) -> B)) -> F(B))
  )
);

// If Expr implements Functor, you'd map over subexpressions
```

### Partial application

Partial application with `_` works unchanged — `Expr(_, bool)` for a multi-param GADT would produce a new type constructor, same as with regular enums.

### Algebraic effects

No interaction — effects operate at the function call level, not the type definition level.

### Option/Result combinators

No interaction — Option and Result are regular enums, not GADTs.

## Implementation phases

### Phase 1: Parser — GADT constructor return types

**Files:** `src/parser.ts`, `src/expr.ts`

- Extend the parser to recognize `-> recur(Type1, Type2, ...)` after enum variant fields
- Store the return type AST expression in the variant node
- `recur` is already a keyword (used for recursive function calls)

**AST changes:**

```typescript
// In expr.ts, enum variant AST nodes need:
interface EnumVariantExpr {
  name: string;
  fields?: Expr[];
  gadtReturnType?: Expr; // The recur(...) expression, if present
  discriminant?: Expr;
}
```

### Phase 2: Evaluator — GADT variant return types

**Files:** `src/types/definitions.ts`, `src/evaluator/types/enum.ts`

- Add `returnType?: Type` to `EnumVariant` (the TODO at line 724 of definitions.ts)
- During `evaluateEnumType()`, evaluate the `recur(...)` return type expression
- `recur` in type position should resolve to the enclosing type constructor function
- Verify that the return type is a valid instantiation of the enum (e.g., `recur(i32)` → `MyExpr(i32)`)

**Type changes:**

```typescript
interface EnumVariant {
  name: string;
  fields?: TypeField[];
  discriminant?: bigint;
  returnType?: Type; // The concrete enum instantiation this constructor returns
}
```

### Phase 3: Constructor type checking

**Files:** `src/evaluator/types/enum.ts`, `src/evaluator/calls/function.ts`

- When constructing a GADT value (e.g., `Expr.IntLit(i32(42))`), verify the resulting type matches the declared return type
- The constructed value's type is the GADT return type, not the generic `Expr(T)`:
  - `Expr.IntLit(42)` has type `Expr(i32)`, not `Expr(T)`
  - `Expr.If(c, t, f)` has type `Expr(T)` where T is inferred from `t` and `f`

### Phase 4: Match type refinement

**Files:** `src/evaluator/exprs/match.ts`

This is the core change. When matching on a GADT scrutinee:

1. **Unification step:** When entering a branch for constructor `C` with return type `recur(ConcreteType)`, unify the scrutinee's type parameters with `ConcreteType`. For `(e : Expr(T))` matching `.IntLit`:

   - `recur(i32)` → `Expr(i32)`
   - Unify `Expr(T)` with `Expr(i32)` → `T = i32`
   - Bind `T = i32` in the branch environment

2. **Environment extension:** Create a new environment frame for the branch where refined type variables are bound to their concrete types.

3. **Return type checking:** The branch body's return type is checked against the function's return type with the refined bindings. If the function returns `T` and `T = i32` in this branch, the branch must return `i32`.

**Key implementation detail:** The type refinement must be **local** to each branch. After the match, the original type bindings are restored.

### Phase 5: Exhaustiveness refinement

**Files:** `src/evaluator/exprs/match.ts`

Update exhaustiveness checking to account for unreachable variants:

1. For a scrutinee of type `Expr(i32)`, compute which variants can produce that type
2. Only require coverage of reachable variants
3. Warn or allow omission of unreachable variants

### Phase 6: Tests

**File:** `tests/gadts.test.yo`

Test cases:

1. Basic GADT definition and construction
2. Type refinement in match branches
3. Multi-parameter GADTs
4. Unconstrained variants (default `recur(T)`)
5. Exhaustiveness checking with type filtering
6. GADT with custom discriminants
7. Nested GADTs
8. GADT interaction with HKT forall parameters
9. Error cases: invalid return types, type mismatches
10. Comptime GADT evaluation

### Phase 7: Documentation

- `docs/en-US/GADTS.md` and `docs/zh-CN/GADTS.md`
- Update `docs/en-US/DESIGN.md` and `docs/zh-CN/DESIGN.md`
- Update `.github/instructions/yo-design.instructions.md`
- Update `.github/instructions/yo-syntax.instructions.md`

## Non-goals (initially)

1. **Existential types in constructors** — constructors introducing new type variables not in the enum parameters
2. **GADT inference without annotations** — functions consuming GADTs must have explicit type annotations (already required for forall functions)
3. **First-class equality witnesses** — type equality proofs like Haskell's `(:~:)`
4. **Injective type families** — type-level computation with GADTs

## Open questions

1. **Should `recur` be extended to work in struct definitions too?** Recursive struct types could benefit from `recur` for self-reference, though this is a separate feature.

2. **How to handle GADT variants in `cond`?** Currently `cond` can pattern-match on enum values. Should GADT type refinement apply there too?

3. **Error messages:** When a GADT branch has a type error due to refinement, the error message should clearly explain the refinement chain (e.g., "In this branch, T = i32 because IntLit returns Expr(i32)").

4. **Performance:** Type unification in match branches adds compile-time cost. Should it be lazy (only when needed)?

## References

- [GHC User's Guide: GADTs](https://ghc.gitlab.haskell.org/ghc/doc/users_guide/exts/gadt.html)
- [OCaml Manual: GADTs](https://v2.ocaml.org/api/compilerlibref/Typedtree.html)
- Xi, Chen, Chen (2003): "Guarded Recursive Datatype Constructors"
