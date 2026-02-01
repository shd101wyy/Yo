import { FnCallExpr } from "../../expr";
import { SomeType, Type } from "../../types/definitions";
import { isSomeType, isStructType } from "../../types/guards";
import { randomId } from "../../utils";
import {
  CodeGenContext,
  getTypeString,
  getVariableNameForCodegen,
} from "../utils";
import { generateExpr } from "./expr";

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
  expr: FnCallExpr,
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
    const someType = cbType as SomeType;
    if (someType.resolvedConcreteType) {
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
  expr: FnCallExpr,
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
    const someType = cbType as SomeType;
    if (someType.resolvedConcreteType) {
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
 * __yo_thread_set_maximum_threads - set maxmium number of threads for coroutine schedular
 */
export function generateYoThreadSetMaximumThreads(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const numArg = expr.args[0];
  if (!numArg) {
    return `// Error: __yo_thread_set_maximum_threads requires exactly 1 argument`;
  }
  const numCode = generateExpr(numArg, indent, context);
  return `__yo_thread_set_maximum_threads(${numCode})`;
}
