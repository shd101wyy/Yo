# Dyn/dyn Dynamic Dispatch Implementation

## Overview

`Dyn(Module)` enables runtime polymorphism through dynamic dispatch with type erasure.

```yo
Id :: module(id : (fn(self : Self) -> Self));

impl(i32, Id(id : ((self) -> { printf("i32: %d\n", self); return self; })));
impl(boolean, Id(id : ((self) -> { printf("bool\n"); return self; })));

use_id :: (fn(value : Dyn(Id)) -> unit) { x := value.id(); };

main :: (fn() -> unit) {
  use_id(dyn(i32(42)));
  use_id(dyn(true));
};
```

## Core Design

### 1. Dyn Type (Value Type - Fat Pointer)

```c
typedef struct {
  void* data;                    // Box pointer (yo_ref_header_t + value)
  const ModuleVtable* vtable;    // Static vtable pointer
} yo_dyn_module_Id;
```

### 2. Box Types (One Per Concrete Type)

```c
// For value types - store inline
typedef struct {
  yo_ref_header_t header;
  int32_t value;
} yo_dyn_box_i32;

// For reference types - store pointer
typedef struct {
  yo_ref_header_t header;
  MyBox* value;  // Pointer to RC'd object
} yo_dyn_box_MyBox;
```

### 3. Vtable Structure (Uniform Signatures with Direct Casts)

```c
typedef struct {
  int32_t (*return_i32)(void*);    // All return types must be concrete (no Self)
  void (*print)(void*);            // unit return type
} yo_dyn_module_TestDyn_vtable;
```

**Key insight**: NO wrapper functions needed! All methods use direct function pointer casts.

## Object-Safety Constraint (Following Rust)

**Constraint**: Modules used with `Dyn()` **cannot** have methods that:
1. Return `Self` 
2. Return types containing `Self` (like `Option(Self)`, `Result(Self, E)`, etc.)

This follows Rust's "object-safety" rules. The reason: different concrete types would produce different return types, making uniform vtable signatures impossible without complex type erasure.

**Valid** for dynamic dispatch:
```yo
TestDyn :: module(
  return_i32 : fn(Self) -> i32,  // Returns concrete type - OK!
  print : fn(Self) -> unit        // Returns unit - OK!
);
```

**Invalid** for dynamic dispatch (object-safety violation):
```yo
TestDyn :: module(
  id : fn(Self) -> Self           // Returns Self - NOT object-safe!
);
```

The constraint is **enforced at method call time**, not at module definition. You can define modules with Self-returning methods, but you cannot call those methods on Dyn values.

### 4. Static Vtables Example

```c
// Original method implementations (unchanged)
int32_t fn_i32_return_i32(int32_t self) {
  return self;
}

void fn_i32_print(int32_t self) {
  printf("i32: %d\n", self);
}

// Static vtable: direct casts only (no wrappers needed!)
static const yo_dyn_module_TestDyn_vtable yo_vtable_i32_TestDyn = {
  .return_i32 = (int32_t(*)(void*))fn_i32_return_i32,  // Direct cast
  .print = (void(*)(void*))fn_i32_print                 // Direct cast
};
```

## Construction: `dyn(value)`

```c
// For dyn(i32(42)):
yo_dyn_box_i32* box = __yo_new_dyn_box_i32(42);
yo_dyn_module_Id result = {
  .data = box,
  .vtable = &yo_vtable_i32_Id
};
```

Box constructor:
```c
yo_dyn_box_i32* __yo_new_dyn_box_i32(int32_t value) {
  yo_dyn_box_i32* box = __yo_malloc(sizeof(yo_dyn_box_i32));
  box->header.ref_count = 1;
  box->header.gc_flags = 0;
  box->header.gc_mark = YO_GC_UNMARKED;
  box->header.gc_next = NULL;
  box->header.gc_prev = NULL;
  box->header.dispose_fn = __yo_dispose_dyn_box_i32;
  box->header.traverse_fn = NULL;
  box->value = value;
  return box;
}
```

## Method Dispatch

```c
// All methods return concrete types - no boxing/unboxing needed!
int32_t result = value.vtable->return_i32(value.data);
value.vtable->print(value.data);
```

## Box Dispose Functions

```c
void __yo_dispose_dyn_box_i32(void* ptr) {
  // Value type - no cleanup needed
}

void __yo_dispose_dyn_box_MyBox(void* ptr) {
  yo_dyn_box_MyBox* box = (yo_dyn_box_MyBox*)ptr;
  if (box->value) {
    __yo_decr_rc(box->value);  // Drop wrapped object
  }
}
```

## Implementation Plan

### Phase 1: Collection & Analysis
- Track `dyn()` call sites during expression analysis
- Collect: `{ dynType, concreteType, implModuleValue }[]`
- Store in `context.dynImpls` or similar

### Phase 2: Generate Box Types
**Location**: `src/codegen/types/generation.ts`

For each concrete type used in `dyn()`:
```typescript
function generateDynBoxType(concreteType: Type, cName: string, context: CodeGenContext) {
  const boxTypeName = `yo_dyn_box_${cName}`;
  const valueType = getTypeString(concreteType, context);
  
  // Generate box struct
  emitter.emitDeclarationLine(`typedef struct {`);
  emitter.emitDeclarationLine(`  yo_ref_header_t header;`);
  emitter.emitDeclarationLine(`  ${valueType} value;`);
  emitter.emitDeclarationLine(`} ${boxTypeName};`);
  
  // Generate constructor declaration
  emitter.emitDeclarationLine(`${boxTypeName}* __yo_new_${boxTypeName}(${valueType} value);`);
  
  // Generate dispose declaration
  emitter.emitDeclarationLine(`void __yo_dispose_${boxTypeName}(void* ptr);`);
}
```

### Phase 3: Generate Static Vtables
**Location**: `src/codegen/functions/generation.ts`

For each dyn impl, generate static vtable with direct casts:
```typescript
function generateStaticVtable(
  implType: Type,
  dynType: DynType,
  context: FunctionGenerationContext
) {
  const vtableName = `yo_vtable_${implCName}_${moduleCName}`;
  
  emitter.emitLine(`static const ${dynVtableType} ${vtableName} = {`);
  
  for (const method of moduleType.fields) {
    // Direct cast - no wrapper functions!
    const methodFuncId = getMethodFunctionId(implType, method.name);
    const returnTypeStr = getTypeString(method.type.return.type, context);
    emitter.emitLine(`  .${method.name} = (${returnTypeStr}(*)(void*))${methodFuncId},`);
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
  const concreteType = valueExpr.$.type;
  
  // Generate value
  const valueCode = generateExpr(valueExpr, indent, context);
  
  // Allocate box
  const boxCtor = `__yo_new_dyn_box_${concreteCName}`;
  context.emitter.emitLine(`${indent}${boxType}* box = ${boxCtor}(${valueCode});`);
  
  // Create Dyn value
  const dynVar = expr.$.variableName || generateTempName();
  context.emitter.emitLine(`${indent}${dynCName} ${dynVar} = {`);
  context.emitter.emitLine(`${indent}  .data = box,`);
  context.emitter.emitLine(`${indent}  .vtable = &yo_vtable_${implCName}_${moduleCName}`);
  context.emitter.emitLine(`${indent}};`);
  
  return dynVar;
}
```

### Phase 5: Update Method Call on Dyn
**Location**: `src/codegen/expressions/generation.ts`

When calling a method on Dyn value:
```typescript
function generateMethodCallOnDyn(
  receiver: Expr,
  methodName: string,
  dynType: DynType,
  context: CodeGenContext
): string {
  const receiverCode = generateExpr(receiver, indent, context);
  
  // Generate: receiver.vtable->method(receiver.data)
  return `${receiverCode}.vtable->${methodName}(${receiverCode}.data)`;
}
```

### Phase 6: Update ___drop for Dyn
**Location**: `src/codegen/functions/generation.ts`

Dyn drop function should decrement RC of boxed data:
```c
void fn_drop_Dyn_TestDyn(yo_dyn_module_TestDyn self) {
  __yo_decr_rc(self.data);
}
```

## Testing Plan

1. **Basic value types**: `dyn(i32(42))`, `dyn(true)`
2. **Reference types**: `dyn(MyBox(100))`
3. **Method calls**: `value.print()`, `value.return_i32()`
4. **Memory leaks**: Verify no leaks with AddressSanitizer
5. **Object-safety**: Verify error when calling Self-returning methods on Dyn