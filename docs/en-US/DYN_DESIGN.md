# Dyn/dyn Dynamic Dispatch Implementation

## Overview

`Dyn(Trait)` enables runtime polymorphism through dynamic dispatch with type erasure.

**Important**: `Dyn` is a **value type** (struct with data pointer and vtable). The `data` field **must** point to a reference-semantics type — `ref(struct(...))` / `ref(enum(...))` — i.e. one that is reference counted.

```typescript
Id :: trait(id : (fn(inout(self) : Self) -> i32));

impl(i32, Id(id : ((self) -> { printf("i32: %d\n", self); return self; })));
impl(bool, Id(id : ((self) -> { printf("bool\n"); return cond(self => 1, true => 0); })));

use_id :: (fn(value : Dyn(Id)) -> unit) { x := value.id(); };

main :: (fn() -> unit) {
  // Value types must be boxed
  use_id(dyn(box(42)));
  use_id(dyn(box(true)));

  // Reference-semantics types can be used directly
  point := Point(3, 4);
  use_id(dyn(point));
};
```

## Core Design

### 1. Dyn Type (Value Type - Fat Pointer)

`Dyn(Trait)` is a **value type struct** (no ref_header). It's a fat pointer containing data and vtable.

```c
typedef struct {
  void* data;                    // MUST point to reference-semantics type (has ref_header)
  const TraitVtable* vtable;    // Static vtable pointer
} __yo_dyn_trait_id;
```

**Key Points:**

- `Dyn` is a **value type** - copied by value like a struct
- `data` **must** point to an reference-semantics type (always has ref_header)
- When you copy a `Dyn`, you `___dup` the `data` pointer
- When you drop a `Dyn`, you `___drop` the `data` pointer
- The `Dyn` struct itself is not heap-allocated

### 2. Data Storage (Reference-Semantics Type Constraint)

The `data` field **must** point to an reference-semantics type (reference counted). Value types must be wrapped in `Box(T)`.

```c
// For value types - MUST use Box(T)
Box_i32* boxed = /* box(42) */;  // Box(i32) is an reference-semantics type
void* data = boxed;               // Store Box pointer

// For reference-semantics types - use directly
Point* point = /* Point(3, 4) */;  // Point is an reference-semantics type
void* data = point;                // Store Point pointer
```

**Box Type Definition:**

```rust
Box :: (fn(comptime(V) : Type) -> comptime(Type))
  ref(struct(
    (*) : V
  ))
;
box :: (fn(generic(V : Type), value : V) -> Box(V))
  Box(V)(value)
;
```

**Why this constraint?**

- Simplifies `Dyn`: No ref_header needed
- Single RC layer: Only `data` is reference counted
- Uniform handling: All `data` pointers have the same memory layout
- Type safety: Enforced at compile time

### 3. Vtable Structure (Uniform Signatures)

```c
typedef struct {
  int32_t (*return_i32)(void*);    // All return types must be concrete (no Self)
  void (*print)(void*);            // unit return type
} __yo_dyn_trait_TestDyn_vtable;
```

**Wrapper Functions:**

- **Reference-semantics types**: Use direct casts (no wrapper needed)
- **Boxed value types**: Generate wrappers to unwrap `Box(T)` before calling impl

## Object-Safety Constraint (Following Rust)

**Constraint**: Traits used with `Dyn()` **cannot** have methods that:

1. Take `Self` by value - must use `inout(self) : Self` instead
2. Return `Self`
3. Return types containing `Self` (like `Option(Self)`, `Result(Self, E)`, etc.)

This follows Rust's "object-safety" rules (dyn-compatibility). The reasons:

- Taking `Self` by value: Different concrete types have different sizes (i32 vs MyBox*), impossible to pass through uniform `void*` parameter
- Returning `Self`: Different concrete types produce different return types, making uniform vtable signatures impossible

**Valid** for dynamic dispatch:

```typescript
TestDyn :: trait(
  return_i32 : (fn(inout(self) : Self) -> i32),  // Takes inout(Self), returns concrete type - OK!
  print : (fn(inout(self) : Self) -> unit)        // Takes inout(Self), returns unit - OK!
);
```

**Invalid** for dynamic dispatch (object-safety violations):

```typescript
TestDyn :: trait(
  by_value : (fn(self : Self) -> unit),        // Takes Self by value - NOT object-safe!
  id : (fn(inout(self) : Self) -> Self)           // Returns Self - NOT object-safe!
);
```

The constraint is **enforced at method call time**, not at trait definition. You can define traits with non-object-safe methods, but you cannot call those methods on Dyn values.

## Reference-Semantics Type Requirement for dyn(...)

**Rule**: `dyn(value)` requires `value` to have an **reference-semantics type** (pointer to RC'd data). If it's a value type then it will be auto `box`ed.

**Rationale**: The `data` field in `Dyn` must point to reference-counted memory. This ensures safe memory management without adding a ref_header to `Dyn` itself.

**Examples:**

```rust
// Value types must be boxed
dyn(box(42));           // OK: box(42) returns Box(i32), which is an reference-semantics type
dyn(box(true));         // OK: box(true) returns Box(bool)

// Reference-semantics types can be used directly
point := Point(3, 4);   // point : Point, Point is reference-semantics type
dyn(point);             // OK: point is an reference-semantics type

// Direct value will be automatically boxed
dyn(42);                // 42 becomes box(42) automatically
dyn(true);              // true becomes box(true) automatically
```

### 4. Static Vtables and Wrappers

**For value types (boxed):**

```c
// Original method implementation for i32
int32_t fn_i32_id(int32_t* self) {
  return *self;
}

// Wrapper to unwrap Box(i32)
int32_t wrapper_Box_i32_id(void* self_ptr) {
  Box_i32* box = (Box_i32*)self_ptr;
  return fn_i32_id(&box->value);  // Extract value, call original
}

// Static vtable for dyn(box(i32))
static const __yo_dyn_trait_Id_vtable __yo_vtable_Box_i32_Id = {
  .id = wrapper_Box_i32_id  // Points to wrapper
};
```

**For reference-semantics types:**

```c
// Original method implementation for Point
void fn_Point_print(Point* self) {
  printf("(%d, %d)", self->x, self->y);
}

// Static vtable for dyn(point) - no wrapper needed!
static const __yo_dyn_trait_Printer_vtable __yo_vtable_Point_Printer = {
  .print = (void(*)(void*))fn_Point_print  // Direct cast
};
```

## Construction: `dyn(value)`

When constructing a `Dyn`, the value must be an reference-semantics type. The `Dyn` struct is created on the stack and stores the data pointer.

```c
// For dyn(box(42)):
Box_i32* boxed = /* result of box(42) */;  // Already has RC = 1

__yo_dyn_trait_id result = {
  .data = boxed,
  .vtable = &__yo_vtable_Box_i32_Id
};
// Note: No dup here, ownership transfers from box(42) to dyn
```

```c
// For dyn(point) where point : Point:
Point* point = /* Point(3, 4) */;  // Already has RC = 1

__yo_dyn_trait_Printer result = {
  .data = point,
  .vtable = &__yo_vtable_Point_Printer
};
// Note: No dup here, ownership transfers from point to dyn
```

**Key Point**: Since `Dyn` is a value type, it's created on the stack. The `data` pointer's ownership is transferred (no dup at construction).

## Method Dispatch

Method calls on `Dyn` go through the vtable. Since `Dyn` is a value type, `value` is the struct itself.

```c
// value has type __yo_dyn_trait_TestDyn (struct, not pointer)
int32_t result = value.vtable->return_i32(value.data);
value.vtable->print(value.data);
```

## Reference Counting for Dyn

Since `Dyn` is a value type, we need dup/drop functions that operate on the `data` pointer.

### Dup Function

When copying a `Dyn`, increment the `data` pointer's RC:

```c
__yo_dyn_trait_id __yo_dup_dyn_trait_Id(__yo_dyn_trait_id dyn) {
  if (dyn.data) {
    __yo_incr_rc(dyn.data);  // data is always an reference-semantics type
  }
  return dyn;  // Return the copied struct
}
```

### Drop Function

When dropping a `Dyn`, decrement the `data` pointer's RC:

```c
void __yo_drop_dyn_trait_Id(__yo_dyn_trait_id dyn) {
  if (dyn.data) {
    __yo_decr_rc(dyn.data);  // data is always an reference-semantics type
  }
}
```

**Key Points:**

- No type-specific dup/drop needed - `data` is always an object pointer
- The `data` object's dispose function handles cleanup (Box or regular object)
- `Dyn` itself is never heap-allocated, so no dispose function needed

## Summary of Design

1. **`Dyn` is a value type**: Simple struct with `{ void* data, vtable* }`, no ref_header
2. **`data` must be reference-semantics type**: Enforces that data is always reference counted
3. **Value types use `box()`**: `dyn(box(42))` wraps value in `Box(T)` reference-semantics type
4. **Reference-semantics types direct**: `dyn(Point(3, 4))` uses Point pointer directly
5. **Wrappers for Box**: Generated wrappers unwrap `Box(T)` before calling impl methods
6. **Simple RC**: Only `data` is reference counted, `Dyn` struct is copied by value
7. **Dup/Drop functions**: Standard functions that dup/drop the `data` pointer
