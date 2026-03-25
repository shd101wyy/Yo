## Implementation Plan

### Phase 1: Collection & Analysis

- Track `dyn()` call sites during expression analysis
- Collect: `{ dynType, concreteType, implTraitValue }[]`
- Store in `context.dynImpls` or similar

### Phase 2: Generate Wrapper Functions

**Location**: `src/codegen/functions/generation.ts`

For boxed value types, generate wrappers to unwrap `Box(T)` before calling impl:

```typescript
function generateDynMethodWrapper(
  implType: Type,
  method: Method,
  traitType: TraitType,
  context: CodeGenContext
): string {
  if (isObjectType(implType)) {
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
  const vtableName = `__yo_vtable_${implCName}_${traitCName}`;

  emitter.emitLine(`static const ${dynVtableType} ${vtableName} = {`);

  for (const method of traitType.fields) {
    // Generate wrapper (or direct cast for object types)
    const funcPtr = generateDynMethodWrapper(
      implType,
      method,
      traitType,
      context
    );
    emitter.emitLine(`  .${method.name} = ${funcPtr},`);
  }

  emitter.emitLine(`};`);
}
```

### Phase 4: Update dyn() Call Generation

**Location**: `src/codegen/expressions/generation.ts`

```typescript
function generateDynCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const valueExpr = expr.args[0];
  const dynType = expr.$.type as DynType;
  const valueType = valueExpr.$.type;

  // valueExpr must be an object type (pointer with ref_header)
  if (valueType.kind !== "pointer" || valueType.baseType.kind !== "object") {
    throw new Error("dyn() requires object type (use box() for value types)");
  }

  const concreteType = valueType.baseType;

  // Generate value (this is an object pointer)
  const valueCode = generateExpr(valueExpr, indent, context);

  // Create Dyn struct on stack
  const dynVar = expr.$.variableName || generateTempName();
  const dynCName = getTypeCName(dynType, context);
  const vtableName = `__yo_vtable_${getTypeCName(concreteType, context)}_${dynType.traitName}`;

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

  // receiver is a struct: __yo_dyn_trait_TestDyn
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
