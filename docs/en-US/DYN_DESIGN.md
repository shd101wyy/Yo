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
  point := Point(x: 3, y: 4);
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
Box :: (fn(comptime(V) : Type) -> comptime(Type))(
  ref(
    struct(
      (*) : V
    )
  )
);
box :: (fn(generic(V : Type), value : V) -> Box(V))(
  Box(V)(value)
);
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

A method can be called through a `Dyn(Trait)` receiver when:

1. its first parameter is `self` (`self : Self`, `inout(self) : Self` or `self : *(Self)`, since the
   vtable wrapper unboxes the receiver);
2. `Self` appears nowhere else in its signature: not as another parameter, not as the result, and
   not inside one (`Option(Self)`, `Result(Self, E)`);
3. it takes no `generic(...)` parameters.

The reasons:

- A `Dyn` erases the concrete type, so a `Self` parameter or result has no single C type at the
  call: two concrete types behind the same `Dyn` have different sizes and representations.
- A generic method is a family of functions, one per instantiation, and a vtable slot holds one.

Only these methods get a vtable slot. A trait may still declare others, and a `Dyn` of it can be
formed and its callable methods used; calling one of the others through the `Dyn` is error E0614
(`yo explain E0614`), at the call:

```rust
Sp :: trait(speak : (fn(self : Self) -> i32), me : (fn(self : Self) -> Self));
(d : Dyn(Sp)) = dyn(Cat(n : i32(3)));
d.speak();   // OK: `Self` only as the receiver
d.me();      // error[E0614]: Method "me" of trait Sp cannot be called through Dyn(Sp): it returns Self, which the Dyn erases.
```

A blanket inherent method over a trait bound (`impl(generic(E), where(E <: Named), E, shout : ...)`)
also accepts a `Dyn(Named)` receiver. It is not a trait member and has no vtable slot: the call is
an ordinary call to the method, specialized for the `Dyn`, and inside it `self.name()` dispatches
through the vtable.

A trait implemented through a generic impl (`ArrayList(T)`'s `ToString` for `T <: ToString`) can be
put behind a `Dyn`: `dyn(xs)` specializes the generic impl's methods for the concrete type.

**No upcasting.** A `Dyn(Sp, Ot)` is not converted to a `Dyn(Sp)`: the two have different vtable
layouts, and the concrete type needed to build the smaller vtable is gone. Call `dyn(...)` on the
concrete value with the traits the destination needs. The decision is recorded in
`plans/TYPE_SYSTEM_SOUNDNESS.md` (Phase 2.7).

## Reference-Semantics Type Requirement for dyn(...)

**Rule**: `dyn(value)` requires `value` to have an **reference-semantics type** (pointer to RC'd data). If it's a value type then it will be auto `box`ed.

**Rationale**: The `data` field in `Dyn` must point to reference-counted memory. This ensures safe memory management without adding a ref_header to `Dyn` itself.

**Examples:**

```rust
// Value types must be boxed
dyn(box(42)); // OK: box(42) returns Box(i32), which is an reference-semantics type
dyn(box(true)); // OK: box(true) returns Box(bool)
// Reference-semantics types can be used directly
point := Point(x : 3, y : 4); // point : Point, Point is reference-semantics type
dyn(point); // OK: point is an reference-semantics type
// Direct value will be automatically boxed
dyn(42); // 42 becomes box(42) automatically
dyn(true); // true becomes box(true) automatically
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

## Runtime Type Checks: `downcast(value, T)`

A `Dyn` erases the concrete type, and `downcast` is how you get it back:

```rust
downcast(dyn_value, T) -> Option(T)
```

It is the only safe way to recover the concrete type from a `Dyn`, and it is
what `std/error.yo`'s `error_is(err, T)` is built out of. Both arguments are
fixed: the first must have a `Dyn` type, the second must be a TYPE (evaluated at
compile time, so `T` is never a runtime value).

```rust
Animal :: trait(speak : (fn(self : Self) -> unit));
// ... impl(Cat, Animal(...)); impl(Dog, Animal(...));
animal := dyn(Cat.new());

match(
  downcast(animal, Cat),
  .Some(cat) => cat.purr(),
  // the concrete Cat, RC'd and owned
  .None => println(`not a cat`)
);

// Testing only, without using the value:
if(downcast(animal, Dog).is_some(), {
  println(`a dog`);
});
```

**How the check works.** Every `Dyn` vtable carries a `__yo_type_id` field, and
each concrete type gets one static whose ADDRESS is its canonical type id. The
check is a single pointer comparison — `value.vtable->__yo_type_id ==
(uintptr_t)&__yo_typeid_Cat` — so it costs one load and one compare, with no
string comparison and no RTTI table.

**The result is owned.** `Dyn` only ever holds reference-counted data, so a
successful downcast increments the refcount and hands back an owned reference:
the `Dyn` keeps its own, and the two are dropped independently.

**Value types come out of their box.** `dyn(42)` auto-boxes (see
[Reference-Semantics Type Requirement](#reference-semantics-type-requirement-for-dyn)),
so `dyn.data` points at a `Box` struct rather than at the value. A downcast to a
value or newtype target reads the value out of that box and dups it — casting
`data` straight to the value struct would not even be valid C.

**A downcast that can never succeed is a compile-time `.None`.** The compiler
knows every `dyn(...)` creation site in the program. If nothing ever wraps `T`
into this `Dyn`, no vtable in the binary carries `T`'s type id, the comparison
can never hold, and the whole expression is lowered to a constant `.None` rather
than to a check that is always false.

**There is no unchecked cast.** `downcast` always returns `Option(T)`; if you
want a panic on mismatch, that is `downcast(v, T).unwrap()`, spelled at the call
site so it is visible. `typeid` is a separate builtin and takes a TYPE, not a
value — it cannot be used to test a `Dyn` at runtime.

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
