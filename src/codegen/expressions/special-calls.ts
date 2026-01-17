import { FuncCallExpr } from "../../expr";
import {
  extractFnTraitFromType,
  isBoxedType,
  isDynType,
  isObjectType,
  isSomeType,
  isStructType,
  Type,
} from "../../types";
import { randomId } from "../../utils";
import {
  CodeGenContext,
  getTypeString,
  getVariableNameForCodegen,
  getVariableTypeString,
} from "../utils";
import { generateExpr } from "./generation";

/**
 * Generate C code for __yo_thread_spawn(cb : Impl(Fn() -> unit, Send)) call.
 *
 * This function handles the special case where we spawn a thread with a closure.
 * The closure (Impl type) needs to be:
 * 1. Copied to heap-allocated memory (since the thread needs it after this function returns)
 * 2. The closure function pointer is looked up from implClosureCallMap
 * 3. Call __yo_thread_spawn(closure_fn_ptr, heap_closure_data)
 */
export function generateThreadSpawnCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
  if (!runtimeArgExprs || runtimeArgExprs.length !== 1) {
    return `/* Error: __yo_thread_spawn requires exactly 1 argument */`;
  }

  const cbArg = runtimeArgExprs[0]!;
  const cbType = cbArg.$?.type;

  if (!cbType) {
    return `/* Error: __yo_thread_spawn argument has no type */`;
  }

  // Get the concrete type ID for the closure
  // For Impl(Fn...) closures, the concrete type is either:
  // 1. A SomeType with resolvedConcreteType (the capture struct)
  // 2. The type itself if it's already a concrete struct
  let concreteTypeId: string | undefined;
  let concreteType: Type | undefined;

  if (isSomeType(cbType)) {
    const someType = cbType as Type;
    if (isSomeType(someType) && someType.resolvedConcreteType) {
      concreteTypeId = someType.resolvedConcreteType.id;
      concreteType = someType.resolvedConcreteType;
    }
  } else if (isStructType(cbType)) {
    // Direct struct type
    concreteTypeId = cbType.id;
    concreteType = cbType;
  }

  if (!concreteTypeId || !concreteType) {
    return `/* Error: __yo_thread_spawn could not determine concrete closure type */`;
  }

  // Look up the closure function in implClosureCallMap
  const closureInfo = context.implClosureCallMap.get(concreteTypeId);
  if (!closureInfo) {
    return `/* Error: __yo_thread_spawn could not find closure function for type ${concreteTypeId} */`;
  }

  const closureFunctionCName = closureInfo.functionCName;
  const captureStructCName = getTypeString(concreteType, context);

  // Generate the argument code
  const cbArgCode = generateExpr(cbArg, indent, context);

  // If the argument has a variable name, use it; otherwise use the generated code
  const cbVarName = cbArg.$?.variableName
    ? getVariableNameForCodegen(cbArg.$.variableName, cbArg.$.env)
    : cbArgCode;

  // Emit code to heap-allocate a copy of the closure data
  // The thread entry wrapper will free this after the closure runs
  const heapDataVar = `_thread_closure_data_${randomId(expr.$?.env.modulePath ?? "")}`;
  context.emitter.emitLine(
    `${indent}${captureStructCName}* ${heapDataVar} = (${captureStructCName}*)__yo_malloc(sizeof(${captureStructCName}));`
  );
  context.emitter.emitLine(`${indent}*${heapDataVar} = ${cbVarName};`);

  // Get the return type for __yo_thread_spawn which is __yo_thread_t
  const tempVar = expr.$?.variableName;
  if (tempVar) {
    context.emitter.emitLine(
      `${indent}__yo_thread_t ${tempVar} = __yo_thread_spawn(${closureFunctionCName}, ${heapDataVar});`
    );
    return tempVar;
  } else {
    // Return inline expression (though usually __yo_thread_spawn result is assigned)
    return `__yo_thread_spawn(${closureFunctionCName}, ${heapDataVar})`;
  }
}

/**
 * Generate C code for __yo_worker_spawn(cb : Impl(Fn() -> unit, Send)) call.
 *
 * Similar to __yo_thread_spawn, but spawns the task on the worker thread pool.
 * The worker pool handles thread affinity - each task stays on its assigned thread.
 */
export function generateWorkerSpawnCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
  if (!runtimeArgExprs || runtimeArgExprs.length !== 1) {
    return `/* Error: __yo_worker_spawn requires exactly 1 argument */`;
  }

  const cbArg = runtimeArgExprs[0]!;
  const cbType = cbArg.$?.type;

  if (!cbType) {
    return `/* Error: __yo_worker_spawn argument has no type */`;
  }

  // Get the concrete type ID for the closure
  let concreteTypeId: string | undefined;
  let concreteType: Type | undefined;

  if (isSomeType(cbType)) {
    const someType = cbType as Type;
    if (isSomeType(someType) && someType.resolvedConcreteType) {
      concreteTypeId = someType.resolvedConcreteType.id;
      concreteType = someType.resolvedConcreteType;
    }
  } else if (isStructType(cbType)) {
    concreteTypeId = cbType.id;
    concreteType = cbType;
  }

  if (!concreteTypeId || !concreteType) {
    return `/* Error: __yo_worker_spawn could not determine concrete closure type */`;
  }

  // Look up the closure function in implClosureCallMap
  const closureInfo = context.implClosureCallMap.get(concreteTypeId);
  if (!closureInfo) {
    return `/* Error: __yo_worker_spawn could not find closure function for type ${concreteTypeId} */`;
  }

  const closureFunctionCName = closureInfo.functionCName;
  const captureStructCName = getTypeString(concreteType, context);

  // Generate the argument code
  const cbArgCode = generateExpr(cbArg, indent, context);

  // If the argument has a variable name, use it; otherwise use the generated code
  const cbVarName = cbArg.$?.variableName
    ? getVariableNameForCodegen(cbArg.$.variableName, cbArg.$.env)
    : cbArgCode;

  // Emit code to heap-allocate a copy of the closure data
  // The worker thread will free this after the task runs
  const heapDataVar = `_worker_closure_data_${randomId(expr.$?.env.modulePath ?? "")}`;
  context.emitter.emitLine(
    `${indent}${captureStructCName}* ${heapDataVar} = (${captureStructCName}*)__yo_malloc(sizeof(${captureStructCName}));`
  );
  context.emitter.emitLine(`${indent}*${heapDataVar} = ${cbVarName};`);

  // __yo_worker_spawn returns void (unit), so just emit the call
  context.emitter.emitLine(
    `${indent}__yo_worker_spawn(${closureFunctionCName}, ${heapDataVar});`
  );

  return "";
}

/**
 * Generate C code for a dyn() constructor call
 */
export function generateDynCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!expr.$?.dynCallTraitValues || expr.$.dynCallTraitValues.length === 0) {
    return `/* Error: dyn() call missing module values */`;
  }

  // Use runtimeArgExprsInOrder which contains the evaluated args with metadata
  const valueExpr = expr.$?.runtimeArgExprsInOrder?.[0] ?? expr.args[0];
  if (!valueExpr) {
    return `/* Error: dyn() requires a value argument */`;
  }

  // Get the dyn type information
  const dynType = expr.$.type;
  if (!isDynType(dynType)) {
    return `/* Error: dyn() result type is not DynType */`;
  }

  // Note: Dyn is always a value type fat pointer (per DYN_DESIGN.md).
  // Closures are value types, so Dyn(Fn(...)) must wrap a boxed closure: `dyn(box(closure))`.

  // Regular dyn() call - dyn is a value type (fat pointer)
  // The wrapped value must be an object type (including Box(T)).
  const valueType = valueExpr.$?.type;
  if (!valueType) {
    return `/* Error: dyn() value has no type */`;
  }

  // Get the module value from dynCallTraitValues
  const traitValues = expr.$.dynCallTraitValues;
  if (!traitValues || traitValues.length === 0) {
    return `/* Error: dyn() call missing module values */`;
  }

  // dyn() requires an object type (including Box(T)); value types must use box().
  if (!isObjectType(valueType) && !isBoxedType(valueType)) {
    return `/* Error: dyn() requires an object type (use box() for value types) */`;
  }

  // If value is Box(T), the impl concrete type is T, but the runtime data type is Box(T).
  const concreteType: Type = isBoxedType(valueType)
    ? valueType.fields[0]!.type
    : valueType;

  // Create a unique key for this impl combination
  const dynTypeCName =
    context.types[dynType.id]?.cName || `yo_dyn_${dynType.id}`;
  // For boxed closures, concreteType is often `Impl(Fn(...))` which is a `SomeType`.
  // Prefer the corresponding FnTraitType's C name so generated symbols are stable.
  const concreteTypeCName = (() => {
    const direct = context.types[concreteType.id]?.cName;
    if (direct) {
      return direct;
    }
    const fnModule = extractFnTraitFromType(concreteType);
    const fnModuleCName = fnModule
      ? context.types[fnModule.id]?.cName
      : undefined;
    return fnModuleCName || `unknown_${concreteType.id}`;
  })();
  const implKey = `${concreteTypeCName}_${dynTypeCName}`;

  // Register this impl in context for later generation
  context.dynImpls.set(implKey, {
    dynType,
    concreteType,
    dataType: valueType,
    traitValues,
  });

  // Generate the value expression
  let valueCode = generateExpr(valueExpr, indent, context);

  // If the value expression has a temporary variable name assigned by the evaluator,
  // we must declare it because deferred drop expressions might refer to it.
  if (valueExpr.$?.variableName && valueCode !== valueExpr.$.variableName) {
    const varTypeAndName = getVariableTypeString(
      valueExpr.$.type!,
      valueExpr.$.variableName,
      context
    );
    context.emitter.emitLine(`${indent}${varTypeAndName} = ${valueCode};`);
    valueCode = valueExpr.$.variableName;
  }

  const tempVarName = expr.$?.variableName;
  if (!tempVarName) {
    return `/* Error: dyn() expression missing temp variable name */`;
  }

  // Generate: Dyn value = { .data = valueCode, .vtable = &vtable }
  const vtableName = `yo_vtable_${implKey}`;
  context.emitter.emitLine(`${indent}${dynTypeCName} ${tempVarName} = {`);
  context.emitter.emitLine(`${indent}  .data = ${valueCode},`);
  context.emitter.emitLine(`${indent}  .vtable = &${vtableName}`);
  context.emitter.emitLine(`${indent}};`);

  return tempVarName;
}
