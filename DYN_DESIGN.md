# Dyn/dyn Dynamic Dispatch Implementation

## Overview

`Dyn(Module)` enables runtime polymorphism through dynamic dispatch with type erasure.

**Important**: `Dyn` is a **value type** (struct with data pointer and vtable). The `data` field **must** point to an object type (reference counted).

```yo
Id :: module(id : (fn(self : *(Self)) -> i32));

impl(i32, Id(id : ((self) -> { printf("i32: %d\n", self.*); return self.*; })));
impl(boolean, Id(id : ((self) -> { printf("bool\n"); return cond(self.* => 1, true => 0); })));

use_id :: (fn(value : Dyn(Id)) -> unit) { x := value.id(); };

main :: (fn() -> unit) {
  // Value types must be boxed
  use_id(dyn(box(42)));
  use_id(dyn(box(true)));
  
  // Object types can be used directly
  point := Point(3, 4);
  use_id(dyn(point));
};
```

## Core Design

### 1. Dyn Type (Value Type - Fat Pointer)

`Dyn(Module)` is a **value type struct** (no ref_header). It's a fat pointer containing data and vtable.

```c
typedef struct {
  void* data;                    // MUST point to object type (has ref_header)
  const ModuleVtable* vtable;    // Static vtable pointer
} yo_dyn_module_Id;
```

**Key Points:**
- `Dyn` is a **value type** - copied by value like a struct
- `data` **must** point to an object type (always has ref_header)
- When you copy a `Dyn`, you `___dup` the `data` pointer
- When you drop a `Dyn`, you `___drop` the `data` pointer
- The `Dyn` struct itself is not heap-allocated

### 2. Data Storage (Object Type Constraint)

The `data` field **must** point to an object type (reference counted). Value types must be wrapped in `Box(T)`.

```c
// For value types - MUST use Box(T)
Box_i32* boxed = /* box(42) */;  // Box(i32) is an object type
void* data = boxed;               // Store Box pointer

// For object types - use directly
Point* point = /* Point(3, 4) */;  // Point is an object type
void* data = point;                // Store Point pointer
```

**Box Type Definition:**
```yo
Box :: (fn(compt(V) : Type) -> compt(Type))
  object(
    (*) : V
  )
;
box :: (fn(forall(V : Type), value : V) -> Box(V))
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
} yo_dyn_module_TestDyn_vtable;
```

**Wrapper Functions:**
- **Object types**: Use direct casts (no wrapper needed)
- **Boxed value types**: Generate wrappers to unwrap `Box(T)` before calling impl

## Object-Safety Constraint (Following Rust)

**Constraint**: Modules used with `Dyn()` **cannot** have methods that:
1. Take `Self` by value - must use `self : *(Self)` instead
2. Return `Self` 
3. Return types containing `Self` (like `Option(Self)`, `Result(Self, E)`, etc.)

This follows Rust's "object-safety" rules (dyn-compatibility). The reasons:
- Taking `Self` by value: Different concrete types have different sizes (i32 vs MyBox*), impossible to pass through uniform `void*` parameter
- Returning `Self`: Different concrete types produce different return types, making uniform vtable signatures impossible

**Valid** for dynamic dispatch:
```yo
TestDyn :: module(
  return_i32 : fn(self : *(Self)) -> i32,  // Takes *(Self), returns concrete type - OK!
  print : fn(self : *(Self)) -> unit        // Takes *(Self), returns unit - OK!
);
```

**Invalid** for dynamic dispatch (object-safety violations):
```yo
TestDyn :: module(
  by_value : fn(self : Self) -> unit,      // Takes Self by value - NOT object-safe!
  id : fn(self : *(Self)) -> Self           // Returns Self - NOT object-safe!
);
```

The constraint is **enforced at method call time**, not at module definition. You can define modules with non-object-safe methods, but you cannot call those methods on Dyn values.

## Object Type Requirement for dyn(...)

**Rule**: `dyn(value)` requires `value` to have an **object type** (pointer to RC'd data).

**Rationale**: The `data` field in `Dyn` must point to reference-counted memory. This ensures safe memory management without adding a ref_header to `Dyn` itself.

**Examples:**
```yo
// Value types must be boxed
dyn(box(42));           // OK: box(42) returns Box(i32), which is an object type
dyn(box(true));         // OK: box(true) returns Box(boolean)

// Object types can be used directly
point := Point(3, 4);   // point : Point, Point is object type
dyn(point);             // OK: point is an object type

// Direct values NOT allowed
dyn(42);                // ERROR: 42 is i32 (value type), not object type
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
static const yo_dyn_module_Id_vtable yo_vtable_Box_i32_Id = {
  .id = wrapper_Box_i32_id  // Points to wrapper
};
```

**For object types:**

```c
// Original method implementation for Point
void fn_Point_print(Point* self) {
  printf("(%d, %d)", self->x, self->y);
}

// Static vtable for dyn(point) - no wrapper needed!
static const yo_dyn_module_Printer_vtable yo_vtable_Point_Printer = {
  .print = (void(*)(void*))fn_Point_print  // Direct cast
};
```

## Construction: `dyn(value)`

When constructing a `Dyn`, the value must be an object type. The `Dyn` struct is created on the stack and stores the data pointer.

```c
// For dyn(box(42)):
Box_i32* boxed = /* result of box(42) */;  // Already has RC = 1

yo_dyn_module_Id result = {
  .data = boxed,
  .vtable = &yo_vtable_Box_i32_Id
};
// Note: No dup here, ownership transfers from box(42) to dyn
```

```c
// For dyn(point) where point : Point:
Point* point = /* Point(3, 4) */;  // Already has RC = 1

yo_dyn_module_Printer result = {
  .data = point,
  .vtable = &yo_vtable_Point_Printer
};
// Note: No dup here, ownership transfers from point to dyn
```

**Key Point**: Since `Dyn` is a value type, it's created on the stack. The `data` pointer's ownership is transferred (no dup at construction).

## Method Dispatch

Method calls on `Dyn` go through the vtable. Since `Dyn` is a value type, `value` is the struct itself.

```c
// value has type yo_dyn_module_TestDyn (struct, not pointer)
int32_t result = value.vtable->return_i32(value.data);
value.vtable->print(value.data);
```

## Reference Counting for Dyn

Since `Dyn` is a value type, we need dup/drop functions that operate on the `data` pointer.

### Dup Function

When copying a `Dyn`, increment the `data` pointer's RC:

```c
yo_dyn_module_Id __yo_dup_dyn_module_Id(yo_dyn_module_Id dyn) {
  if (dyn.data) {
    __yo_incr_rc(dyn.data);  // data is always an object type
  }
  return dyn;  // Return the copied struct
}
```

### Drop Function

When dropping a `Dyn`, decrement the `data` pointer's RC:

```c
void __yo_drop_dyn_module_Id(yo_dyn_module_Id dyn) {
  if (dyn.data) {
    __yo_decr_rc(dyn.data);  // data is always an object type
  }
}
```

**Key Points:**
- No type-specific dup/drop needed - `data` is always an object pointer
- The `data` object's dispose function handles cleanup (Box or regular object)
- `Dyn` itself is never heap-allocated, so no dispose function needed

## Implementation Plan

### Phase 1: Collection & Analysis
- Track `dyn()` call sites during expression analysis
- Collect: `{ dynType, concreteType, implModuleValue }[]`
- Store in `context.dynImpls` or similar

### Phase 2: Generate Wrapper Functions
**Location**: `src/codegen/functions/generation.ts`

For boxed value types, generate wrappers to unwrap `Box(T)` before calling impl:
```typescript
function generateDynMethodWrapper(
  implType: Type,
  method: Method,
  moduleType: ModuleType,
  context: CodeGenContext
): string {
  if (implType.kind === 'object') {
    // Object type: no wrapper needed, return direct cast
    const methodFuncId = getMethodFunctionId(implType, method.name);
    const returnType = getTypeString(method.returnType, context);
    return `(${returnType}(*)(void*))${methodFuncId}`;
  }
  
  // Value type: generate wrapper to unwrap Box(T)
  const implCName = getTypeCName(implType, context);
  const wrapperName = `wrapper_Box_${implCName}_${method.name}`;
  const returnType = getTypeString(method.returnType, context);
  const methodFuncId = getMethodFunctionId(implType, method.name);
  
  emitter.emitLine(`${returnType} ${wrapperName}(void* self_ptr) {`);
  emitter.emitLine(`  Box_${implCName}* box = (Box_${implCName}*)self_ptr;`);
  emitter.emitLine(`  return ${methodFuncId}(&box->value);`);
  emitter.emitLine(`}`);
  
  return wrapperName;
}
```

### Phase 3: Generate Static Vtables
**Location**: `src/codegen/functions/generation.ts`

For each dyn impl, generate static vtable using wrappers or direct casts:
```typescript
function generateStaticVtable(
  implType: Type,
  dynType: DynType,
  context: FunctionGenerationContext
) {
  const vtableName = `yo_vtable_${implCName}_${moduleCName}`;
  
  emitter.emitLine(`static const ${dynVtableType} ${vtableName} = {`);
  
  for (const method of moduleType.fields) {
    // Generate wrapper (or direct cast for object types)
    const funcPtr = generateDynMethodWrapper(implType, method, moduleType, context);
    emitter.emitLine(`  .${method.name} = ${funcPtr},`);
  }
  
  emitter.emitLine(`};`);
}
```

### Phase 4: Update dyn() Call Generation
**Location**: `src/codegen/expressions/generation.ts`

```typescript
function generateDynCall(expr: FuncCallExpr, indent: string, context: CodeGenContext): string {
  const valueExpr = expr.args[0];
  const dynType = expr.$.type as DynType;
  const valueType = valueExpr.$.type;
  
  // valueExpr must be an object type (pointer with ref_header)
  if (valueType.kind !== 'pointer' || valueType.baseType.kind !== 'object') {
    throw new Error('dyn() requires object type (use box() for value types)');
  }
  
  const concreteType = valueType.baseType;
  
  // Generate value (this is an object pointer)
  const valueCode = generateExpr(valueExpr, indent, context);
  
  // Create Dyn struct on stack
  const dynVar = expr.$.variableName || generateTempName();
  const dynCName = getTypeCName(dynType, context);
  const vtableName = `yo_vtable_${getTypeCName(concreteType, context)}_${dynType.moduleName}`;
  
  context.emitter.emitLine(`${indent}${dynCName} ${dynVar} = {`);
  context.emitter.emitLine(`${indent}  .data = ${valueCode},`);
  context.emitter.emitLine(`${indent}  .vtable = &${vtableName}`);
  context.emitter.emitLine(`${indent}};`);
  
  return dynVar;
}
```

### Phase 5: Update Method Call on Dyn
**Location**: `src/codegen/expressions/generation.ts`

When calling a method on Dyn value (which is a struct):
```typescript
function generateMethodCallOnDyn(
  receiver: Expr,
  methodName: string,
  dynType: DynType,
  context: CodeGenContext
): string {
  const receiverCode = generateExpr(receiver, indent, context);
  
  // receiver is a struct: yo_dyn_module_TestDyn
  // Generate: receiver.vtable->method(receiver.data)
  return `${receiverCode}.vtable->${methodName}(${receiverCode}.data)`;
}
```

### Phase 6: Generate Dup/Drop Functions
**Location**: `src/codegen/functions/generation.ts`

Since `Dyn` is a value type, generate dup/drop functions that operate on the `data` pointer:

```typescript
function generateDynDupDrop(dynType: DynType, context: CodeGenContext) {
  const dynCName = getTypeCName(dynType, context);
  
  // Generate dup function
  emitter.emitLine(`${dynCName} __yo_dup_${dynCName}(${dynCName} dyn) {`);
  emitter.emitLine(`  if (dyn.data) {`);
  emitter.emitLine(`    __yo_incr_rc(dyn.data);`);
  emitter.emitLine(`  }`);
  emitter.emitLine(`  return dyn;`);
  emitter.emitLine(`}`);
  
  // Generate drop function
  emitter.emitLine(`void __yo_drop_${dynCName}(${dynCName} dyn) {`);
  emitter.emitLine(`  if (dyn.data) {`);
  emitter.emitLine(`    __yo_decr_rc(dyn.data);`);
  emitter.emitLine(`  }`);
  emitter.emitLine(`}`);
}
```

## Testing Plan

1. **Boxed value types**: `dyn(box(42))`, `dyn(box(true))`
2. **Object types**: `point := Point(3, 4); dyn(point)`
3. **Method calls**: `value.print()`, `value.return_i32()`
4. **Memory leaks**: Verify no leaks with AddressSanitizer (should see Box being freed)
5. **Object-safety**: Verify error when calling Self-returning methods on Dyn
6. **Type errors**: Verify error when calling `dyn(42)` or `dyn(&(42))` without `box()`
7. **Dup/Drop**: Verify correct RC on assignment: `x := dyn(box(42)); y := x;`

## Summary of Design

1. **`Dyn` is a value type**: Simple struct with `{ void* data, vtable* }`, no ref_header
2. **`data` must be object type**: Enforces that data is always reference counted
3. **Value types use `box()`**: `dyn(box(42))` wraps value in `Box(T)` object type
4. **Object types direct**: `dyn(Point(3, 4))` uses Point pointer directly
5. **Wrappers for Box**: Generated wrappers unwrap `Box(T)` before calling impl methods
6. **Simple RC**: Only `data` is reference counted, `Dyn` struct is copied by value
7. **Dup/Drop functions**: Standard functions that dup/drop the `data` pointer