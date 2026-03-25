## Implementation Strategy

### Phase 1: Simple Ownership (Implemented ✅)

The straightforward "always own" model is now fully implemented:

**Rules:**

1. **Assignments (`:=` and `=`)**: Always call `___dup` on RHS, `___drop` on old LHS ✅
2. **Function parameters**: Borrow by default (no `own()` keyword), no `___dup` at call site ✅
3. **Parameters are not reassignable**: Prevent `param = value` (compile error) ✅
4. **Parameters can be mutated**: Allow `param.field = value` (calls dup) ✅
5. **`own()` parameters**: Move semantics ✅
6. **Scope exit**: Call `___drop` on all owned variables ✅
7. **Deferred drops in branches**: All branching constructs (cond, match, while, for) properly emit drop calls ✅
8. **Destructuring borrows**: Both destructuring assignment and match destructuring borrow by default ✅

**Example:**

```rust
fn process(p : Point) -> unit {
  p.x = 10;        // ✅ OK: Mutate field (if Point is mutable)
  p = Point(0, 0); // ❌ ERROR: Cannot reassign parameter
}

x := Point(3, 4);  // ___dup, x owns
y := x;            // ___dup(x), y owns
process(y);        // No dup (y is borrowed by process)
z := y;            // ___dup(y), z owns

// ___drop(z), ___drop(y), ___drop(x), ___drop(temp_vars...)
```

**Benefits:**

- Simple to implement
- Always correct and safe
- Predictable behavior
- Clear mental model

### Phase 1.5: Basic Dup/Drop Optimization (Implemented ✅)

We've implemented a **same-value ownership tracking** optimization that eliminates redundant dup/drop pairs when variables share the same ARC value:

**Technique: `isOwningTheSameRcValueAs` Tracking**

When a variable is assigned from another variable, we track the ownership relationship:

```rust
x := Point(3, 4);   // x owns Point(3, 4)
y := x;             // y owns Point(3, 4), y.isOwningTheSameRcValueAs = x

// Before optimization:
// ___dup(x), ___drop(y), ___drop(x)

// After optimization:
// ___dup(x) and ___drop(y) are paired and cancelled!
// Only ___drop(x) remains
```

**How it works:**

1. **Track shared ownership**: When `y := x`, mark `y.isOwningTheSameRcValueAs = x`
2. **Find base variable**: Follow the chain to find the root owner
3. **Match dup/drop pairs**: Group dup calls by base variable ID, match with drop calls
4. **Cancel pairs**: Remove one dup/drop pair per match

**Applied during:**

- Variable reassignment in begin blocks
- Temporary variables from reassignments in branches (cond, match)

**Example with reassignment in branches:**

```rust
x := MyBox(42);
cond(
  some_cond() => { x = MyBox(100); },  // Creates temp for old value
  true => { x = MyBox(200); }          // Creates temp for old value
);
// Temps are tracked with isOwningTheSameRcValueAs = x
// Dup/drop pairs for temps are optimized away
```

**Implementation details:**

- `getBaseVariableId(variable)`: Follows `isOwningTheSameRcValueAs` chain to root
- `collectDupCallsConservatively(expr)`: Recursively finds all dup calls
- `removeDupCalls(expr)`: Removes optimized dup calls from AST
- Optimization runs at begin block scope exit

**Current limitations:**

- Only optimizes within single scope (begin blocks)
- Doesn't optimize across function boundaries
- Conservative: Falls back to dup/drop when uncertain

**Early Return Branch Optimization**

The optimization correctly handles branches with early returns (return, break, continue):

```rust
segments := ArrayList(Box(i32)).new();
cond(
  (condition) => {
    return Self(_segments: segments);  // Early return uses segments
  },
  true => {
    x := 12;  // Non-empty branch that doesn't use segments
    16
  }
);
return Self(_segments: segments);  // Normal return uses segments
```

Key insight: **Early return branches are independent execution paths**. The optimization separates branches into:

1. **Early return branches with dup**: Each has its own independent dup+drop pair that can be optimized
2. **Fallthrough branches with dup**: Share a drop at end of scope - only optimize if ALL fallthrough branches have the dup
3. **Branches without dup**: Don't affect optimization for that variable (they don't use it)

This means:

- Variables used only in early return branches can always be optimized
- Fallthrough branches that don't use a variable don't block its optimization
- Only inconsistent dup patterns across fallthrough branches prevent optimization

**Important: Value Type Semantics**

The optimization must respect C's value type semantics. When assigning value types in C (structs, unions, arrays), the assignment performs a **shallow copy (memcpy)**:

```rust
// Value type (struct) with RC field:
x := { box(42) };   // temp owns struct, x.isOwningTheSameRcValueAs = temp
y := x;             // y.isOwningTheSameRcValueAs = x

// In C codegen:
// struct_type x = temp;     // memcpy - both x and temp exist!
// struct_type y = x;        // memcpy - both y and x exist!
```

After the memcpy, **both the source and destination exist as separate values**. Each needs its own drop call to decrement the RC of inner fields. Therefore:

**Rule:** Don't optimize dup/drop pairs for **value types** (structs, enums, arrays) that contain RC fields.
**Rule:** Only optimize for **pointer types** (`object(...)`) where assignment copies the pointer, not the data.

```typescript
// In begin.ts optimization:
const isValueTypeWithRCFields =
  !isObjectType(baseVariable.type) && // Not a pointer type
  typeContainsRcType(baseVariable.type); // Contains RC fields

if (dupCalls && dupCalls.length > 0 && !isValueTypeWithRCFields) {
  // Safe to optimize: either pointer type or no RC fields
}
```

**Why this matters:**

- **Pointer types**: `x = ptr` copies the pointer → only one value exists → optimize ✅
- **Value types with RC fields**: `x = struct` does memcpy → two values exist → don't optimize ❌
- **Value types without RC fields**: Safe to optimize, but the check prevents it conservatively

## Future Optimizations

The current implementation (Phase 1 + Phase 1.5) provides a **good balance** of safety, simplicity, and performance:

- ✅ Zero memory safety bugs
- ✅ Simple "assignments always own" model
- ✅ Eliminates redundant dup/drop pairs within scopes
- ✅ Respects C value type semantics for correctness
- ✅ Parameters borrow by default (no RC overhead on calls)

## Summary

Yo's compile-time reference counting uses a **simple ownership model** with **progressive optimization**:

**Phase 1 - Simple Ownership (Implemented ✅):**

- **Assignments always own**: `:=` and `=` always call dup/drop
- **Parameters borrow by default**: No RC overhead for function calls
- **Parameters are not reassignable**: Prevents ownership state changes
- **Parameters can be mutated**: Field mutation is allowed (`p.field = value`)
- **Explicit ownership with `own()`**: Clear when ownership transfers (not yet implemented)
- **Scope exit cleanup**: All owned variables call `___drop` at scope exit
- **Branch cleanup**: All branching constructs (cond, match, while, for) properly emit deferred drops

**Phase 1.5 - Basic Dup/Drop Optimization (Implemented ✅):**

- **Shared ownership tracking**: `isOwningTheSameRcValueAs` field tracks when variables own the same ARC value
- **Dup/drop cancellation**: Matching dup/drop pairs for the same base variable are eliminated
- **Scope-local optimization**: Works within begin blocks and branch bodies
- **Reassignment temps**: Optimizes temporary variables created during reassignments in branches

**Design Goals:**

- **Phase 1**: Simple, correct, safe - easy to implement and understand ✅
- **Phase 1.5**: Eliminate obvious dup/drop pairs without complex analysis ✅
- **Future**: Add pointer types for zero-cost borrowing patterns
- **Overall**: Make Yo safe and ergonomic by default, with transparent performance optimizations
