import type { FnCallExpr } from "../../expr";
import type { StructType, SomeType, Type } from "../../types/definitions";
import { isSomeType, isStructType } from "../../types/guards";
import { randomId } from "../../utils";
import {
  type CodeGenContext,
  getTypeString,
  getVariableNameForCodegen,
} from "../utils";
import { getEvidenceParameters } from "../functions/declarations";
import { generateExpr } from "./expr";
import { getDupFunctionForType, getDropFunctionForType } from "./drop-dup";
import { typeContainsRcType } from "../../types/utils";

/**
 * Generate a spawn wrapper function for thread/worker spawn.
 *
 * The wrapper handles proper RC cleanup for heap-copied capture structs:
 * 1. Calls the actual closure function (with NULL evidence args if needed)
 * 2. NULLs out captured fields that were consumed (own(self)) inside the closure
 * 3. Drops the capture struct (releases thread/worker-owned RC refs, skips NULLed fields)
 * 4. Frees the heap-allocated capture struct
 *
 * This prevents double-free when a closure consumes a captured variable via own(self):
 * - The heap copy is dup'd before spawn, giving both creator and thread independent RC refs
 * - The closure body consumes the field (decrements RC via own + drop)
 * - NULLing prevents the wrapper's drop from decrementing the same field again
 * - The creator's deferred drop handles the creator-owned RC ref
 */
function generateSpawnWrapper(
  closureFunctionCName: string,
  closureInfo: {
    callType?: import("../../types/definitions").FunctionType;
    consumedCaptures?: string[];
  },
  captureStructCName: string,
  captureType: Type | undefined,
  context: CodeGenContext,
  prefix: string
): string {
  const evidenceParams = closureInfo.callType
    ? getEvidenceParameters(closureInfo.callType)
    : [];
  const nullArgs =
    evidenceParams.length > 0
      ? `, ${evidenceParams.map(() => "NULL").join(", ")}`
      : "";

  const wrapperId = randomId(prefix);
  const wrapperName = `__yo_spawn_wrapper_${wrapperId}`;

  // Build the wrapper body
  let body = "";

  // Step 1: Call the closure function
  body += `  ${closureFunctionCName}(closure${nullArgs});\n`;

  // Step 2-4: NULL consumed fields, drop capture struct, free heap memory
  const dropFn =
    captureType && isStructType(captureType)
      ? getDropFunctionForType(captureType, context)
      : undefined;

  if (dropFn && captureType && isStructType(captureType)) {
    // NULL out consumed captures (fields that were passed to own(self))
    const consumedCaptures = closureInfo.consumedCaptures;
    if (consumedCaptures && consumedCaptures.length > 0) {
      const structType = captureType as StructType;
      for (const fieldName of consumedCaptures) {
        const field = structType.fields.find((f) => f.label === fieldName);
        if (field && typeContainsRcType(field.type)) {
          body += `  ((${captureStructCName}*)closure)->${fieldName} = NULL;\n`;
        }
      }
    }
    // Drop the capture struct (releases thread's RC refs, skips NULLed fields)
    body += `  ${dropFn}(*(${captureStructCName}*)closure);\n`;
  }

  // Free heap memory
  body += `  __yo_free(closure);\n`;

  // Emit the wrapper function in the declaration section
  context.emitter.emitDeclarationLine(`
// Spawn wrapper: handles RC cleanup for thread-spawned closures
static void ${wrapperName}(void* closure) {
${body}}`);

  return wrapperName;
}

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

  // Always generate a wrapper that handles RC cleanup for the heap-copied capture struct
  const spawnFnName = generateSpawnWrapper(
    closureFunctionCName,
    closureInfo,
    captureStructCName,
    concreteType,
    context,
    expr.$?.env.modulePath ?? ""
  );

  // Generate the argument code
  const cbArgCode = generateExpr(cbArg, indent, context);

  // If the argument has a variable name, use it; otherwise use the generated code
  const cbVarName = cbArg.$?.variableName
    ? getVariableNameForCodegen(cbArg.$.variableName, cbArg.$.env)
    : cbArgCode;

  // Emit code to heap-allocate a copy of the closure data
  const heapDataVar = `_thread_closure_data_${randomId(expr.$?.env.modulePath ?? "")}`;
  context.emitter.emitLine(
    `${indent}${captureStructCName}* ${heapDataVar} = (${captureStructCName}*)__yo_malloc(sizeof(${captureStructCName}));`
  );
  context.emitter.emitLine(`${indent}*${heapDataVar} = ${cbVarName};`);
  const dupFn = getDupFunctionForType(concreteType, context);
  if (dupFn) {
    context.emitter.emitLine(`${indent}${dupFn}(*${heapDataVar});`);
  }

  // Get the return type for __yo_thread_spawn which is __yo_thread_t
  const tempVar = expr.$?.variableName;
  if (tempVar) {
    context.emitter.emitLine(
      `${indent}__yo_thread_t ${tempVar} = __yo_thread_spawn(${spawnFnName}, ${heapDataVar});`
    );
    return tempVar;
  } else {
    // Return inline expression (though usually __yo_thread_spawn result is assigned)
    return `__yo_thread_spawn(${spawnFnName}, ${heapDataVar})`;
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

  // Always generate a wrapper that handles RC cleanup for the heap-copied capture struct
  const spawnFnName = generateSpawnWrapper(
    closureFunctionCName,
    closureInfo,
    captureStructCName,
    concreteType,
    context,
    expr.$?.env.modulePath ?? ""
  );

  // Generate the argument code
  const cbArgCode = generateExpr(cbArg, indent, context);

  // If the argument has a variable name, use it; otherwise use the generated code
  const cbVarName = cbArg.$?.variableName
    ? getVariableNameForCodegen(cbArg.$.variableName, cbArg.$.env)
    : cbArgCode;

  // Emit code to heap-allocate a copy of the closure data
  const heapDataVar = `_worker_closure_data_${randomId(expr.$?.env.modulePath ?? "")}`;
  context.emitter.emitLine(
    `${indent}${captureStructCName}* ${heapDataVar} = (${captureStructCName}*)__yo_malloc(sizeof(${captureStructCName}));`
  );
  context.emitter.emitLine(`${indent}*${heapDataVar} = ${cbVarName};`);
  const dupFn = getDupFunctionForType(concreteType, context);
  if (dupFn) {
    context.emitter.emitLine(`${indent}${dupFn}(*${heapDataVar});`);
  }

  // __yo_worker_spawn returns void (unit), so just emit the call
  context.emitter.emitLine(
    `${indent}__yo_worker_spawn(${spawnFnName}, ${heapDataVar});`
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
