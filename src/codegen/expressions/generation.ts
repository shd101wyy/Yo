import { Environment, getVariablesFromEnv } from "../../env";
import { AwaitAnalysisResult } from "../../evaluator/async/await-analysis-types";
import {
  AtomExpr,
  BuiltinFunctions,
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  ExprTag,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  ArrayType,
  DynType,
  extractFnModuleFromType,
  extractFutureModuleFromType,
  isArrayType,
  isBoxedType,
  isDynType,
  isEnumType,
  isFunctionType,
  isGcType,
  isIsoType,
  isNewtypeType,
  isObjectType,
  isPtrType,
  isSliceType,
  isSomeType,
  isStructType,
  isTupleType,
  isUnionType,
  isUnitType,
  ModuleType,
  SliceType,
  SomeType,
  StructType,
  Type,
  typeContainsGcType,
  typeImplementsFn,
  typeImplementsFuture,
  TypeTag,
  typeToString,
} from "../../types";
import { isTempVariableName, randomId } from "../../utils";
import {
  isArrayValue,
  isBooleanValue,
  isComptStringValue,
  isEnumValue,
  isFunctionValue,
  isNumberValue,
  isStructValue,
  isTypeValue,
  isUnknownValue,
  Value,
  valueToString,
} from "../../value";
import {
  generateAsyncBlockResumeFunction,
  getStateMachineFieldName,
} from "../async/state-machine";
import { BuiltinYoInlineFunctions } from "../constants";
import { FunctionGenerationContext } from "../functions/context";
import {
  canOptimizeAsNullablePointer,
  canOptimizeAsSimpleEnum,
  CodeGenContext,
  getEnumVariantCName,
  getTypeString,
  getVariableTypeString,
  isFunctionValueWithOnlyBuiltinYoInlineFunctionCall,
  sanitizeForCIdentifier,
} from "../utils";
import { generateArrayFillCall, isArrayFillMethodCall } from "./array";

/**
 * Check if a variable is captured by the closure or is a local variable.
 * A variable is captured if the latest variable with that name exists at a frame level
 * that is <= the closure capture frame level.
 * Variables at higher frame levels (more recent scopes) are local variables.
 */
function checkVariableIsClosureCaptured(
  variableName: string,
  env: Environment,
  closureCaptureFrameLevel: number
): boolean {
  // Get all variables with this name, ordered from oldest to newest
  const variables = getVariablesFromEnv(env, variableName);

  if (variables.length === 0) {
    // Variable not found in environment - assume it's not captured
    return false;
  }

  // Get the latest (most recent) variable with this name
  const latestVariable = variables[variables.length - 1]!;

  // Check if it's from a captured frame level
  return latestVariable.frameLevel <= closureCaptureFrameLevel;
}

/**
 * Get the actual variable name to use in generated code, checking for parameterAlias.
 * In anonymous functions, the parameter name may differ from the expected interface parameter name.
 * If a parameterAlias exists, it should be used instead of the variable's actual name.
 *
 * @param variableName The variable name to look up
 * @param env The environment containing the variable
 * @returns The name to use in generated code (either parameterAlias or the original name), sanitized for C
 */
function getVariableNameForCodegen(
  variableName: string,
  env: Environment | undefined
): string {
  if (!env) {
    return sanitizeForCIdentifier(variableName);
  }

  const variables = getVariablesFromEnv(env, variableName);
  if (variables.length > 0) {
    const variable = variables[variables.length - 1]!;
    if (variable.parameterAlias) {
      return sanitizeForCIdentifier(variable.parameterAlias);
    }
  }

  return sanitizeForCIdentifier(variableName);
}

/**
 * Result of allocating and initializing a closure capture struct.
 */
interface ClosureCaptureResult {
  /** The variable name holding the pointer to the allocated capture struct */
  captureTempVar: string;
  /** The C type name of the capture struct */
  captureCName: string;
}

function getDeferredDupTargetAtomName(dupExpr: Expr): string | undefined {
  if (!exprIsFunctionCall(dupExpr) || dupExpr.args.length < 1) {
    return;
  }
  const firstArg = dupExpr.args[0];
  if (!firstArg || !exprIsAtom(firstArg)) {
    return;
  }
  return firstArg.token.value;
}

/**
 * Allocate and initialize a closure capture struct.
 * For Impl closures: stack-allocate the capture struct (value type semantics)
 * For Dyn closures: heap-allocate the capture struct (reference type semantics)
 *
 * @param captureType The struct type containing captured variables
 * @param closureTypeId A unique ID for generating temp variable names
 * @param sourceExpr The expression containing deferredDupExpressions (for Gc handling)
 * @param indent The current indentation level
 * @param context The code generation context
 * @param useStackAllocation If true, allocate on stack (for Impl closures); if false, heap-allocate (for Dyn closures)
 * @returns The capture result with temp var name and type name, or null if allocation failed
 */
function allocateClosureCapture(
  captureType: StructType,
  closureTypeId: string,
  sourceExpr: Expr,
  indent: string,
  context: CodeGenContext,
  useStackAllocation: boolean = false
): ClosureCaptureResult | null {
  const captureTypeEntry = Object.values(context.types).find(
    (entry) => entry.type === captureType
  );

  if (!captureTypeEntry) {
    context.emitter.emitLine(
      `${indent}/* Error: Capture type not found for closure */`
    );
    return null;
  }

  const captureCName = captureTypeEntry.cName;
  // const functionContext = context as FunctionGenerationContext;

  // Build a lookup for deferred dup expressions attached to the closure construction.
  // These are commonly emitted for captured object values and must be applied
  // to the capture struct fields (not substituted as the closure value).
  const closureDeferredDupByName = new Map<string, Expr>();
  if (sourceExpr.$?.deferredDupExpressions) {
    for (const possibleDupExpr of sourceExpr.$.deferredDupExpressions) {
      const targetName = getDeferredDupTargetAtomName(possibleDupExpr);
      if (targetName) {
        closureDeferredDupByName.set(targetName, possibleDupExpr);
      }
    }
  }

  // Generate captured variable values
  const captureArgs = captureType.fields.map((field) => {
    // Find the dup expression for this captured variable.
    // Prefer per-field deferred dup expressions (attached to the captured expr itself),
    // then fall back to any deferred dup expressions attached to the closure construction.
    let dupExpr: Expr | undefined;

    const fieldExpr = field.exprs.expr;
    if (fieldExpr.$?.deferredDupExpressions?.length) {
      dupExpr = fieldExpr.$.deferredDupExpressions[0];
    }

    if (!dupExpr) {
      const candidates: string[] = [field.label];
      if (exprIsAtom(fieldExpr)) {
        candidates.push(fieldExpr.token.value);
      }
      for (const name of candidates) {
        const possible = closureDeferredDupByName.get(name);
        if (possible) {
          dupExpr = possible;
          break;
        }
      }
    }

    if (dupExpr) {
      return generateExpr(dupExpr, indent, context);
    }

    // Fallback: generate proper variable access using generateAtom
    const atomExpr: AtomExpr = {
      tag: ExprTag.Atom,
      token: field.exprs.expr.token,
      $: field.exprs.expr.$,
    };
    return generateAtom(atomExpr, context);
  });

  // Generate capture struct initialization
  const captureDataCode = `(${captureCName}){ ${captureArgs
    .map((arg, i) => {
      const field = captureType.fields[i];
      if (!field) {
        return `/* Error: missing field at index ${i} */`;
      }
      return `.${sanitizeForCIdentifier(field.label)} = ${arg}`;
    })
    .join(", ")} }`;

  // Generate a unique temporary variable name for the capture data
  // Use sourceExpr token location for uniqueness to avoid collisions
  const uniqueSuffix =
    sourceExpr.token.position.row !== undefined
      ? `${Date.now()}_${sourceExpr.token.position.row}`
      : `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const captureTempVar = `__capture_${closureTypeId}_${uniqueSuffix}`;

  if (useStackAllocation) {
    // Stack-allocate capture data (for Impl closures - value type semantics)
    context.emitter.emitLine(
      `${indent}${captureCName} ${captureTempVar} = ${captureDataCode};`
    );
  } else {
    // Heap-allocate capture data (for Dyn closures - reference type semantics)
    context.emitter.emitLine(
      `${indent}${captureCName}* ${captureTempVar} = (${captureCName}*)__yo_malloc(sizeof(${captureCName}));`
    );
    context.emitter.emitLine(
      `${indent}*${captureTempVar} = ${captureDataCode};`
    );
  }

  return { captureTempVar, captureCName };
}

/**
 * Generate C code for an expression - extracted from original codegen-c.ts
 */
export function generateExpr(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  let result: string;

  switch (expr.tag) {
    case ExprTag.FuncCall:
      result = generateFuncCall(expr, indent, context);
      break;
    case ExprTag.Atom:
      result = generateAtom(expr, context);
      break;
  }

  return result;
}

/**
 * Generate C code for a function call expression - extracted from original codegen-c.ts
 */
function generateFuncCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const emitter = context.emitter;

  // Handle macro function calls (functions with isUnquote return type)
  // If expr.$.macroExpansion is set, this macro call has already been expanded
  // during evaluation. Generate code for the expanded form instead.
  if (expr.$?.macroExpansion) {
    return generateExpr(expr.$.macroExpansion, indent, context);
  }

  // Handle anonymous function/closure construction
  // If expr.$.closureFunctionValue is set, this is a closure that needs to be constructed
  if (
    expr.$?.closureFunctionValue &&
    expr.$?.type &&
    typeImplementsFn(expr.$.type)
  ) {
    const fnModule = extractFnModuleFromType(expr.$.type)!;
    const closureType = fnModule.isFn.callType;
    const closureFunctionValue = expr.$.closureFunctionValue;
    const captureType = expr.$.captureType;

    const functionCName = (context as FunctionGenerationContext).functions[
      closureFunctionValue.funcId
    ]?.cName;

    if (!functionCName) {
      return `// Error: Closure implementation function not found in context`;
    }

    // Check if this is a Dyn(Fn(...)) or Impl(Fn(...))
    const isDynClosure = isDynType(expr.$.type);

    // For Dyn(Fn(...)), use the DynType's C name.
    // For Impl(Fn(...)), the runtime representation is the resolvedConcreteType (capture struct),
    // so we do NOT use the FnModuleType's C name here.
    let closureCName: string | undefined;
    if (isDynClosure) {
      const dynTypeEntry = context.types[expr.$.type.id];
      if (!dynTypeEntry) {
        return `// Error: Dyn closure type not found in context`;
      }
      closureCName = dynTypeEntry.cName;
    }

    // Check if this closure has captures
    const hasCaptures =
      captureType && isStructType(captureType) && captureType.fields.length > 0;

    // Generate call function cast (Dyn only)
    const returnTypeStr = getTypeString(closureType.return.type, context);
    const callParamList = closureType.parameters
      .map((param) => getTypeString(param.type, context))
      .join(", ");
    const castCallFunction = `(${returnTypeStr} (*)(void*${callParamList ? ", " + callParamList : ""}))${functionCName}`;

    if (hasCaptures && captureType && isStructType(captureType)) {
      // Closure with captures - use the helper function
      // For Impl closures: stack-allocate capture (value type semantics)
      // For Dyn closures: heap-allocate capture (reference type semantics)
      const useStackAllocation = !isDynClosure;
      const captureResult = allocateClosureCapture(
        captureType,
        closureType.id,
        expr,
        indent,
        context,
        useStackAllocation
      );

      if (!captureResult) {
        return `// Error: Failed to allocate closure capture`;
      }

      const { captureTempVar } = captureResult;

      if (isDynClosure) {
        const constructorName = `__yo_create_${closureCName}`;
        // For Dyn closures, the dispose function is the dyn's dispose function
        const disposeFunctionName = `__yo_dispose_${closureCName}`;
        return `${constructorName}(${captureTempVar}, ${disposeFunctionName}, ${castCallFunction})`;
      } else {
        // Impl(Fn(...)) is true static dispatch:
        // - The runtime value IS the capture struct value type.
        // - Calls dispatch directly to the generated closure function.
        // Record mapping for call-site generation.
        context.implClosureCallMap.set(captureType.id, {
          functionCName,
          callTypeId: fnModule.isFn.callType.id,
        });

        // Return the capture struct variable (value type).
        // The caller will store it in a local and drop it normally.
        return captureTempVar;
      }
    } else {
      // Closure without captures
      if (isDynClosure) {
        const constructorName = `__yo_create_${closureCName}`;
        // For Dyn closures without captures
        const disposeFunctionName = `__yo_dispose_${closureCName}`;
        return `${constructorName}(NULL, ${disposeFunctionName}, ${castCallFunction})`;
      } else {
        // Impl closures without captures: still static dispatch.
        // Use an empty capture struct as the concrete representation.
        // Record mapping using the resolved concrete type if available.
        if (expr.$.type && expr.$.type.tag === TypeTag.SomeType) {
          const someType = expr.$.type as SomeType;
          if (someType.resolvedConcreteType) {
            context.implClosureCallMap.set(someType.resolvedConcreteType.id, {
              functionCName,
              callTypeId: fnModule.isFn.callType.id,
            });

            // Represent as an empty literal for the concrete capture struct.
            const concreteCName = getTypeString(
              someType.resolvedConcreteType,
              context
            );
            return `(${concreteCName}){}`;
          }
        }

        return `// Error: Impl(Fn(...)) without captures missing resolvedConcreteType`;
      }
    }
  }

  // __yo_decr_rc - handle reference count decrement
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_decr_rc requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_decr_rc(${selfCode})`;
  }

  // __yo_incr_rc - handle reference count increment
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_incr_rc requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_incr_rc(${selfCode})`;
  }

  // __yo_rc_own - return the value itself, used for transferring ownership
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_rc_own)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_rc_own requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return selfCode; // Just return the argument as-is
  }

  // ___dup - generic dup hook used by evaluator for GC/reference-counted values.
  // In many cases the evaluator rewrites `___dup(x)` into `x.___dup()`, but in
  // some contexts (e.g. deferred dup for dyn-closure captures) the builtin call
  // is intentionally deferred to codegen.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.___dup)) {
    const valueArg = expr.args[0];
    if (!valueArg) {
      return `// Error: ___dup requires exactly 1 argument`;
    }

    const valueCode = generateExpr(valueArg, indent, context);
    const valueType = valueArg.$?.type ?? expr.$?.type;
    if (!valueType) {
      // Best-effort: preserve the expression.
      return valueCode;
    }

    // Dyn is a value type; duplication increments the RC of `.data` and returns the copied fat pointer.
    if (isDynType(valueType)) {
      const dynCName = getTypeString(valueType, context);
      return `((${dynCName}){ .data = __yo_incr_rc((void*)(${valueCode}).data), .vtable = (${valueCode}).vtable })`;
    }

    // Object types are reference counted; duplication increments RC and returns the same pointer.
    if (isObjectType(valueType)) {
      const objCName = getTypeString(valueType, context);
      return `((${objCName})__yo_incr_rc((void*)(${valueCode})))`;
    }

    // Iso types use atomic reference counting
    if (isIsoType(valueType)) {
      const isoCName = getTypeString(valueType, context);
      return `((${isoCName})__yo_incr_rc_atomic((void*)(${valueCode})))`;
    }

    // Value types: no-op dup.
    return valueCode;
  }

  // ___drop - generic drop hook used by evaluator for GC/reference-counted values.
  // Similar to ___dup, some drops are deferred to codegen.
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.___drop)) {
    const valueArg = expr.args[0];
    if (!valueArg) {
      return `// Error: ___drop requires exactly 1 argument`;
    }

    const valueCode = generateExpr(valueArg, indent, context);
    const valueType = valueArg.$?.type ?? expr.$?.type;
    if (!valueType) {
      return ``;
    }

    if (isDynType(valueType)) {
      return `__yo_decr_rc((void*)(${valueCode}).data)`;
    }
    if (isObjectType(valueType)) {
      return `__yo_decr_rc((void*)(${valueCode}))`;
    }
    // Iso types use atomic reference counting
    if (isIsoType(valueType)) {
      return `__yo_decr_rc_atomic((void*)(${valueCode}))`;
    }
    // For SomeType with resolvedConcreteType, dispatch to the concrete type's ___drop
    if (isSomeType(valueType) && valueType.resolvedConcreteType) {
      const concreteType = valueType.resolvedConcreteType;
      const dropFn = concreteType.module?.fields.find(
        (f) => f.label === BuiltinFunctions.___drop[0]
      );
      if (
        dropFn &&
        dropFn.assignedValue &&
        isFunctionValue(dropFn.assignedValue)
      ) {
        const dropFnCName =
          context.functions[dropFn.assignedValue.funcId]?.cName;
        if (dropFnCName) {
          return `${dropFnCName}(${valueCode})`;
        }
      }
    }

    // Value types: no-op drop.
    return ``;
  }

  // __yo_dyn_drop - call dispose on dyn object via dispose function then __yo_decr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_drop)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_dyn_drop requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    // Dyn is a value type; ref-counting applies to its .data pointer.
    return `__yo_decr_rc((void*)(${selfCode}).data)`;
  }

  // __yo_dyn_dup - call dup on wrapped object via vtable and __yo_incr_rc on dyn
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_dyn_dup)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_dyn_dup requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    // Dyn is a value type; ref-counting applies to its .data pointer.
    return `__yo_incr_rc((void*)(${selfCode}).data)`;
  }

  // __yo_incr_rc_atomic - atomic reference count increment for Iso types
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_incr_rc_atomic)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_incr_rc_atomic requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_incr_rc_atomic(${selfCode})`;
  }

  // __yo_decr_rc_atomic - atomic reference count decrement for Iso types
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc_atomic)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_decr_rc_atomic requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    return `__yo_decr_rc_atomic(${selfCode})`;
  }

  // __yo_iso_extract - extract inner value from Iso type
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_extract)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_iso_extract requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    const selfType = selfArg.$?.type;

    if (!selfType || !isIsoType(selfType)) {
      return `// Error: __yo_iso_extract requires an Iso type`;
    }

    const isoTypeCName = getTypeString(selfType, context);

    // Register the Option type C name for the extract function
    // The return type of __yo_iso_extract is Option(ChildType)
    const returnType = expr.$?.type;
    if (returnType && context.isoTypes?.has(isoTypeCName)) {
      const isoInfo = context.isoTypes.get(isoTypeCName)!;
      if (!isoInfo.optionTypeCName) {
        isoInfo.optionTypeCName = getTypeString(returnType, context);
      }
    }

    const extractCall = `__yo_iso_extract_${isoTypeCName}(${selfCode})`;

    // If this expression has a temp variable (for cleanup), emit declaration + assignment
    const tempVar = expr.$?.variableName;
    if (tempVar && returnType) {
      context.emitter.emitLine(
        `${indent}${getTypeString(returnType, context)} ${tempVar} = ${extractCall};`
      );
      return tempVar;
    }

    return extractCall;
  }

  // __yo_iso_dispose - dispose inner value of Iso if not extracted
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_iso_dispose)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_iso_dispose requires exactly 1 argument`;
    }
    const selfCode = generateExpr(selfArg, indent, context);
    const selfType = selfArg.$?.type;

    if (!selfType || !isIsoType(selfType)) {
      return `// Error: __yo_iso_dispose requires an Iso type`;
    }

    const isoTypeCName = getTypeString(selfType, context);
    return `__yo_iso_dispose_${isoTypeCName}(${selfCode})`;
  }

  // Iso(T)(value) - Iso value constructor
  // Check if this is a call to an Iso type constructor (not just any expression returning Iso type)
  // The function being called must be a TypeValue containing an IsoType
  const funcValue = expr.func.$?.value;
  if (
    isTypeValue(funcValue) &&
    isIsoType(funcValue.value) &&
    expr.args.length === 1
  ) {
    const isoType = funcValue.value;
    const childType = isoType.childType;

    const valueArg = expr.args[0]!;
    const valueCode = generateExpr(valueArg, indent, context);

    // Register the Iso type
    const isoTypeCName = getTypeString(isoType, context);
    const childTypeCName = getTypeString(childType, context);

    if (!context.isoTypes) {
      context.isoTypes = new Map();
    }
    if (!context.isoTypes.has(isoTypeCName)) {
      context.isoTypes.set(isoTypeCName, { childTypeCName, isoType });
    }

    // Generate allocation and initialization
    // Iso_T* iso = __yo_malloc(sizeof(Iso_T));
    // iso->arc = 1;
    // iso->extracted = false;
    // iso->value = value;
    // return iso;
    return `__yo_create_iso_${isoTypeCName}(${valueCode})`;
  }

  // __yo_sometype_drop - dispatch to resolvedConcreteType's ___drop if available
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_drop)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_sometype_drop requires exactly 1 argument`;
    }
    const argType = selfArg.$?.type;

    // Impl(Future(T)) is heap-backed and ref-counted: decrement refcount
    // The state machine will be freed when refcount hits 0
    if (argType && isSomeType(argType) && typeImplementsFuture(argType)) {
      const selfCode = generateExpr(selfArg, indent, context);
      return `if (${selfCode} != NULL) { __yo_decr_rc((void*)${selfCode}); }`;
    }

    if (argType && isSomeType(argType) && argType.resolvedConcreteType) {
      // Dispatch to concrete type's ___drop
      const concreteType = argType.resolvedConcreteType;
      const dropFn = concreteType.module?.fields.find(
        (f) => f.label === BuiltinFunctions.___drop[0]
      );
      if (
        dropFn &&
        dropFn.assignedValue &&
        isFunctionValue(dropFn.assignedValue)
      ) {
        const dropFnCName =
          context.functions[dropFn.assignedValue.funcId]?.cName;
        if (dropFnCName) {
          const selfCode = generateExpr(selfArg, indent, context);
          return `${dropFnCName}(${selfCode})`;
        }
      }
    }
    // No concrete type or no drop function - no-op
    return `/* __yo_sometype_drop: no-op */`;
  }

  // __yo_sometype_dup - dispatch to resolvedConcreteType's ___dup if available
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_sometype_dup)) {
    const selfArg = expr.args[0];
    if (!selfArg) {
      return `// Error: __yo_sometype_dup requires exactly 1 argument`;
    }
    const argType = selfArg.$?.type;

    // Impl(Future(T)) is heap-backed and ref-counted: increment refcount
    if (argType && isSomeType(argType) && typeImplementsFuture(argType)) {
      const selfCode = generateExpr(selfArg, indent, context);
      return `__yo_incr_rc((void*)${selfCode})`;
    }

    if (argType && isSomeType(argType) && argType.resolvedConcreteType) {
      // Dispatch to concrete type's ___dup
      const concreteType = argType.resolvedConcreteType;
      const dupFn = concreteType.module?.fields.find(
        (f) => f.label === BuiltinFunctions.___dup[0]
      );
      if (
        dupFn &&
        dupFn.assignedValue &&
        isFunctionValue(dupFn.assignedValue)
      ) {
        const dupFnCName = context.functions[dupFn.assignedValue.funcId]?.cName;
        if (dupFnCName) {
          const selfCode = generateExpr(selfArg, indent, context);
          return `${dupFnCName}(${selfCode})`;
        }
      }
    }
    // No concrete type or no dup function - no-op
    return `/* __yo_sometype_dup: no-op */`;
  }

  // __yo_gc_collect - trigger garbage collection
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_gc_collect)) {
    if (expr.args.length !== 0) {
      return `// Error: __yo_gc_collect requires exactly 0 arguments`;
    }
    return `__yo_gc_collect()`;
  }

  // rc - get the reference count of a value
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.rc)) {
    if (expr.args.length !== 1) {
      return `// Error: rc requires exactly 1 argument`;
    }
    const argExpr = expr.args[0]!;
    const argType = argExpr.$?.type;
    if (!argType) {
      return `// Error: rc argument missing type information`;
    }

    const argCode = generateExpr(argExpr, indent, context);

    // For GC types (reference-counted objects), return the actual ref_count
    if (isGcType(argType)) {
      return `((yo_ref_header_t*)(${argCode}))->ref_count`;
    } else {
      // For value types, always return 1
      return `1`;
    }
  }

  // panic - print error message and abort execution
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.panic)) {
    // panic() never returns, so we need to handle it specially
    // We need to generate the panic code and then provide a dummy value for the assignment
    const returnType = expr.$?.type;
    if (!returnType) {
      return `// Error: panic() missing type information`;
    }

    if (expr.args.length === 0) {
      // No message provided, just call abort()
      emitter.emitLine(`${indent}abort();`);
    } else if (expr.args.length === 1) {
      // Message provided, print to stderr then abort
      const messageArg = expr.args[0]!;

      // The message should be a compile-time string value
      if (messageArg.$?.value && isComptStringValue(messageArg.$.value)) {
        const message = messageArg.$.value.value;
        emitter.emitLine(
          `${indent}fprintf(stderr, "%s\\n", ${JSON.stringify(message)});`
        );
        emitter.emitLine(`${indent}abort();`);
      } else {
        // Runtime message - generate code to evaluate it
        const messageCode = generateExpr(messageArg, indent, context);
        emitter.emitLine(`${indent}fprintf(stderr, "%s\\n", ${messageCode});`);
        emitter.emitLine(`${indent}abort();`);
      }
    } else {
      return `// Error: panic accepts 0 or 1 arguments, got ${expr.args.length}`;
    }

    // Since panic never returns, we need to provide a dummy value of the correct type
    // This code is unreachable but needed for C compilation
    const returnTypeStr = getTypeString(returnType, context);
    return `(*((${returnTypeStr}*)NULL))`; // This will never execute but has the right type
  }

  // test - test declaration, skipped during normal compilation
  // Tests are handled by the test runner which generates a main function for each test
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.test)) {
    // No-op: test declarations produce no C code
    return `/* test declaration skipped */`;
  }

  // __yo_thread_set_maximum_threads - set maxmium number of threads for coroutine schedular
  if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_thread_set_maximum_threads)
  ) {
    const numArg = expr.args[0];
    if (!numArg) {
      return `// Error: __yo_thread_set_maximum_threads requires exactly 1 argument`;
    }
    const numCode = generateExpr(numArg, indent, context);
    return `__yo_thread_set_maximum_threads(${numCode})`;
  }

  // op_and - && operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_and)) {
    if (expr.args.length === 0) {
      return `true`; // Empty && returns true
    }
    if (expr.args.length === 1) {
      return generateExpr(expr.args[0]!, indent, context);
    }
    // Generate: (arg1 && arg2 && ... && argN)
    const argCodes = expr.args.map((arg) => generateExpr(arg, indent, context));
    return `(${argCodes.join(" && ")})`;
  }

  // op_or - || operator with short-circuit evaluation
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.op_or)) {
    if (expr.args.length === 0) {
      return `false`; // Empty || returns false
    }
    if (expr.args.length === 1) {
      return generateExpr(expr.args[0]!, indent, context);
    }
    // Generate: (arg1 || arg2 || ... || argN)
    const argCodes = expr.args.map((arg) => generateExpr(arg, indent, context));
    return `(${argCodes.join(" || ")})`;
  }

  // async - async block that creates a Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
    return generateAsyncBlock(expr, indent, context);
  }

  // dyn() - dynamic dispatch constructor
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.dyn)) {
    return generateDynCall(expr, indent, context);
  }

  // await - extract value from Future
  if (exprIsFunctionCallOf(expr, BuiltinFunctions.await)) {
    const futureArg = expr.args[0];
    if (!futureArg) {
      return `// Error: await requires exactly 1 argument`;
    }

    // const futureCode = generateExpr(futureArg, indent, context);
    const futureType = futureArg.$?.type;

    // Check if the type implements Future (handles both FutureModuleType and SomeType with Future impl)
    if (!futureType || !typeImplementsFuture(futureType)) {
      return `// Error: await argument must be a Future type`;
    }

    // Extract the Future module type to get the result type
    const futureModuleType = extractFutureModuleFromType(futureType);
    if (!futureModuleType) {
      return `// Error: could not extract Future module from type`;
    }

    // In async context (state machine), await expressions don't generate code
    // The result is extracted at the start of the next state
    // If this await expression is assigned to a variable, that variable's name is in expr.$.variableName
    const functionContext = context as FunctionGenerationContext;
    if (functionContext.inStateMachine) {
      // Return empty string - the actual await logic is handled by state machine generator
      // The result will be available in the target variable in the next state
      return ``;
    }

    // Outside async context - this is an error
    return `// Error: await should only be used inside async blocks`;
  }

  // return
  if (exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
    const arg = expr.args[0];
    if (arg) {
      if (!expr.$) {
        throw new Error(`Internal error: return expression missing metadata`);
      }
      // For non-unit types, we need a temporary variable to hold the return value
      // before deferred drop expressions run
      if (!expr.$.variableName && !isUnitType(expr.$.type)) {
        return `// Error: return expression missing temporary variable name`;
      }

      // Special handling for async functions: we need to get the raw value code
      // without temp variable indirection to properly declare the temp variable
      const functionContext = context as FunctionGenerationContext;
      let argCode: string;
      let needsTempVarDeclaration = false;

      if (functionContext.inStateMachine && arg.$?.variableName) {
        // In async context: generate raw value code by temporarily clearing variableName
        const savedVariableName = arg.$.variableName;
        arg.$.variableName = undefined;
        argCode = generateExpr(arg, indent, context);
        arg.$.variableName = savedVariableName;
        needsTempVarDeclaration = true;
      } else {
        // Check if arg has both a variableName and deferredDupExpressions
        // This happens when we need to store the arg value in a temp var before duping it
        if (
          arg.$?.variableName &&
          arg.$?.deferredDupExpressions &&
          arg.$.deferredDupExpressions.length > 0
        ) {
          // Generate the arg value without the variableName to get the raw expression
          const savedVariableName = arg.$.variableName;
          arg.$.variableName = undefined;
          const rawArgCode = generateExpr(arg, indent, context);
          arg.$.variableName = savedVariableName;

          // Declare and assign the temp variable
          const argType = getTypeString(arg.$.type!, context);
          const argTempVar = sanitizeForCIdentifier(savedVariableName);
          if (argTempVar !== rawArgCode) {
            context.emitter.emitLine(
              `${indent}${argType} ${argTempVar} = ${rawArgCode};`
            );
          }
          argCode = argTempVar;
        } else {
          argCode = generateExpr(arg, indent, context);
        }
      }

      // Handle deferred dup expressions for the return argument.
      // This is needed when returning a borrowed parameter - we must call dup
      // to increment the reference count since return values are owned.
      let handledDeferredDup = false;
      if (
        arg.$?.deferredDupExpressions &&
        arg.$.deferredDupExpressions.length > 0
      ) {
        generateDeferredDupExpressions(arg, indent, functionContext);
        const dupExpr = arg.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          argCode = sanitizeForCIdentifier(dupExpr.$.variableName);
          handledDeferredDup = true;
        }
      }

      const returnType = getTypeString(expr.$.type!, context);

      // The evaluator provides a temp variable name for return expressions so we can
      // compute the value before running deferred drops.
      const returnTempVar = expr.$.variableName
        ? sanitizeForCIdentifier(expr.$.variableName)
        : undefined;

      // Skip re-declaring if we already generated a dup call with a temp variable
      // Also skip if the variable name is the same as the arg code (e.g., returning a local variable)
      if (
        !handledDeferredDup &&
        !isUnitType(expr.$.type) &&
        returnTempVar &&
        returnTempVar !== argCode // Prevent something like: int32_t counter = counter;
      ) {
        context.emitter.emitLine(
          `${indent}${returnType} ${returnTempVar} = ${argCode};`
        );
      }

      if (expr.$.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      // Check if we're in a state machine - if so, complete the Future instead of returning
      if (functionContext.inStateMachine) {
        // State machine return - complete the Future and clean up
        const futureType = functionContext.inStateMachine.futureType;
        const futureModuleType = extractFutureModuleFromType(futureType)!;
        const childType = futureModuleType.isFuture.outputType;
        const isUnitResult = isUnitType(childType);

        context.emitter.emitLine(
          `${indent}// Final state - complete the result Future`
        );
        context.emitter.emitLine(
          `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Completing async function\\n");`
        );

        // Store the result if not unit
        if (!isUnitResult) {
          // Use argCode directly if we didn't need a temp variable, otherwise use the temp variable
          const resultValue =
            expr.$.variableName && needsTempVarDeclaration
              ? expr.$.variableName
              : expr.$.variableName || argCode;
          context.emitter.emitLine(
            `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Setting result = %d\\n", (int)${resultValue});`
          );
          context.emitter.emitLine(`${indent}sm->result = ${resultValue};`);
        }

        // Set state to COMPLETED with release semantics
        // This ensures the result write above is visible to other threads
        context.emitter.emitLine(
          `${indent}ASYNC_DEBUG("${context.currentFunctionName}: Setting state to COMPLETED\\n");`
        );
        context.emitter.emitLine(
          `${indent}atomic_store_explicit(&sm->state, -1, memory_order_release);  // -1 = completed`
        );

        // Check if there's a continuation waiting (with acquire semantics to see the continuation registration)
        context.emitter.emitLine(``);
        context.emitter.emitLine(
          `${indent}// Check if there's a continuation waiting for this Future to complete`
        );
        context.emitter.emitLine(
          `${indent}void (*continuation_fn)(void*) = atomic_load_explicit(&sm->continuation_fn, memory_order_acquire);`
        );
        context.emitter.emitLine(
          `${indent}void* continuation_sm = atomic_load_explicit(&sm->continuation_sm, memory_order_acquire);`
        );
        context.emitter.emitLine(`${indent}if (continuation_fn != NULL) {`);
        context.emitter.emitLine(
          `${indent}  ASYNC_DEBUG("${context.currentFunctionName}: Spawning continuation: resume_fn=%p, sm=%p\\n", (void*)continuation_fn, continuation_sm);`
        );
        context.emitter.emitLine(
          `${indent}  yo_async_spawn_task(continuation_fn, continuation_sm);`
        );
        context.emitter.emitLine(`${indent}}`);

        context.emitter.emitLine(
          `${indent}sm->state = ${Number.MAX_SAFE_INTEGER};  // Terminal state`
        );
        context.emitter.emitLine(``);
        context.emitter.emitLine(
          `${indent}// Release the "running task" reference now that task is complete`
        );
        context.emitter.emitLine(
          `${indent}// This balances the __yo_incr_rc in the constructor`
        );
        context.emitter.emitLine(`${indent}__yo_decr_rc((void*)sm);`);
        context.emitter.emitLine(``);
        // Return from the void resume function
        context.emitter.emitLine(`${indent}return;`);
        // Return empty string so no additional code is generated
        return ``;
      }

      // Normal (non-state-machine) return
      if (isUnitType(expr.$.type)) {
        return `return`;
      }

      // If we handled deferred dup, use argCode (which is the dup result temp variable)
      // Otherwise use expr.$.variableName as before
      const returnValue = handledDeferredDup
        ? argCode
        : (returnTempVar ?? argCode);
      return `return ${returnValue}`;
    } else {
      if (expr.$?.deferredDropExpressions) {
        generateDeferredDropExpressions(expr, indent, context);
      }

      return "return";
    }
  }

  // TODO: Remove this and move the logic to prelude.yo
  // Array.fill method call (macro-like expansion)
  if (isArrayFillMethodCall(expr)) {
    return generateArrayFillCall(expr, indent, context);
  }

  // compile-time variable
  if (exprIsFunctionCallOf(expr, "::", 2)) {
    return "";
  }

  // bindings
  if (exprIsFunctionCallOf(expr, ":", 2)) {
    const lhs = expr.args[0]!;
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
    ) {
      // compile-time variable
      return "";
    }

    if (!lhs.$?.type) {
      return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
    }
    const varName = lhs.token.value;
    const varTypeAndName = getVariableTypeString(lhs.$.type, varName, context);

    context.emitter.emitLine(
      // NOTE: We cannot assign "const" here.
      `${indent}${varTypeAndName};`
    );
    return "";
  }
  // Initialization assignment
  else if (exprIsFunctionCallOf(expr, ":=", 2)) {
    const lhs = expr.args[0]!;
    const rhs = expr.args[1]!;

    // Debug: Log all := assignments in state machines
    const functionContext = context as FunctionGenerationContext;

    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt, 1)
    ) {
      // compile-time variable
      return "";
    }

    // In state machine context, skip variable "load" expressions (localVar := stateMachineVar)
    // These are generated by the type checker to create local copies of variables
    // But in state machines, we access variables directly through sm->var_xxx
    if (functionContext.inStateMachine && exprIsAtom(lhs) && exprIsAtom(rhs)) {
      const lhsName = lhs.token.value;
      const rhsName = rhs.token.value;

      // Check if both refer to the same state machine variable
      // This handles cases like: b := b (creating a local copy)
      const lhsIsStateMachineVar =
        functionContext.stateMachineVariables &&
        Array.from(functionContext.stateMachineVariables.values()).some(
          (v) => v.name === lhsName
        );
      const rhsIsStateMachineVar =
        functionContext.stateMachineVariables &&
        Array.from(functionContext.stateMachineVariables.values()).some(
          (v) => v.name === rhsName
        );

      // Skip if both sides reference state machine variables with the same name
      // OR if we're trying to create a local copy of a state machine variable
      if (
        lhsName === rhsName &&
        (lhsIsStateMachineVar || rhsIsStateMachineVar)
      ) {
        // Self-assignment of state machine variable - skip to avoid redundant local copy

        return "";
      }
    }

    // Check if it's destructurings
    if (expr.$?.runtimeDestructurings) {
      const runtimeDestructurings = expr.$.runtimeDestructurings;
      const rhsCode = generateExpr(rhs, indent, context);
      const rhsType = rhs.$?.type;
      runtimeDestructurings.forEach(({ label, type, variableName }) => {
        // Sanitize the variable name for C
        const sanitizedVariableName = sanitizeForCIdentifier(variableName);
        const varTypeAndName = getVariableTypeString(
          type,
          sanitizedVariableName,
          context
        );

        // Handle newtype destructuring - just use the value itself
        if (
          rhsType &&
          isStructType(rhsType) &&
          rhsType.isNewtype &&
          rhsType.fields.length === 1
        ) {
          const singleField = rhsType.fields[0];
          if (singleField && singleField.label === label) {
            // For newtype, destructuring the single field just returns the value itself
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode}; // Destructuring ${label} (newtype)`
            );
            return;
          }
        }

        let fieldName = label.match(/^\d+$/)
          ? `_${label}`
          : sanitizeForCIdentifier(label);

        if (rhsType && isTupleType(rhsType) && !label.match(/^\d+$/)) {
          const index = rhsType.fields.findIndex((el) => el.label === label);
          fieldName = index >= 0 ? `_${index}` : fieldName;
        }

        // Use -> for ref types (which are pointers), . for regular types
        const memberAccessOp = rhsType && isObjectType(rhsType) ? "->" : ".";

        context.emitter.emitLine(
          `${indent}${varTypeAndName} = ${rhsCode}${memberAccessOp}${fieldName}; // Destructuring ${label}`
        );
      });
      return "";
    }

    if (exprIsAtom(lhs)) {
      const varName = lhs.token.value;
      if (!lhs.$?.type) {
        return `// Error: No type information for variable ${varName}\n`;
      }

      // Check if we're in a state machine context and this is a captured variable
      const functionContext = context as FunctionGenerationContext;

      // To check if a variable is in the state machine, we need to:
      // 1. Look up the variable in the environment to get its ID
      // 2. Check if that ID is a key in stateMachineVariables map
      let isStateMachineVar = false;
      let varId: string | undefined;

      if (
        functionContext.inStateMachine &&
        functionContext.stateMachineVariables &&
        lhs.$?.env
      ) {
        // Get the variable from the environment
        const variables = getVariablesFromEnv(lhs.$.env, varName);
        if (variables.length > 0) {
          const variable = variables[variables.length - 1]!;
          // Check if this variable (or its owner if it's borrowing) is in state machine
          const idToCheck = variable.isOwningTheSameGcValueAs
            ? variable.isOwningTheSameGcValueAs.id
            : variable.id;

          if (functionContext.stateMachineVariables.has(idToCheck)) {
            isStateMachineVar = true;
            varId = idToCheck;
          }
        }
      }

      // Handle array initialization specially
      if (isArrayType(lhs.$.type)) {
        // Check if RHS is an array literal
        if (
          exprIsFunctionCall(rhs) &&
          exprIsFunctionCallOf(rhs, BuiltinKeywords.array)
        ) {
          // Direct initialization with array literal
          const rhsCode = generateExpr(rhs, indent, context);

          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            const varTypeAndName = getVariableTypeString(
              lhs.$.type,
              varName,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode};`
            );
          }
        } else {
          // Copying from another array - use direct struct assignment
          // Handle temp variable assignment for Gc values
          let rhsCode: string;
          if (rhs.$?.variableName) {
            const tempVarName = sanitizeForCIdentifier(rhs.$.variableName);
            const rhsExprCode = generateExpr(rhs, indent, context);

            // Generate temp variable assignment first (only if not in state machine)
            if (!isStateMachineVar) {
              const tempVarType = getVariableTypeString(
                rhs.$.type!,
                tempVarName,
                context
              );
              if (tempVarName !== rhsExprCode) {
                context.emitter.emitLine(
                  `${indent}${tempVarType} = ${rhsExprCode};`
                );
              }
            }

            // Use temp variable for the main assignment
            rhsCode = tempVarName;
          } else {
            rhsCode = generateExpr(rhs, indent, context);
          }

          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            const varTypeAndName = getVariableTypeString(
              lhs.$.type,
              varName,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode};`
            );
          }
        }
      } else {
        // Non-array initialization - use existing logic
        let rhsCode: string;

        const rhsIsClosureConstruction =
          exprIsFunctionCall(rhs) &&
          rhs.$?.closureFunctionValue &&
          rhs.$?.type &&
          typeImplementsFn(rhs.$.type);

        // If RHS has a temp variable name (e.g., for Gc values), we need to:
        // 1. First generate the RHS expression and assign it to the temp variable
        // 2. Then use the temp variable for the assignment
        // BUT: don't create temp variables for captured variables
        // ALSO: don't create temp variables if the temp var name is the same as the variable itself
        if (rhs.$?.variableName) {
          const tempVarName = sanitizeForCIdentifier(rhs.$.variableName);
          const sanitizedVarName = sanitizeForCIdentifier(varName);

          // Skip temp variable creation if temp var name matches the actual variable name
          // This prevents redundant declarations like "int32_t x = x;"
          if (tempVarName === sanitizedVarName) {
            // Just use the variable directly, no temp variable needed
            rhsCode = generateExpr(rhs, indent, context);

            // Handle deferred dup expressions even for simple variable references
            if (
              !rhsIsClosureConstruction &&
              rhs.$?.deferredDupExpressions &&
              rhs.$.deferredDupExpressions.length > 0
            ) {
              generateDeferredDupExpressions(rhs, indent, functionContext);
              const dupExpr = rhs.$.deferredDupExpressions[0]!;
              if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                rhsCode = sanitizeForCIdentifier(dupExpr.$.variableName);
              }
            }
          } else if (
            exprIsAtom(rhs) &&
            tempVarName === sanitizeForCIdentifier(rhs.token.value)
          ) {
            // Just use the variable directly, no temp variable needed
            rhsCode = generateExpr(rhs, indent, context);

            // Handle deferred dup expressions even for simple variable references
            if (
              !rhsIsClosureConstruction &&
              rhs.$?.deferredDupExpressions &&
              rhs.$.deferredDupExpressions.length > 0
            ) {
              generateDeferredDupExpressions(rhs, indent, functionContext);
              const dupExpr = rhs.$.deferredDupExpressions[0]!;
              if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                rhsCode = sanitizeForCIdentifier(dupExpr.$.variableName);
              }
            }
          } else {
            // Check if this temp variable is for a captured variable - if so, skip temp variable creation
            const functionContext = context as FunctionGenerationContext;
            if (
              exprIsAtom(rhs) &&
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                rhs.token.value
              ) &&
              rhs.$?.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                rhs.token.value,
                rhs.$.env,
                functionContext.currentClosureCaptureFrameLevel
              )
            ) {
              // This is a captured variable, don't create a temp variable for it
              // Generate closure access directly
              const currentClosureType = functionContext.currentClosureType;
              if (currentClosureType && currentClosureType.isClosure) {
                const closureTypeEntry = Object.values(
                  functionContext.types
                ).find((entry) => entry.type === currentClosureType);
                if (closureTypeEntry) {
                  // Note: captureType is no longer on ClosureType, so we use a naming convention
                  // The capture struct name follows the pattern: closure_type_name + "_capture"
                  const captureStructName = `${closureTypeEntry.cName}_capture`;
                  rhsCode = `((${captureStructName}*)closure_context->data)->${sanitizeForCIdentifier(rhs.token.value)}`;
                } else {
                  rhsCode = `closure_context->${sanitizeForCIdentifier(rhs.token.value)}`;
                }
              } else {
                rhsCode = `closure_context->${sanitizeForCIdentifier(rhs.token.value)}`;
              }
            } else {
              // Normal temp variable handling
              const rhsExprCode = generateExpr(rhs, indent, context);

              // Check if the RHS expression already generates the same temp variable
              // If so, don't generate a redundant assignment
              if (rhsExprCode.trim() !== tempVarName) {
                // Generate temp variable assignment first
                const tempVarType = getVariableTypeString(
                  rhs.$.type!,
                  tempVarName,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${tempVarType} = ${rhsExprCode};`
                );
              }

              // Handle deferred dup expressions for RHS
              // After generating the RHS temp variable, check if we need to dup it
              if (
                !rhsIsClosureConstruction &&
                rhs.$?.deferredDupExpressions &&
                rhs.$.deferredDupExpressions.length > 0
              ) {
                generateDeferredDupExpressions(rhs, indent, functionContext);
                // Use the dup result variable instead of the original temp variable
                const dupExpr = rhs.$.deferredDupExpressions[0]!;
                if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                  rhsCode = sanitizeForCIdentifier(dupExpr.$.variableName);
                } else {
                  // Use temp variable for the main assignment
                  rhsCode = tempVarName;
                }
              } else {
                // Use temp variable for the main assignment
                rhsCode = tempVarName;
              }
            }
          }
        } else {
          rhsCode = generateExpr(rhs, indent, context);

          // Handle deferred dup expressions for RHS without temp variable
          if (
            !rhsIsClosureConstruction &&
            rhs.$?.deferredDupExpressions &&
            rhs.$.deferredDupExpressions.length > 0
          ) {
            const functionContext = context as FunctionGenerationContext;
            generateDeferredDupExpressions(rhs, indent, functionContext);
            // Use the dup result variable
            const dupExpr = rhs.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              rhsCode = sanitizeForCIdentifier(dupExpr.$.variableName);
            }
          }
        }

        // Special handling for slice initialization.
        if (isSliceType(lhs.$.type)) {
          const sliceType = lhs.$.type; // Get the slice type directly

          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            const varTypeAndName = getVariableTypeString(
              sliceType,
              varName,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode};`
            );
          }
        } else {
          // Normal initialization
          if (isStateMachineVar && varId) {
            // In state machine - assign to sm->var_xxx field
            context.emitter.emitLine(`${indent}sm->var_${varId} = ${rhsCode};`);
          } else {
            const varTypeAndName = getVariableTypeString(
              lhs.$.type,
              varName,
              context
            );
            context.emitter.emitLine(
              `${indent}${varTypeAndName} = ${rhsCode};`
            );
          }
        }
      }
      return "";
    }
  }
  // Assignent with mutability or initialization
  else if (exprIsFunctionCallOf(expr, "=", 2)) {
    let lhs = expr.args[0]!;
    const rhs = expr.args[1]!;

    let isInitialization = false;
    if (exprIsFunctionCall(lhs) && exprIsFunctionCallOf(lhs, ":", 2)) {
      isInitialization = true;
      lhs = lhs.args[0]!; // Get the actual variable being assigned
    }
    if (
      exprIsFunctionCall(lhs) &&
      exprIsFunctionCallOf(lhs, BuiltinKeywords.compt)
    ) {
      // compile-time variable
      return "";
    }

    if (!lhs.$?.type) {
      return `// Error: No type information for left-hand side ${exprToString(lhs)}\n`;
    }
    const lhsCode = generateExpr(lhs, indent, context);

    // Check if we need to save the old value into temp variable
    if (expr.$?.variableName) {
      const tempVarName = expr.$.variableName;

      // Skip temp variable declaration in state machines if lhsCode already accesses sm->var_xxx
      const functionContext = context as FunctionGenerationContext;
      const skipTempVar =
        functionContext.inStateMachine && lhsCode.startsWith("sm->");

      if (!skipTempVar) {
        const tempVarNameAndType = getVariableTypeString(
          lhs.$.type,
          tempVarName,
          context
        );

        // Handle array assignment specially
        if (isArrayType(lhs.$.type)) {
          // For array, use direct struct assignment
          context.emitter.emitLine(
            `${indent}${tempVarNameAndType} = ${lhsCode}; // Save old value for later use`
          );
        } else {
          if (!isUnitType(lhs.$.type)) {
            context.emitter.emitLine(
              `${indent}${tempVarNameAndType} = ${lhsCode}; // Save old value for later use`
            );
          }
        }
      }
    }

    // Handle array assignments specially
    if (isArrayType(lhs.$.type)) {
      // Since we use struct wrappers consistently, we can use direct struct assignment
      const rhsCode = generateExpr(rhs, indent, context);

      // Check if RHS is a closure construction
      const rhsIsClosureConstruction =
        exprIsFunctionCall(rhs) &&
        rhs.$?.closureFunctionValue &&
        rhs.$?.type &&
        typeImplementsFn(rhs.$.type);

      // Handle deferred dup expressions for RHS
      const functionContext = context as FunctionGenerationContext;
      let finalRhsCode = rhsCode;
      if (
        !rhsIsClosureConstruction &&
        rhs.$?.deferredDupExpressions &&
        rhs.$.deferredDupExpressions.length > 0
      ) {
        // If RHS has a variable name, we need to declare it first
        if (rhs.$?.variableName && rhs.$?.type) {
          const rhsVarName = sanitizeForCIdentifier(rhs.$.variableName);
          // Only emit the variable declaration if it's not the same as rhsCode
          if (rhsVarName !== rhsCode.trim()) {
            const rhsTypeStr = getTypeString(rhs.$.type, context);
            context.emitter.emitLine(
              `${indent}${rhsTypeStr} ${rhsVarName} = ${rhsCode};`
            );
          }
        }

        generateDeferredDupExpressions(rhs, indent, functionContext);
        // Use the dup result variable instead of the original
        const dupExpr = rhs.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          finalRhsCode = sanitizeForCIdentifier(dupExpr.$.variableName);
        }
      }

      if (isInitialization) {
        // For initialization
        const varTypeAndName = getVariableTypeString(
          lhs.$.type,
          generateExpr(lhs, indent, context),
          context
        );
        context.emitter.emitLine(
          `${indent}${varTypeAndName} = ${finalRhsCode};`
        );
      } else {
        // For assignment to existing array variable, use direct struct assignment
        context.emitter.emitLine(`${indent}${lhsCode} = ${finalRhsCode};`);
      }
    } else {
      // Non-array assignment - use existing logic
      const rhsCode = generateExpr(rhs, indent, context);

      // Check if RHS is a closure construction
      const rhsIsClosureConstruction =
        exprIsFunctionCall(rhs) &&
        rhs.$?.closureFunctionValue &&
        rhs.$?.type &&
        typeImplementsFn(rhs.$.type);

      // Handle deferred dup expressions for RHS
      const functionContext = context as FunctionGenerationContext;
      let finalRhsCode = rhsCode;
      if (
        !rhsIsClosureConstruction &&
        rhs.$?.deferredDupExpressions &&
        rhs.$.deferredDupExpressions.length > 0
      ) {
        // If RHS has a variable name, we need to declare it first
        if (rhs.$?.variableName && rhs.$?.type) {
          const rhsVarName = sanitizeForCIdentifier(rhs.$.variableName);
          // Only emit the variable declaration if it's not the same as rhsCode
          if (rhsVarName !== rhsCode.trim()) {
            const rhsTypeStr = getTypeString(rhs.$.type, context);
            context.emitter.emitLine(
              `${indent}${rhsTypeStr} ${rhsVarName} = ${rhsCode};`
            );
          }
        }

        generateDeferredDupExpressions(rhs, indent, functionContext);
        // Use the dup result variable instead of the original
        const dupExpr = rhs.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          finalRhsCode = sanitizeForCIdentifier(dupExpr.$.variableName);
        }
      }

      // Check if we need to cast closure types
      // const lhsType = lhs.$.type;
      // const rhsType = rhs.$?.type;
      // if (
      //   lhsType &&
      //   rhsType &&
      //   isClosureType(lhsType) &&
      //   isClosureType(rhsType)
      // ) {
      //   // Note: All closure types are now the same (no base vs specific distinction)
      //   // since captureType is no longer part of ClosureType
      //   // No cast needed
      // }

      if (!isUnitType(lhs.$.type)) {
        context.emitter.emitLine(
          `${indent}${isInitialization ? getTypeString(lhs.$.type, context) + " " : ""}${lhsCode} = ${finalRhsCode};`
        );
      }
    }

    return expr.$?.variableName ?? "";
  }
  // already computed and it's not unit value
  else if (
    expr.$?.value &&
    !isUnknownValue(expr.$?.value) &&
    !isUnitType(expr.$.type)
  ) {
    const value: Value = expr.$.value;
    return generateComptValue(value, context, expr);
  }
  // . field access
  else if (exprIsFunctionCallOf(expr, ".", 2)) {
    return generateFieldAccess(expr, indent, context);
  }
  // begin
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.begin)) {
    const tempVariableName = expr.$?.variableName;
    const valueType = expr.$?.type;

    if (tempVariableName && valueType) {
      // Expression form: begin block that returns a value
      if (!isUnitType(valueType) && !expr.$?.controlFlow) {
        context.emitter.emitLine(
          `${indent}${getTypeString(valueType, context)} ${tempVariableName};`
        );
      }

      // Evaluate each argument
      context.emitter.emitLine(`${indent}{ // begin block`);

      // Generate and emit code for each arg IMMEDIATELY to preserve order
      // This is important because generateExpr may have side effects that emit code
      const argsCode: string[] = [];
      const isReturningValue = !isUnitType(valueType) && !expr.$?.controlFlow;

      for (let idx = 0; idx < expr.args.length; idx++) {
        const arg = expr.args[idx]!;
        const result = generateExpr(arg, indent + "  ", context);
        argsCode.push(result);

        // Emit immediately to preserve order (generateExpr might emit temp vars as side effects)
        // But skip emitting the last expression if it's being used as the return value
        const isLastExpr = idx === expr.args.length - 1;
        if (result && !(isLastExpr && isReturningValue)) {
          if (arg.$ && isTempVariableName(arg.$.env.modulePath, result)) {
            // Skip
          } else {
            context.emitter.emitLine(`${indent}  ${result};`);
          }
        }
      }
      if (isReturningValue) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${argsCode[argsCode.length - 1]};`
        );
      }

      // Generate deferred drop expressions before closing the block
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          const dropCode = generateExpr(dropExpr, indent + "  ", context);
          if (dropCode) {
            context.emitter.emitLine(`${indent}  ${dropCode};`);
          }
        }
      }

      context.emitter.emitLine(`${indent}} // end begin block`);

      return isUnitType(valueType) || expr.$?.controlFlow
        ? ""
        : tempVariableName;
    } else {
      // Statement form: begin block without returning a value
      context.emitter.emitLine(`${indent}{ // begin block`);
      const argsCode = expr.args.map((arg) =>
        generateExpr(arg, indent + "  ", context)
      );
      argsCode.forEach((argCode) => {
        if (argCode) {
          context.emitter.emitLine(`${indent}  ${argCode};`);
        }
      });

      // Generate deferred drop expressions before closing the block
      if (expr.$?.deferredDropExpressions) {
        for (const dropExpr of expr.$.deferredDropExpressions) {
          const dropCode = generateExpr(dropExpr, indent + "  ", context);
          if (dropCode) {
            context.emitter.emitLine(`${indent}  ${dropCode};`);
          }
        }
      }

      context.emitter.emitLine(`${indent}} // end begin block`);
      return "";
    }
  }
  // cond
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.cond)) {
    return generateCondExpression(expr, indent, context);
  }
  // match
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.match)) {
    return generateMatchExpression(expr, indent, context);
  }
  // ptr value
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_address_of, 1)) {
    const type = expr.$?.type;
    if (!type) {
      return `// Error: No type information for pointer/reference expression ${exprToString(expr)}\n`;
    }
    const arg = expr.args[0]!;

    // Special case: *(arr(0:3)) or *(arr(:)) should create slice values directly
    if (exprIsFunctionCall(arg)) {
      const funcType = arg.func.$?.type;
      if (funcType && isArrayType(funcType)) {
        const firstArg = arg.args[0];
        if (
          firstArg &&
          exprIsFunctionCall(firstArg) &&
          exprIsFunctionCallOf(firstArg, ":")
        ) {
          // *(arr(start:end)) -> create slice value directly
          const arrayCode = generateExpr(arg.func!, indent, context);
          const startCode = generateExpr(firstArg.args[0]!, indent, context);
          const endCode = generateExpr(firstArg.args[1]!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((funcType as ArrayType).childType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              childType: getTypeString(
                (funcType as ArrayType).childType,
                context
              ),
            });
          }
          return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
        } else if (
          firstArg &&
          exprIsAtom(firstArg) &&
          firstArg.token.value === ":"
        ) {
          // *(arr(:)) -> create slice value for whole array
          const arrayCode = generateExpr(arg.func!, indent, context);
          const arrayType = funcType as ArrayType;
          const childType = arrayType.childType;

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(childType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              childType: getTypeString(childType, context),
            });
          }

          if (isNumberValue(arrayType.length)) {
            return `(${sliceTypeName}){ .data = &${arrayCode}.data[0], .length = ${arrayType.length.value} }`;
          } else {
            return `/* Error: Cannot slice array with non-compile-time length */`;
          }
        }
      } else if (
        funcType &&
        (isSliceType(funcType) ||
          (isPtrType(funcType) && isSliceType(funcType.childType)))
      ) {
        // Handle slice-from-slice: *(slice(start:end))
        const sliceBaseType = isSliceType(funcType)
          ? (funcType as SliceType)
          : (funcType.childType as SliceType);
        const firstArg = arg.args[0];
        if (
          firstArg &&
          exprIsFunctionCall(firstArg) &&
          exprIsFunctionCallOf(firstArg, ":")
        ) {
          // *(slice(start:end)) -> create sub-slice
          const sliceCode = generateExpr(arg.func!, indent, context);
          const startCode = generateExpr(firstArg.args[0]!, indent, context);
          const endCode = generateExpr(firstArg.args[1]!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.childType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              childType: getTypeString(sliceBaseType.childType, context),
            });
          }
          return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = ${endCode} - ${startCode} }`;
        } else if (
          firstArg &&
          exprIsAtom(firstArg) &&
          firstArg.token.value === ":"
        ) {
          // *(slice(:)) -> create slice copy of whole slice
          const sliceCode = generateExpr(arg.func!, indent, context);

          const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(sliceBaseType.childType, context))}`;
          // Register the slice type
          if (!context.sliceStructTypes.has(sliceTypeName)) {
            context.sliceStructTypes.set(sliceTypeName, {
              childType: getTypeString(sliceBaseType.childType, context),
            });
          }
          return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
        }
      }
    }

    const argCode = generateExpr(arg, indent, context);

    // For pointer/reference creation, we need to be careful about constness
    // Simply use the address-of operator without an explicit cast to avoid const issues
    return `(&${argCode})`;
  }
  // (anonymous) tuple value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.tuple)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    const cName = context.types[expr.$?.type?.id ?? ""]?.cName;
    const tempVar = expr.$?.variableName;

    if (runtimeArgExprs && cName) {
      const functionContext = context as FunctionGenerationContext;

      // Generate tuple initialization with dup handling for each argument
      const argsList = runtimeArgExprs
        .map((arg) => {
          const argCode = generateExpr(arg, indent, context);

          // Handle deferred dup expressions for tuple fields
          if (
            arg.$?.deferredDupExpressions &&
            arg.$.deferredDupExpressions.length > 0
          ) {
            generateDeferredDupExpressions(arg, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = arg.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              return sanitizeForCIdentifier(dupExpr.$.variableName);
            }
          }

          return argCode;
        })
        .join(", ");

      // If this tuple has a temporary variable name, declare it
      if (tempVar && expr.$?.type) {
        const tupleValue = `(${cName}){ ${argsList} }`;
        const varTypeAndName = getVariableTypeString(
          expr.$.type,
          tempVar,
          context
        );
        context.emitter.emitLine(`${indent}${varTypeAndName} = ${tupleValue};`);
        return tempVar;
      } else {
        return `(${cName}){ ${argsList} }`;
      }
    } else if (expr.args.length === 0) {
      // unit
      return "";
    }
  }
  // (anonymous) array value
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.array)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    const arrayType = expr.$?.type;
    const tempVar = expr.$?.variableName;

    if (isArrayType(arrayType) && runtimeArgExprs) {
      const functionContext = context as FunctionGenerationContext;

      // Generate struct wrapper initialization with dup handling for each element
      const argsList = runtimeArgExprs
        .map((arg) => {
          const argCode = generateExpr(arg, indent, context);

          // Handle deferred dup expressions for array fields
          if (
            arg.$?.deferredDupExpressions &&
            arg.$.deferredDupExpressions.length > 0
          ) {
            generateDeferredDupExpressions(arg, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = arg.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              return sanitizeForCIdentifier(dupExpr.$.variableName);
            }
          }

          return argCode;
        })
        .join(", ");
      const arrayTypeName = getTypeString(arrayType, context);

      // If this array has a temporary variable name, declare it
      if (tempVar && expr.$?.type) {
        const arrayValue = `(${arrayTypeName}){ .data = { ${argsList} } }`;
        const varTypeAndName = getVariableTypeString(
          expr.$.type,
          tempVar,
          context
        );
        context.emitter.emitLine(`${indent}${varTypeAndName} = ${arrayValue};`);
        return tempVar;
      } else {
        return `(${arrayTypeName}){ .data = { ${argsList} } }`;
      }
    }
  }
  // recur
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.recur)) {
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
    if (runtimeArgExprs) {
      const functionContext = context as FunctionGenerationContext;

      // Generate recur call with arguments and dup handling
      const argsList = runtimeArgExprs
        .map((arg) => {
          const argCode = generateExpr(arg, indent, context);

          // Handle deferred dup expressions for recur arguments
          if (
            arg.$?.deferredDupExpressions &&
            arg.$.deferredDupExpressions.length > 0
          ) {
            generateDeferredDupExpressions(arg, indent, functionContext);
            // Use the dup result variable instead of the original
            const dupExpr = arg.$.deferredDupExpressions[0]!;
            if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
              return sanitizeForCIdentifier(dupExpr.$.variableName);
            }
          }

          return argCode;
        })
        .join(", ");
      return `${context.currentFunctionName}(${argsList})`;
    } else {
      return `// Error: No arguments for recur call ${exprToString(expr)}\n`;
    }
  }
  // sizeof
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.sizeof, 1)) {
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);
    return `sizeof(${argCode})`; // Use sizeof operator on the argument
  }
  // __yo_decr_rc
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_decr_rc)) {
    const arg = expr.args[0]!;
    const argCode = generateExpr(arg, indent, context);
    return `__yo_decr_rc(${argCode})`;
  }
  // Builtin Yo inline functions
  else if (exprIsFunctionCallOf(expr, BuiltinYoInlineFunctions)) {
    // NOTE: || expr.args is necessary to support function call like __yo_as(i, i32);
    const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder || expr.args;
    if (runtimeArgExprs) {
      const functionContext = context as FunctionGenerationContext;

      const args = runtimeArgExprs.map((arg) => {
        const argCode = generateExpr(arg, indent, context);

        // Handle deferred dup expressions for inline function arguments
        if (
          arg.$?.deferredDupExpressions &&
          arg.$.deferredDupExpressions.length > 0
        ) {
          generateDeferredDupExpressions(arg, indent, functionContext);
          // Use the dup result variable instead of the original
          const dupExpr = arg.$.deferredDupExpressions[0]!;
          if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
            return sanitizeForCIdentifier(dupExpr.$.variableName);
          }
        }

        return argCode;
      });

      return generateYoInlineFunctionCall(
        expr.func.token.value,
        args,
        expr,
        context
      );
    }
  }
  // while loop
  else if (exprIsFunctionCallOf(expr, BuiltinKeywords.while)) {
    return generateWhileLoop(expr, indent, context);
  }
  // anonymous function (fn(x) -> body)
  else if (
    exprIsFunctionCallOf(expr, "->", 2) &&
    exprIsFunctionCall(expr.args[0]) &&
    exprIsFunctionCallOf(expr.args[0], BuiltinKeywords.fn)
  ) {
    // Anonymous functions should have been evaluated and have a function value
    const functionValue = expr.$?.value;
    if (isFunctionValue(functionValue)) {
      return generateComptValue(functionValue, context);
    } else {
      return `// Error: Anonymous function missing function value`;
    }
  }
  // consume
  else if (exprIsFunctionCallOf(expr, BuiltinFunctions.consume)) {
    return generateExpr(expr.args[0]!, indent, context);
  }
  // functions that should be skipped
  // compt_expect_error
  else if (
    exprIsFunctionCallOf(expr, BuiltinFunctions.compt_expect_error) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_print_info) ||
    exprIsFunctionCallOf(
      expr,
      BuiltinFunctions.__yo_var_is_owning_the_gc_value
    ) ||
    exprIsFunctionCallOf(expr, BuiltinFunctions.__yo_var_has_other_aliases)
  ) {
    // no-op in C, just return empty string
    return "";
  }
  // other function call
  else {
    const functionType = expr.func.$?.type;
    const functionValue = expr.func.$?.value;

    if (isFunctionType(functionType)) {
      const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

      if (runtimeArgExprs) {
        // Check if this is a method call on a dyn object
        let isDynMethodCall = false;
        if (
          exprIsFunctionCall(expr.func) &&
          exprIsFunctionCallOf(expr.func, ".", 2)
        ) {
          const objectExpr = expr.func.args[0];
          const objectType = objectExpr?.$?.type;
          if (objectType && isDynType(objectType)) {
            isDynMethodCall = true;
          }
        }

        // Generate arg list with special handling for dyn method calls
        const args = runtimeArgExprs.map((arg, index) => {
          // First, check if this argument needs a temporary variable
          if (arg.$?.variableName && arg.$?.type) {
            const functionContext = context as FunctionGenerationContext;

            // Check if this variable is captured by a closure
            const isClosureCapturedVariable =
              functionContext.currentClosureCaptures &&
              functionContext.currentClosureCaptures.includes(
                arg.$.variableName
              ) &&
              exprIsAtom(arg) &&
              arg.$.env &&
              functionContext.currentClosureCaptureFrameLevel !== undefined &&
              checkVariableIsClosureCaptured(
                arg.token.value,
                arg.$.env,
                functionContext.currentClosureCaptureFrameLevel
              );

            // Generate the argument expression and declare it as a temp variable
            const argCode = generateExpr(arg, indent, context);

            // Check if this variable is captured by a state machine
            const isStateMachineCapturedVariable =
              functionContext.inStateMachine && argCode.startsWith("sm->");

            if (
              argCode &&
              argCode !== arg.$.variableName &&
              !isClosureCapturedVariable &&
              !isStateMachineCapturedVariable
            ) {
              // Only emit declaration if:
              // 1. The expression doesn't already handle it
              // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
              // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
              // 4. It's not a redundant self-assignment (e.g., int32_t errno_ = errno_)
              const sanitizedVarName = sanitizeForCIdentifier(
                arg.$.variableName
              );
              if (argCode !== sanitizedVarName) {
                const varTypeAndName = getVariableTypeString(
                  arg.$.type,
                  arg.$.variableName,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${argCode};`
                );
              }
            }

            // Handle deferred dup expressions for function arguments
            // After generating the argument temp variable, check if we need to dup it
            let finalArgVarName = arg.$.variableName;
            if (
              arg.$?.deferredDupExpressions &&
              arg.$.deferredDupExpressions.length > 0
            ) {
              // Only treat deferred dup as a replacement for the argument value
              // when it actually targets this argument. For example, closure
              // construction may carry deferred dups for captured variables; those
              // must be applied during capture initialization, not substituted as
              // the call argument.
              const argTargets = new Set<string>();
              if (arg.$?.variableName) {
                argTargets.add(sanitizeForCIdentifier(arg.$.variableName));
              }
              if (argCode) {
                argTargets.add(argCode);
              }
              if (exprIsAtom(arg)) {
                argTargets.add(sanitizeForCIdentifier(arg.token.value));
              }

              const matchingDupExpr = arg.$.deferredDupExpressions.find((e) => {
                const target = getDeferredDupTargetAtomName(e);
                if (!target) return false;
                return argTargets.has(sanitizeForCIdentifier(target));
              });

              if (matchingDupExpr) {
                generateDeferredDupExpressions(arg, indent, functionContext);
                if (
                  exprIsFunctionCall(matchingDupExpr) &&
                  matchingDupExpr.$?.variableName
                ) {
                  finalArgVarName = sanitizeForCIdentifier(
                    matchingDupExpr.$.variableName
                  );
                }
              }
            }

            // For dyn method calls, transform the first argument (self) from dyn object to data pointer
            // EXCEPT for dyn object's own methods (which are in the dyn type's .module)
            if (isDynMethodCall && index === 0) {
              // Check if this method exists in the dyn type's own module
              if (
                exprIsFunctionCall(expr.func) &&
                exprIsFunctionCallOf(expr.func, ".", 2)
              ) {
                const objectExpr = expr.func.args[0];
                const dynType = objectExpr?.$?.type;
                const methodExpr = expr.func.args[1];

                if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                  const methodName = methodExpr.token.value;
                  // Check if this method exists in the dyn type's module
                  const dynMethod = dynType.module.fields.find(
                    (field) => field.label === methodName
                  );

                  if (dynMethod) {
                    // This is a dyn object's own method, pass the dyn object directly
                    return sanitizeForCIdentifier(finalArgVarName);
                  }
                }
              }

              // For all other methods (wrapped object methods), pass the wrapped object data
              // Dyn is a value type, but callers may pass a borrow (pointer) depending on the method signature.
              const argType = arg.$?.type;
              if (argType && isPtrType(argType)) {
                return `${sanitizeForCIdentifier(finalArgVarName)}->data`;
              }
              return `(${sanitizeForCIdentifier(finalArgVarName)}).data`;
            } else {
              // If this is a closure-captured variable, use the generated code (inline access)
              // If this is a state machine variable, use the generated code (sm->var_xxx access)
              // Otherwise use the sanitized variable name (potentially duped)
              return isClosureCapturedVariable || isStateMachineCapturedVariable
                ? argCode
                : sanitizeForCIdentifier(finalArgVarName);
            }
          } else {
            // For dyn method calls, transform the first argument (self) from dyn object to data pointer
            // EXCEPT for dyn object's own methods (which are in the dyn type's .module)
            if (isDynMethodCall && index === 0) {
              const dynObjectCode = generateExpr(arg, indent, context);

              // Check if this method exists in the dyn type's own module
              if (
                exprIsFunctionCall(expr.func) &&
                exprIsFunctionCallOf(expr.func, ".", 2)
              ) {
                const objectExpr = expr.func.args[0];
                const dynType = objectExpr?.$?.type;
                const methodExpr = expr.func.args[1];

                if (exprIsAtom(methodExpr) && isDynType(dynType)) {
                  const methodName = methodExpr.token.value;
                  // Check if this method exists in the dyn type's module
                  const dynMethod = dynType.module.fields.find(
                    (field) => field.label === methodName
                  );

                  if (dynMethod) {
                    // This is a dyn object's own method, pass the dyn object directly
                    return dynObjectCode;
                  }
                }
              }

              // For all other methods (wrapped object methods), pass the wrapped object data
              const argType = arg.$?.type;
              if (argType && isPtrType(argType)) {
                return `(${dynObjectCode})->data`;
              }
              return `(${dynObjectCode}).data`;
            } else {
              return generateExpr(arg, indent, context);
            }
          }
        });
        const argsList = args.join(", ");

        // Check if this is an extern "yo" function - handle these first before regular function values
        if (functionType.isExtern === "yo" && functionType.externName) {
          const externFuncName = functionType.externName;

          if (BuiltinYoInlineFunctions.includes(externFuncName)) {
            return generateYoInlineFunctionCall(
              externFuncName,
              args,
              expr,
              context
            );
          } else if (externFuncName === "__yo_thread_spawn") {
            // Special handling for __yo_thread_spawn(cb : Impl(Fn() -> unit, Send))
            // We need to:
            // 1. Find the closure function from implClosureCallMap
            // 2. Heap-allocate the closure data (since thread needs it after function returns)
            // 3. Call __yo_thread_spawn(closure_fn, heap_closure_data)
            return generateThreadSpawnCall(expr, indent, context);
          } else if (externFuncName === "__yo_worker_spawn") {
            // Special handling for __yo_worker_spawn(cb : Impl(Fn() -> unit, Send))
            // Similar to __yo_thread_spawn but spawns on the worker pool
            return generateWorkerSpawnCall(expr, indent, context);
          } else if (isUnitType(functionType.return.type)) {
            // If the function returns unit, just call it without assignment
            context.emitter.emitLine(
              `${indent}${externFuncName}(${argsList});`
            );

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return ""; // No return value
          } else {
            return `${externFuncName}(${argsList})`;
          }
        }

        if (isFunctionValue(functionValue)) {
          // Check if it's function vaue whose body only contains Yo operator
          const operatorFunctionName =
            isFunctionValueWithOnlyBuiltinYoInlineFunctionCall(functionValue);
          if (operatorFunctionName) {
            return generateYoInlineFunctionCall(
              operatorFunctionName,
              args,
              expr,
              context
            );
          }

          // Get new function type, which might be specialized.
          const functionType =
            functionValue.specializedType ?? functionValue.type;
          // Normal function call
          const cFuncName = context.functions[functionValue.funcId]?.cName;
          if (cFuncName) {
            // Generate function call
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${cFuncName}(${argsList});`);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                context.emitter.emitLine(
                  `${indent}${getTypeString(expr.$?.type ?? functionValue.specializedType?.return.type ?? functionType.return.type, context)} ${tempVar} = ${cFuncName}(${argsList});`
                );

                // Handle deferred drop expressions if they exist
                if (expr.$?.deferredDropExpressions) {
                  generateDeferredDropExpressions(expr, indent, context);
                }

                return tempVar; // Return the temp variable name
              } else {
                // Error: regular function call returns non-unit type but no temp variable assigned
                return `// Error: Regular function call returns ${getTypeString(functionValue.specializedType?.return.type ?? functionType.return.type, context)} but no temp variable assigned`;
              }
            }
          }
        } else {
          const externFunction = context.externFunctions[functionType.id];
          if (externFunction) {
            // Generate regular extern function call
            const cFuncName = externFunction.cName;

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return `${cFuncName}(${argsList})`;
          } else {
            // Function parameter call (e.g., callback(x))
            const funcCode = generateExpr(expr.func, indent, context);
            if (isUnitType(functionType.return.type)) {
              // If the function returns unit, just call it without assignment
              context.emitter.emitLine(`${indent}${funcCode}(${argsList});`);

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return ""; // No return value
            } else {
              // If it returns a value, assign to a temp variable or return directly
              const tempVar = expr.$?.variableName;
              if (tempVar) {
                context.emitter.emitLine(
                  `${indent}${getTypeString(expr.$?.type ?? functionType.return.type, context)} ${tempVar} = ${funcCode}(${argsList});`
                );

                // Handle deferred drop expressions if they exist
                if (expr.$?.deferredDropExpressions) {
                  generateDeferredDropExpressions(expr, indent, context);
                }

                return tempVar; // Return the temp variable name
              } else {
                // Error: function parameter call returns non-unit type but no temp variable assigned
                return `// Error: Function parameter call returns ${getTypeString(functionType.return.type, context)} but no temp variable assigned`;
              }
            }
          }
        }
      }
    } else if (functionType && typeImplementsFn(functionType)) {
      const closureValueType = functionType;
      const fnModule = extractFnModuleFromType(closureValueType)!;
      // Check if this is a Dyn closure (uses vtable) or Impl closure (static dispatch)
      const isDynClosure = isDynType(closureValueType);
      {
        const callSig = fnModule.isFn.callType;
        // Handle closure calls with dynamic dispatch through vtable
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;

        if (runtimeArgExprs) {
          // First, handle arguments that need temporary variables
          const functionContext = context as FunctionGenerationContext;
          for (const arg of runtimeArgExprs) {
            if (arg.$?.variableName && arg.$?.type) {
              // Check if this variable is captured by a closure
              const isClosureCapturedVariable =
                functionContext.currentClosureCaptures &&
                functionContext.currentClosureCaptures.includes(
                  arg.$.variableName
                ) &&
                exprIsAtom(arg) &&
                arg.$.env &&
                functionContext.currentClosureCaptureFrameLevel !== undefined &&
                checkVariableIsClosureCaptured(
                  arg.token.value,
                  arg.$.env,
                  functionContext.currentClosureCaptureFrameLevel
                );

              // Generate the argument expression and declare it as a temp variable
              const argCode = generateExpr(arg, indent, context);

              // Check if this variable is captured by a state machine
              const isStateMachineCapturedVariable =
                functionContext.inStateMachine && argCode.startsWith("sm->");

              if (
                argCode &&
                argCode !== arg.$.variableName &&
                !isClosureCapturedVariable &&
                !isStateMachineCapturedVariable
              ) {
                // Only emit declaration if:
                // 1. The expression doesn't already handle it
                // 2. It's not a closure-captured variable (those are accessed inline from closure_context->data)
                // 3. It's not a state machine variable (those are accessed via sm->var_xxx)
                const varTypeAndName = getVariableTypeString(
                  arg.$.type,
                  arg.$.variableName,
                  context
                );
                context.emitter.emitLine(
                  `${indent}${varTypeAndName} = ${argCode};`
                );
              }
            }
          }

          // Generate closure value and function arguments
          const closureCode = generateExpr(expr.func, indent, context);
          const args = runtimeArgExprs.map((arg) => {
            if (arg.$?.variableName && arg.$?.type) {
              // Check if this is a closure-captured variable - if so, use the full access expression
              const isClosureCapturedVariable =
                functionContext.currentClosureCaptures &&
                functionContext.currentClosureCaptures.includes(
                  arg.$.variableName
                ) &&
                exprIsAtom(arg) &&
                arg.$.env &&
                functionContext.currentClosureCaptureFrameLevel !== undefined &&
                checkVariableIsClosureCaptured(
                  arg.token.value,
                  arg.$.env,
                  functionContext.currentClosureCaptureFrameLevel
                );

              if (isClosureCapturedVariable) {
                // Return the inline access expression
                return generateExpr(arg, indent, context);
              } else {
                // Check if this is a state machine variable
                const argCode = generateExpr(arg, indent, context);
                const isStateMachineCapturedVariable =
                  functionContext.inStateMachine && argCode.startsWith("sm->");

                // Handle deferred dup expressions for closure call arguments
                let finalArgVarName = arg.$.variableName;
                if (
                  arg.$?.deferredDupExpressions &&
                  arg.$.deferredDupExpressions.length > 0
                ) {
                  generateDeferredDupExpressions(arg, indent, functionContext);
                  // Use the dup result variable instead of the original
                  const dupExpr = arg.$.deferredDupExpressions[0]!;
                  if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                    finalArgVarName = sanitizeForCIdentifier(
                      dupExpr.$.variableName
                    );
                  }
                }

                return isStateMachineCapturedVariable
                  ? argCode
                  : finalArgVarName;
              }
            } else {
              return generateExpr(arg, indent, context);
            }
          });

          // Dispatch:
          // - Dyn(Fn(...)) uses vtable: closure.vtable->call(closure.data, args...)
          // - Impl(Fn(...)) uses static dispatch: closure_impl(&closure, args...)
          let closureCall: string;
          if (isDynClosure) {
            const allArgs = [`(${closureCode}).data`, ...args];
            closureCall = `(${closureCode}).vtable->call(${allArgs.join(", ")})`;
          } else {
            // For Impl closures, the value is the concrete capture struct.
            // Find the corresponding generated implementation function.
            let concreteTypeId: string | undefined;
            if (closureValueType.tag === TypeTag.SomeType) {
              const someType = closureValueType as SomeType;
              if (someType.resolvedConcreteType) {
                concreteTypeId = someType.resolvedConcreteType.id;
              }
            }

            const mapped = concreteTypeId
              ? context.implClosureCallMap.get(concreteTypeId)
              : undefined;

            if (!mapped) {
              // Fallback to old representation if mapping is missing.
              const allArgs = [`(${closureCode}).data`, ...args];
              closureCall = `(${closureCode}).call(${allArgs.join(", ")})`;
            } else {
              const allArgs = [`&(${closureCode})`, ...args];
              closureCall = `${mapped.functionCName}(${allArgs.join(", ")})`;
            }
          }

          // Get return type from the closure's function signature
          const returnType = callSig.return.type;

          if (isUnitType(returnType)) {
            // If the closure returns unit, just call it without assignment
            context.emitter.emitLine(`${indent}${closureCall};`);

            // Handle deferred drop expressions if they exist
            if (expr.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(expr, indent, context);
            }

            return ""; // No return value
          } else {
            // If it returns a value, assign to a temp variable or return directly
            const tempVar = expr.$?.variableName;
            if (tempVar) {
              context.emitter.emitLine(
                `${indent}${getTypeString(returnType, context)} ${tempVar} = ${closureCall};`
              );

              // Handle deferred drop expressions if they exist
              if (expr.$?.deferredDropExpressions) {
                generateDeferredDropExpressions(expr, indent, context);
              }

              return tempVar; // Return the temp variable name
            } else {
              // Error: closure returns non-unit type but no temp variable assigned
              return `// Error: Closure call returns ${getTypeString(returnType, context)} but no temp variable assigned`;
            }
          }
        } else {
          // Note: Closure construction is now handled in the isTypeValue(functionValue) branch below
          // by checking for expr.$?.closureFunctionValue
          return `// Error: No runtime args found for closure call`;
        }
      }
    } else if (isTypeValue(functionValue)) {
      // struct
      if (isStructType(functionValue.value)) {
        const structType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[structType.id]?.cName;
        const labels = structType.fields.map((field) => field.label);
        const tempVar = expr.$?.variableName;

        if (
          runtimeArgExprs &&
          cName &&
          labels.length === runtimeArgExprs.length
        ) {
          // Handle newtype as zero-cost abstraction
          if (structType.isNewtype && structType.fields.length === 1) {
            // For newtype, just use the underlying value directly (with cast for type safety)
            const argCode = generateExpr(runtimeArgExprs[0]!, indent, context);
            const newtypeValue = `((${cName})(${argCode}))`;

            // If this newtype has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${newtypeValue};`
              );
              return tempVar;
            } else {
              return newtypeValue;
            }
          }

          if (structType.isReferenceSemantics) {
            // For object, call the constructor function
            const functionContext = context as FunctionGenerationContext;

            const argsList = runtimeArgExprs
              .map((arg) => {
                const argCode = generateExpr(arg, indent, context);

                // Handle deferred dup expressions for constructor arguments
                if (
                  arg.$?.deferredDupExpressions &&
                  arg.$.deferredDupExpressions.length > 0
                ) {
                  // If the arg has a variable name but generateExpr didn't create a declaration,
                  // we need to create it now so the dup call can reference it
                  if (arg.$?.variableName && arg.$?.type) {
                    const argVarName = sanitizeForCIdentifier(
                      arg.$.variableName
                    );
                    // Only emit the declaration if argCode is different from the variable name
                    // to avoid generating code like: prev_opt = prev_opt;
                    if (argCode !== argVarName) {
                      const argType = arg.$.type;
                      const argTypeStr = getTypeString(argType, context);
                      // Emit the variable declaration and assignment
                      context.emitter.emitLine(
                        `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                      );
                    }
                  }

                  generateDeferredDupExpressions(arg, indent, functionContext);
                  // Use the dup result variable instead of the original
                  const dupExpr = arg.$.deferredDupExpressions[0]!;
                  if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                    return sanitizeForCIdentifier(dupExpr.$.variableName);
                  }
                }

                return argCode;
              })
              .join(", ");

            const constructorName = `__yo_new_${cName}`;
            const structValue = `${constructorName}(${argsList})`;

            // If this struct has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${structValue};`
              );
              return tempVar;
            } else {
              return structValue;
            }
          } else {
            // For regular struct, generate struct initialization as before
            const functionContext = context as FunctionGenerationContext;

            const argsList = runtimeArgExprs
              .map((arg, index) => {
                const argCode = generateExpr(arg, indent, context);
                const sanitizedLabel = sanitizeForCIdentifier(labels[index]!);

                // Handle deferred dup expressions for struct fields
                let finalArgValue = argCode;
                if (
                  arg.$?.deferredDupExpressions &&
                  arg.$.deferredDupExpressions.length > 0
                ) {
                  // If the arg has a variable name but generateExpr didn't create a declaration,
                  // we need to create it now so the dup call can reference it
                  if (arg.$?.variableName && arg.$?.type) {
                    const argVarName = sanitizeForCIdentifier(
                      arg.$.variableName
                    );
                    const argType = arg.$.type;
                    const argTypeStr = getTypeString(argType, context);
                    // Only emit the variable declaration if argCode is different from argVarName
                    // to prevent self-assignment like: var = var;
                    if (argCode !== argVarName) {
                      context.emitter.emitLine(
                        `${indent}${argTypeStr} ${argVarName} = ${argCode};`
                      );
                    }
                  }

                  generateDeferredDupExpressions(arg, indent, functionContext);
                  // Use the dup result variable instead of the original
                  const dupExpr = arg.$.deferredDupExpressions[0]!;
                  if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                    finalArgValue = sanitizeForCIdentifier(
                      dupExpr.$.variableName
                    );
                  }
                }

                return `.${sanitizedLabel} = ` + finalArgValue;
              })
              .join(", ");
            const structValue = `(${cName}){ ${argsList} }`;

            // If this struct has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${structValue};`
              );
              return tempVar;
            } else {
              return structValue;
            }
          }
        }
      }
      // closure type - closure construction
      // Note: This is now handled at the top of generateFuncCall by checking expr.$.closureFunctionValue
      else if (typeImplementsFn(functionValue.value)) {
        return `// Error: Closure construction should have been handled by closureFunctionValue check at top of generateFuncCall`;
      }
      // union
      // union is supposed to have only one member initialized
      else if (isUnionType(functionValue.value)) {
        const tempVar = expr.$?.variableName;
        const arg = expr.args[0]!;
        if (
          arg &&
          exprIsFunctionCall(arg) &&
          exprIsFunctionCallOf(arg, ":", 2)
        ) {
          const labelExpr = arg.args[0]!;
          const fieldExpr = arg.args[1]!;
          const cName = context.types[functionValue.value.id]?.cName;
          if (cName && exprIsAtom(labelExpr) && fieldExpr) {
            const functionContext = context as FunctionGenerationContext;
            const label = labelExpr.token.value;
            const sanitizedLabel = sanitizeForCIdentifier(label);
            const fieldCode = generateExpr(fieldExpr, indent, context);

            // Handle deferred dup expressions for union field
            let finalFieldValue = fieldCode;
            if (
              fieldExpr.$?.deferredDupExpressions &&
              fieldExpr.$.deferredDupExpressions.length > 0
            ) {
              generateDeferredDupExpressions(
                fieldExpr,
                indent,
                functionContext
              );
              // Use the dup result variable instead of the original
              const dupExpr = fieldExpr.$.deferredDupExpressions[0]!;
              if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
                finalFieldValue = sanitizeForCIdentifier(
                  dupExpr.$.variableName
                );
              }
            }

            const unionValue = `(${cName}){ .${sanitizedLabel} = ${finalFieldValue} }`;

            // If this union has a temporary variable name, declare it
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${unionValue};`
              );
              return tempVar;
            } else {
              return unionValue;
            }
          }
        }
      }
      // enum
      else if (isEnumType(functionValue.value)) {
        const enumType = functionValue.value;
        const runtimeArgExprs = expr.$?.runtimeArgExprsInOrder;
        const cName = context.types[enumType.id]?.cName;
        const tempVar = expr.$?.variableName;

        if (enumType.selectedVariantName && runtimeArgExprs && cName) {
          // Check if this enum can be optimized as a nullable pointer
          const nullablePointerType = canOptimizeAsNullablePointer(enumType);
          if (nullablePointerType) {
            const variantName = enumType.selectedVariantName;
            const variant = enumType.variants.find(
              (v) => v.name === variantName
            );

            if (variant) {
              if (!variant.fields || variant.fields.length === 0) {
                // This is the "None" case - return NULL
                const enumValue = "NULL";
                if (tempVar && expr.$?.type) {
                  const varTypeAndName = getVariableTypeString(
                    expr.$.type,
                    tempVar,
                    context
                  );
                  context.emitter.emitLine(
                    `${indent}${varTypeAndName} = ${enumValue};`
                  );
                  return tempVar;
                } else {
                  return enumValue;
                }
              } else if (variant.fields.length === 1) {
                // This is the "Some" case - return the pointer value directly
                const pointerValue = generateExpr(
                  runtimeArgExprs[0]!,
                  indent,
                  context
                );
                if (tempVar && expr.$?.type) {
                  const varTypeAndName = getVariableTypeString(
                    expr.$.type,
                    tempVar,
                    context
                  );
                  context.emitter.emitLine(
                    `${indent}${varTypeAndName} = ${pointerValue};`
                  );
                  return tempVar;
                } else {
                  return pointerValue;
                }
              }
            }
          }

          // Check if this enum can be optimized as a simple C enum
          const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
          if (simpleEnumOptimizable) {
            const variantName = enumType.selectedVariantName;
            // For simple enums, just return the enum constant
            const enumValue = getEnumVariantCName(
              enumType,
              variantName,
              context
            );
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${enumValue};`
              );
              return tempVar;
            } else {
              return enumValue;
            }
          }

          // Generate enum initialization (fallback for non-optimized enums)
          const variantName = enumType.selectedVariantName;
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant) {
            // Filter out unit type arguments - they don't need to be stored
            const nonUnitElements =
              variant.fields?.filter((field) => !isUnitType(field.type)) || [];

            const functionContext = context as FunctionGenerationContext;

            const argsList = runtimeArgExprs
              .map((arg, index) => {
                if (variant.fields) {
                  const field = variant.fields[index];
                  if (field && !isUnitType(field.type)) {
                    const argCode = generateExpr(arg, indent, context);
                    const sanitizedLabel = sanitizeForCIdentifier(field.label);

                    // Handle deferred dup expressions for enum variant fields
                    let finalArgValue = argCode;
                    if (
                      arg.$?.deferredDupExpressions &&
                      arg.$.deferredDupExpressions.length > 0
                    ) {
                      generateDeferredDupExpressions(
                        arg,
                        indent,
                        functionContext
                      );
                      // Use the dup result variable instead of the original
                      const dupExpr = arg.$.deferredDupExpressions[0]!;
                      if (
                        exprIsFunctionCall(dupExpr) &&
                        dupExpr.$?.variableName
                      ) {
                        finalArgValue = sanitizeForCIdentifier(
                          dupExpr.$.variableName
                        );
                      }
                    }

                    return `.${sanitizedLabel} = ` + finalArgValue;
                  }
                  return ""; // Skip if no field matches or if it's unit type
                } else {
                  return "";
                }
              })
              .filter((s) => s) // Remove empty strings
              .join(", ");

            // If there are no non-unit fields, we only need the tag
            const enumValue =
              nonUnitElements.length > 0
                ? `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)}, .data = { .${variantName} = { ${argsList} } } }`
                : `(${cName}){ .tag = ${getEnumVariantCName(enumType, variantName, context)} }`;
            if (tempVar && expr.$?.type) {
              const varTypeAndName = getVariableTypeString(
                expr.$.type,
                tempVar,
                context
              );
              context.emitter.emitLine(
                `${indent}${varTypeAndName} = ${enumValue};`
              );
              return tempVar;
            } else {
              return enumValue;
            }
          }
        }
      }
    } else if (isArrayType(functionType)) {
      const firstArg = expr.args[0];

      // Check if this is a slicing operation: arr(start:end) or arr(:)
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // arr(start:end) -> create slice value
        const arrayCode = generateExpr(expr.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as ArrayType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (functionType as ArrayType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = &${arrayCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // arr(:) -> create slice value for whole array
        const arrayCode = generateExpr(expr.func!, indent, context);
        const arrayType = functionType as ArrayType;
        const childType = arrayType.childType;

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString(childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(childType, context),
          });
        }

        if (isNumberValue(arrayType.length)) {
          return `(${sliceTypeName}){ .data = &${arrayCode}.data[0], .length = ${arrayType.length.value} }`;
        } else {
          return `/* Error: Cannot slice array with non-compile-time length */`;
        }
      }

      // Array access by index: arr[index] or arr(index)
      const arrayCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(firstArg!, indent, context);
      // Generate array access with struct wrapper
      return `${arrayCode}.data[${indexCode}]`; // Access the element at the index
    } else if (isSliceType(functionType)) {
      const firstArg = expr.args[0];

      // Check if this is a sub-slicing operation: slice(start:end) or slice(:)
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, ":")
      ) {
        // slice(start:end) -> create sub-slice
        const sliceCode = generateExpr(expr.func!, indent, context);
        const startCode = generateExpr(firstArg.args[0]!, indent, context);
        const endCode = generateExpr(firstArg.args[1]!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as SliceType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (functionType as SliceType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = &${sliceCode}.data[${startCode}], .length = (${endCode}) - (${startCode}) }`;
      } else if (
        firstArg &&
        exprIsAtom(firstArg) &&
        firstArg.token.value === ":"
      ) {
        // slice(:) -> create slice copy of whole slice
        const sliceCode = generateExpr(expr.func!, indent, context);

        const sliceTypeName = `Slice_${sanitizeForCIdentifier(getTypeString((functionType as SliceType).childType, context))}`;
        // Register the slice type
        if (!context.sliceStructTypes.has(sliceTypeName)) {
          context.sliceStructTypes.set(sliceTypeName, {
            childType: getTypeString(
              (functionType as SliceType).childType,
              context
            ),
          });
        }
        return `(${sliceTypeName}){ .data = ${sliceCode}.data, .length = ${sliceCode}.length }`;
      }

      // Slice access by index: slice.data[index]
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(firstArg!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    } else if (
      functionType &&
      isPtrType(functionType) &&
      isSliceType(functionType.childType)
    ) {
      // This case should no longer exist since slices are no longer behind pointers
      // But keep it for backward compatibility during migration
      const sliceCode = generateExpr(expr.func!, indent, context);
      const indexCode = generateExpr(expr.args[0]!, indent, context);
      return `${sliceCode}.data[${indexCode}]`; // Access the element at the index in the slice
    }
  }

  if (exprIsFunctionCall(expr)) {
    throw new Error(`Unhandled function call: ${exprToString(expr)}`);
  }

  return `// Failed to transpile ${exprToString(expr)}`;
}

/**
 * Generate C code for an async block expression.
 * async { body } creates a Future by calling a constructor function
 * similar to how closures are created.
 */
function generateAsyncBlock(
  expr: FuncCallExpr,
  indent: string,
  context: FunctionGenerationContext
): string {
  const bodyExpr = expr.args[0];
  if (!bodyExpr) {
    return `/* Error: async requires exactly 1 argument */`;
  }

  const futureType = expr.$?.type;
  if (!futureType || !typeImplementsFuture(futureType)) {
    return `/* Error: async block must have Future type */`;
  }

  // Extract the FutureModuleType from Impl(Future(T)) or Dyn(Future(T))
  const futureModuleType = extractFutureModuleFromType(futureType);
  if (!futureModuleType) {
    return `/* Error: Could not extract Future module type */`;
  }

  // The state machine struct name will be based on the async block ID
  // This struct IS the Future implementation (value type, not pointer)
  const asyncBlockId = expr.$?.variableName || `async_block_${Date.now()}`;
  const structName = `${asyncBlockId}_state_t`;
  const resumeFunctionName = `${asyncBlockId}_resume`;
  const constructorName = `__yo_new_${asyncBlockId}`;
  const disposeFunctionName = `${asyncBlockId}_state_dispose`;

  // Register this state machine struct as the concrete type for the FutureModuleType
  // This allows getTypeString to find the struct name when generating code
  // Always update (not just if missing) because collectType no longer registers FutureModuleType
  context.types[futureModuleType.id] = {
    type: futureModuleType,
    cName: structName,
  };

  // Get the await analysis result that was computed during evaluation
  // This avoids redundant tree walking and ensures consistency
  const analysis = expr.$?.awaitAnalysis;
  if (!analysis) {
    throw new Error(
      `Missing await analysis for async block. This should have been computed during evaluation.`
    );
  }

  // Get the result type (T in Future(T))
  const resultType = futureModuleType.isFuture.outputType;
  const resultTypeCName = getTypeString(resultType, context);

  const emitter = context.emitter;

  // Generate forward declaration for state machine dispose function
  emitter.emitDeclarationLine(
    `void ${disposeFunctionName}(void* sm_ptr);  // Dispose function for state machine`
  );
  emitter.emitDeclarationLine(``);

  // Generate forward declaration for resume function
  emitter.emitDeclarationLine(`void ${resumeFunctionName}(${structName}* sm);`);
  emitter.emitDeclarationLine(``);

  // Generate forward declaration for constructor function
  // Constructor returns the state machine struct by value (not a pointer)
  if (expr.$?.captureType) {
    const captureType = expr.$.captureType;
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;
    emitter.emitDeclarationLine(
      `${structName}* ${constructorName}(${captureStructName} __capture);`
    );
  } else {
    emitter.emitDeclarationLine(`${structName}* ${constructorName}();`);
  }
  emitter.emitDeclarationLine(``);

  // Store information for deferred generation of implementations
  if (!context.deferredAsyncBlocks) {
    context.deferredAsyncBlocks = [];
  }

  context.deferredAsyncBlocks.push({
    bodyExpr,
    asyncBlockId,
    structName,
    resumeFunctionName,
    constructorName,
    disposeFunctionName,
    futureType: futureType,
    futureModuleType: futureModuleType,
    resultType: resultType,
    resultTypeCName: resultTypeCName,
    captureType: expr.$?.captureType,
    analysis,
  });

  // Generate the constructor call with captured variables
  const captureType = expr.$?.captureType;

  if (captureType) {
    // We have captured variables in a struct
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;

    // Build the capture struct literal
    // Dup expressions are created at evaluation time and don't have correct context for code generation
    // When in a closure or state machine, always use generateAtom for proper context-aware access
    // Otherwise, use dup expressions if available (they handle proper Gc semantics)
    const functionContext = context as FunctionGenerationContext;
    const inSpecialContext =
      functionContext.currentClosureCaptures !== undefined ||
      functionContext.inStateMachine !== undefined;

    const captureFields = captureType.fields
      .map((elem) => {
        // Find the dup expression for this variable by checking the variable name
        // deferredDupExpressions only contains dup expressions for Gc types,
        // so we need to match by variable name, not by index
        let dupExpr: Expr | undefined;
        if (!inSpecialContext && expr.$?.deferredDupExpressions) {
          for (const possibleDupExpr of expr.$.deferredDupExpressions) {
            // Dup expression is in the form: ___dup(varName)
            // Extract the variable name from the first argument
            if (
              exprIsFunctionCall(possibleDupExpr) &&
              possibleDupExpr.args.length > 0 &&
              exprIsAtom(possibleDupExpr.args[0])
            ) {
              const varName = possibleDupExpr.args[0].token.value;
              if (varName === elem.label) {
                dupExpr = possibleDupExpr;
                break;
              }
            }
          }
        }

        if (dupExpr) {
          return `.${elem.label} = ${generateExpr(dupExpr, indent, context)}`;
        }
        // Fallback: generate proper variable access using generateAtom
        // This handles closure context and state machine access properly
        const atomExpr: AtomExpr = {
          tag: ExprTag.Atom,
          token: elem.exprs.expr.token,
          $: elem.exprs.expr.$,
        };
        return `.${elem.label} = ${generateAtom(atomExpr, context)}`;
      })
      .join(", ");

    const captureStructLiteral = `(${captureStructName}){${captureFields}}`;
    const resultVar = expr.$?.variableName || `async_result`;
    const constructorCall = `${constructorName}(${captureStructLiteral})`;

    // If this has a temporary variable name, declare it
    if (resultVar && expr.$?.type) {
      const varTypeAndName = getVariableTypeString(
        expr.$.type,
        resultVar,
        context
      );
      context.emitter.emitLine(
        `${indent}${varTypeAndName} = ${constructorCall};`
      );
      return resultVar;
    } else {
      return constructorCall;
    }
  } else {
    // No captured variables - just call constructor
    const resultVar = expr.$?.variableName || `async_result`;
    const constructorCall = `${constructorName}()`;

    if (resultVar && expr.$?.type) {
      const varTypeAndName = getVariableTypeString(
        expr.$.type,
        resultVar,
        context
      );
      context.emitter.emitLine(
        `${indent}${varTypeAndName} = ${constructorCall};`
      );
      return resultVar;
    } else {
      return constructorCall;
    }
  }
}

function emitAsyncBlockStructDefinition(
  asyncBlockInfo: {
    asyncBlockId: string;
    structName: string;
    resultType: Type;
    resultTypeCName: string;
    captureType: StructType | undefined;
    analysis: AwaitAnalysisResult;
  },
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;
  const {
    asyncBlockId,
    structName,
    resultType,
    resultTypeCName,
    captureType,
    analysis,
  } = asyncBlockInfo;

  emitter.emitDeclarationLine(
    `// State machine for async block ${asyncBlockId} - implements Future(${typeToString(resultType)})`
  );
  emitter.emitDeclarationLine(`struct ${structName}_struct {`);

  // Reference counting header - must be first for yo_ref_header_t* casting
  emitter.emitDeclarationLine(
    `  yo_ref_header_t header;  // Reference counting header (must be first)`
  );

  emitter.emitDeclarationLine(
    `  _Atomic int state;  // Current state (0 = initial, ${analysis.awaitPoints.length + 1} = done, -1 = completed)`
  );

  // For unit type, we don't generate a result field (would be `void result;` which is invalid C)
  if (!isUnitType(resultType)) {
    emitter.emitDeclarationLine(
      `  ${resultTypeCName} result;  // The result value of type ${typeToString(resultType)}`
    );
  }

  // Continuation tracking fields for await chaining
  emitter.emitDeclarationLine(
    `  _Atomic(void (*)(void*)) continuation_fn;  // Resume function of awaiting task`
  );
  emitter.emitDeclarationLine(
    `  _Atomic(void*) continuation_sm;  // State machine of awaiting task`
  );
  emitter.emitDeclarationLine(``);

  // Capture struct field
  if (captureType) {
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;
    emitter.emitDeclarationLine(`  // Captured variables from outer scope`);
    emitter.emitDeclarationLine(`  ${captureStructName} __capture;`);
    emitter.emitDeclarationLine(``);
  }

  // Local variables
  if (analysis.capturedVariables.length > 0) {
    emitter.emitDeclarationLine(`  // Local variables`);
    for (const variable of analysis.capturedVariables) {
      const varTypeCName = getTypeString(variable.type, context);
      const fieldName = getStateMachineFieldName(variable.id, "local");
      emitter.emitDeclarationLine(
        `  ${varTypeCName} ${fieldName};  // ${variable.name}`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  // Await result temporaries
  if (analysis.awaitPoints.length > 0) {
    emitter.emitDeclarationLine(`  // Await result temporaries`);
    for (const awaitPoint of analysis.awaitPoints) {
      if (!isUnitType(awaitPoint.resultType)) {
        // Determine the correct type for await_result_X:
        // For extern futures (e.g., io_uring), use the Future's result type directly
        // For async block futures, use awaitPoint.resultType (which matches the block's result)
        let awaitResultType = awaitPoint.resultType;

        if (awaitPoint.futureType) {
          const futureModuleType = extractFutureModuleFromType(
            awaitPoint.futureType
          );
          if (futureModuleType) {
            // Use the Future's output type as the await_result type
            awaitResultType = futureModuleType.isFuture.outputType;
          }
        }

        const awaitResultTypeCName = getTypeString(awaitResultType, context);
        emitter.emitDeclarationLine(
          `  ${awaitResultTypeCName} await_result_${awaitPoint.index};`
        );
      }
    }
    emitter.emitDeclarationLine(``);
  }

  // await_future_X fields (used when awaiting an expression that isn't a captured Future variable)
  if (analysis.awaitPoints.length > 0) {
    const awaitPointsNeedingFutureStorage = analysis.awaitPoints.filter(
      (ap) => ap.futureVariableId === undefined
    );
    if (awaitPointsNeedingFutureStorage.length > 0) {
      emitter.emitDeclarationLine(`  // Future references for awaits`);
      for (const awaitPoint of awaitPointsNeedingFutureStorage) {
        const awaitExpr = awaitPoint.expr as Expr;
        if (awaitExpr.tag !== ExprTag.FuncCall) {
          continue;
        }
        const futureExpr = awaitExpr.args[0];
        const futureType = futureExpr?.$?.type;
        if (!futureType) {
          throw new Error(
            `Internal error: await expression missing type info for future argument in async block ${asyncBlockId}`
          );
        }
        const awaitedFutureTypeCName = getTypeString(futureType, context);
        emitter.emitDeclarationLine(
          `  ${awaitedFutureTypeCName} await_future_${awaitPoint.index};`
        );
      }
      emitter.emitDeclarationLine(``);
    }
  }

  // cond_branch_X fields
  const condAwaitPoints = analysis.awaitPoints.filter((ap) => ap.isInsideCond);
  if (condAwaitPoints.length > 0) {
    emitter.emitDeclarationLine(
      `  // Branch tracking for cond expressions with await`
    );
    for (const awaitPoint of condAwaitPoints) {
      emitter.emitDeclarationLine(
        `  int cond_branch_${awaitPoint.index};  // Which branch was taken in cond with await ${awaitPoint.index}`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  // while_loop_X_active fields
  const whileAwaitPoints = analysis.awaitPoints.filter(
    (ap) => ap.isInsideWhile
  );
  if (whileAwaitPoints.length > 0) {
    emitter.emitDeclarationLine(
      `  // Loop state tracking for while loops with await`
    );
    for (const awaitPoint of whileAwaitPoints) {
      emitter.emitDeclarationLine(
        `  _Bool while_loop_${awaitPoint.index}_active;  // Whether while loop ${awaitPoint.index} should continue`
      );
    }
    emitter.emitDeclarationLine(``);
  }

  emitter.emitDeclarationLine(`};`);
  emitter.emitDeclarationLine(``);
}

function emitDeferredAsyncBlockStructDefinitions(
  context: FunctionGenerationContext
): void {
  if (
    !context.deferredAsyncBlocks ||
    context.deferredAsyncBlocks.length === 0
  ) {
    return;
  }

  const blocks = context.deferredAsyncBlocks;
  const byStructName = new Map<string, (typeof blocks)[number]>();
  for (const b of blocks) {
    byStructName.set(b.structName, b);
  }

  // Build dependency graph: A depends on B if A's struct embeds B by value.
  // For Kahn's algorithm we store reverse edges: B -> {A...}.
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const b of blocks) {
    dependents.set(b.structName, new Set());
    indegree.set(b.structName, 0);
  }

  for (const b of blocks) {
    const addDep = (depStructName: string) => {
      // depStructName must be emitted before b.structName
      const ds = dependents.get(depStructName)!;
      if (ds.has(b.structName)) {
        return;
      }
      ds.add(b.structName);
      indegree.set(b.structName, (indegree.get(b.structName) ?? 0) + 1);
    };

    // Local variable fields
    for (const v of b.analysis.capturedVariables) {
      const t = getTypeString(v.type, context);
      const target = byStructName.get(t);
      if (target && target.structName !== b.structName) {
        addDep(target.structName);
      }
    }

    // await_future_X fields
    for (const ap of b.analysis.awaitPoints) {
      if (ap.futureVariableId !== undefined) {
        continue;
      }
      const awaitExpr = ap.expr as Expr;
      if (awaitExpr.tag !== ExprTag.FuncCall) {
        continue;
      }
      const futureExpr = awaitExpr.args[0];
      const futureType = futureExpr?.$?.type;
      if (!futureType) {
        continue;
      }
      const t = getTypeString(futureType, context);
      const target = byStructName.get(t);
      if (target && target.structName !== b.structName) {
        addDep(target.structName);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, deg] of indegree.entries()) {
    if (deg === 0) queue.push(name);
  }

  const ordered: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    ordered.push(n);
    const ds = dependents.get(n);
    if (!ds) continue;
    for (const m of ds) {
      const next = (indegree.get(m) ?? 0) - 1;
      indegree.set(m, next);
      if (next === 0) queue.push(m);
    }
  }

  // If there are cycles (shouldn't happen), fall back to input order
  const orderedBlocks =
    ordered.length === blocks.length
      ? ordered.map((n) => byStructName.get(n)!).filter(Boolean)
      : blocks;

  for (const b of orderedBlocks) {
    emitAsyncBlockStructDefinition(
      {
        asyncBlockId: b.asyncBlockId,
        structName: b.structName,
        resultType: b.resultType,
        resultTypeCName: b.resultTypeCName,
        captureType: b.captureType,
        analysis: b.analysis,
      },
      context
    );
  }
}

/**
 * Generate the state machine struct, resume function, and constructor for an async block.
 * This reuses the async function state machine infrastructure.
 */
/**
 * Generate the state machine dispose function for an async block.
 * This drops the capture struct before freeing the state machine.
 *
 * NOTE: This is the dispose function, called by __yo_decr_rc when refcount hits 0.
 * It should NOT call __yo_free - that's handled by __yo_decr_rc.
 */
function generateAsyncBlockStateDisposeFunction(
  asyncBlockId: string,
  structName: string,
  disposeFunctionName: string,
  captureType: StructType | undefined,
  analysis: AwaitAnalysisResult,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  emitter.emitLine(
    `// Dispose function for async block ${asyncBlockId} state machine`
  );
  emitter.emitLine(
    `// Called by __yo_decr_rc when refcount hits 0 - do NOT call __yo_free here`
  );
  emitter.emitLine(`void ${disposeFunctionName}(void* sm_ptr) {`);
  emitter.emitLine(`  ${structName}* sm = (${structName}*)sm_ptr;`);
  emitter.emitLine(
    `  ASYNC_DEBUG("${disposeFunctionName}: Disposing state machine\\n");`
  );
  emitter.emitLine(``);

  // Drop capture struct (like closures do)
  if (captureType && typeContainsGcType(captureType)) {
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    if (!existingCaptureTypeEntry) {
      emitter.emitLine(
        `  /* Error: capture struct type not found in context */`
      );
    } else {
      const captureTypeName = existingCaptureTypeEntry.cName;

      // Find the ___drop function for the capture struct
      const dropFunction = captureType.module.fields.find(
        (field) => field.label === BuiltinFunctions.___drop[0]
      );
      if (
        dropFunction &&
        dropFunction.assignedValue &&
        isFunctionValue(dropFunction.assignedValue)
      ) {
        const dropFunctionCName =
          context.functions[dropFunction.assignedValue.funcId]?.cName;
        if (dropFunctionCName) {
          emitter.emitLine(`  ASYNC_DEBUG("  Dropping capture struct\\n");`);
          emitter.emitLine(`  ${dropFunctionCName}(sm->__capture);`);
        }
      } else {
        emitter.emitLine(
          `  /* Warning: ___drop function not found for capture struct ${captureTypeName} */`
        );
      }
    }
  }

  emitter.emitLine(``);

  // NOTE: Local variables are ALWAYS handled by deferred drop expressions
  // that run in the final state before completion. The state machine dispose
  // function only needs to clean up outer captured variables.
  // Memory is freed by __yo_decr_rc after this function returns.

  emitter.emitLine(
    `  // Memory freed by __yo_decr_rc after this function returns`
  );
  emitter.emitLine(`}`);
}

/**
 * Generate the resume function for an async block.
 * This follows the same pattern as async function resume functions.
 */
/**
 * Generate the constructor function for an async block.
 * The constructor allocates the state machine and Future, initializes captured variables,
 * and starts eager execution.
 *
 * LIFETIME MODEL:
 * - State machine starts with refcount = 1 (owned by caller)
 * - Event loop increments refcount when task is queued
 * - Event loop decrements refcount when task completes
 * - User code decrements refcount when dropping the Future
 * - State machine is freed when refcount hits 0
 */
function generateAsyncBlockConstructor(
  asyncBlockId: string,
  structName: string,
  resumeFunctionName: string,
  constructorName: string,
  disposeFunctionName: string,
  futureType: SomeType | DynType,
  resultType: Type,
  resultTypeCName: string,
  captureType: StructType | undefined,
  context: FunctionGenerationContext
): void {
  const emitter = context.emitter;

  // Ensure Future/state-machine struct has a stable address: allocate on heap and return pointer.

  // Generate constructor signature - returns pointer
  if (captureType) {
    const existingCaptureTypeEntry = Object.values(context.types).find(
      (entry) => entry.type === captureType
    );
    const captureStructName = existingCaptureTypeEntry
      ? existingCaptureTypeEntry.cName
      : `async_capture_${captureType.id}`;
    emitter.emitLine(
      `${structName}* ${constructorName}(${captureStructName} __capture) {`
    );
  } else {
    emitter.emitLine(`${structName}* ${constructorName}() {`);
  }

  // Allocate + initialize async block state machine
  emitter.emitLine(
    `  // Allocate async block state machine (heap-backed, ref-counted)`
  );
  emitter.emitLine(
    `  ${structName}* sm = (${structName}*)__yo_malloc(sizeof(${structName}));`
  );
  emitter.emitLine(`  memset(sm, 0, sizeof(${structName}));`);
  emitter.emitLine(``);

  // Initialize reference counting header
  emitter.emitLine(`  // Initialize reference counting header`);
  emitter.emitLine(
    `  sm->header.ref_count = 1;  // Caller owns initial reference`
  );
  emitter.emitLine(`  sm->header.gc_flags = 0;`);
  emitter.emitLine(`  sm->header.gc_mark = YO_GC_UNMARKED;`);
  emitter.emitLine(`  sm->header.gc_next = NULL;`);
  emitter.emitLine(`  sm->header.gc_prev = NULL;`);
  emitter.emitLine(
    `  sm->header.dispose_fn = (void(*)(void*))${disposeFunctionName};`
  );
  emitter.emitLine(
    `  sm->header.traverse_fn = NULL;  // TODO: Add traverse for cycle detection if needed`
  );
  emitter.emitLine(``);

  emitter.emitLine(`  atomic_init(&sm->state, 0);`);
  emitter.emitLine(`  atomic_init(&sm->continuation_fn, NULL);`);
  emitter.emitLine(`  atomic_init(&sm->continuation_sm, NULL);`);
  emitter.emitLine(``);

  // Initialize capture struct
  if (captureType) {
    emitter.emitLine(`  // Initialize captured variables`);
    emitter.emitLine(`  sm->__capture = __capture;`);
    emitter.emitLine(``);
  }

  // Initialize result to default/zero value
  // For now, we just zero-initialize
  emitter.emitLine(
    `  // Initialize result (will be set when async block completes)`
  );
  if (isUnitType(resultType)) {
    emitter.emitLine(`  // Result is unit type, no initialization needed`);
  } else {
    emitter.emitLine(`  memset(&sm->result, 0, sizeof(${resultTypeCName}));`);
  }
  emitter.emitLine(``);

  // Eager execution: start running the async block immediately
  // Execute until the first await point or completion
  emitter.emitLine(
    `  // Eager execution: start running immediately (C#/C++ style)`
  );
  emitter.emitLine(
    `  // Before running, increment refcount for the "running task" reference`
  );
  emitter.emitLine(
    `  // This ensures the task stays alive until completion, even if user drops early`
  );
  emitter.emitLine(`  __yo_incr_rc((void*)sm);  // refcount: 1 -> 2`);
  emitter.emitLine(`  ${resumeFunctionName}(sm);`);
  emitter.emitLine(``);

  emitter.emitLine(`  return sm;`);
  emitter.emitLine(`}`);
  emitter.emitLine(``);
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
function generateThreadSpawnCall(
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
    ? sanitizeForCIdentifier(cbArg.$.variableName)
    : cbArgCode;

  // Emit code to heap-allocate a copy of the closure data
  // The thread entry wrapper will free this after the closure runs
  const heapDataVar = `_thread_closure_data_${randomId()}`;
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
function generateWorkerSpawnCall(
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
    ? sanitizeForCIdentifier(cbArg.$.variableName)
    : cbArgCode;

  // Emit code to heap-allocate a copy of the closure data
  // The worker thread will free this after the task runs
  const heapDataVar = `_worker_closure_data_${randomId()}`;
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
function generateDynCall(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!expr.$?.dynCallModuleValues || expr.$.dynCallModuleValues.length === 0) {
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

  // Get the module value from dynCallModuleValues
  const moduleValues = expr.$.dynCallModuleValues;
  if (!moduleValues || moduleValues.length === 0) {
    return `/* Error: dyn() call missing module values */`;
  }

  // For now, assume single module (no multiple traits yet)
  const moduleValue = moduleValues[0];
  if (!moduleValue) {
    return `/* Error: Invalid module value */`;
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
  // Prefer the corresponding FnModuleType's C name so generated symbols are stable.
  const concreteTypeCName = (() => {
    const direct = context.types[concreteType.id]?.cName;
    if (direct) {
      return direct;
    }
    const fnModule = extractFnModuleFromType(concreteType);
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
    moduleValue,
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

/**
 * Generate C code for an atom expression - extracted from original codegen-c.ts
 */
function generateAtom(expr: AtomExpr, context: CodeGenContext): string {
  const functionContext = context as FunctionGenerationContext;

  // Handle control flow atoms first (before checking unit type or other values)
  // These need to return the keyword string even though they have unit type

  // Handle control flow atoms first (before checking computed values or variable names)
  if (expr.token.value === "continue") {
    return "continue";
  }

  if (expr.token.value === "break") {
    return "break";
  }

  if (expr.token.value === "return") {
    return "return";
  }

  // For unit-typed expressions (excluding control flow which was handled above), return empty string
  if (expr.$?.type && isUnitType(expr.$.type)) {
    return "";
  }

  // Check if we're in a closure function and this variable is captured
  // Type assertion to access function-specific context

  // Check if we're in a state machine and this is a captured variable
  if (functionContext.inStateMachine && functionContext.stateMachineVariables) {
    const varName = expr.token.value;

    // Check if this variable is locally shadowed (e.g., in match destructuring)
    // If so, use the local C variable instead of the state machine field
    if (functionContext.localShadowedVariables?.has(varName)) {
      return varName;
    }

    // Check if this variable is in the state machine
    for (const [varId, capturedVar] of functionContext.stateMachineVariables) {
      if (capturedVar.name === varName) {
        // This is a state machine variable - access it through sm->
        // Use kind to determine field name:
        // - "outer": Use __capture.varName (sm->__capture.varName)
        // - "local": Use var_{varId} (sm->var_{varId})
        const fieldName =
          capturedVar.kind === "outer"
            ? `__capture.${varName}`
            : `var_${varId}`;
        return `sm->${fieldName}`;
      }

      // Also check if this variable is the owner of a borrowed variable in the state machine
      // e.g., _temp_123 owns the value, future1 borrows from _temp_123
      // In deferred drops, we drop _temp_123, but in state machine it's stored as sm->var_future1
      if (
        capturedVar.isOwningTheSameGcValueAs &&
        capturedVar.isOwningTheSameGcValueAs.name === varName
      ) {
        const fieldName =
          capturedVar.kind === "outer"
            ? `__capture.${varName}`
            : `var_${varId}`;
        return `sm->${fieldName}`;
      }
    }

    // Variable not found directly - check if it's borrowing from a captured variable
    // This handles the case where we reference `future1` but only `temp_2198` (its owner) is captured
    if (expr.$?.env) {
      const variables = getVariablesFromEnv(expr.$.env, varName);
      if (variables.length > 0) {
        const variable = variables[variables.length - 1]!;
        if (variable.isOwningTheSameGcValueAs) {
          // This variable is borrowing - try to find the owner in state machine
          const ownerName = variable.isOwningTheSameGcValueAs.name;
          const ownerId = variable.isOwningTheSameGcValueAs.id;

          for (const [
            varId,
            capturedVar,
          ] of functionContext.stateMachineVariables) {
            if (capturedVar.name === ownerName || varId === ownerId) {
              const fieldName =
                capturedVar.kind === "outer"
                  ? `__capture.${ownerName}`
                  : `var_${varId}`;
              return `sm->${fieldName}`;
            }
          }
        }
      }
    }

    // Variable not in stateMachineVariables - it's a local C variable in the resume function
    // Just use the variable name (don't regenerate its value)
    if (expr.$?.variableName) {
      return sanitizeForCIdentifier(expr.$.variableName);
    }
  }

  // If this atom has a temp variable name (e.g., for Gc values), use that instead of regenerating code
  // This prevents regenerating constructor calls for temp variables that should just use their variable names
  // BUT: if this is a captured variable in a closure, we should use closure access instead
  // ALSO: if this is a compile-time only variable with a value, inline it instead
  if (expr.$?.variableName) {
    // Check if this is a compile-time only variable - if so, inline the value
    if (expr.$?.env && expr.$?.value && !isUnknownValue(expr.$.value)) {
      const variables = getVariablesFromEnv(expr.$.env, expr.$.variableName);
      if (
        variables.length > 0 &&
        variables[variables.length - 1]!.isCompileTimeOnly
      ) {
        return generateComptValue(expr.$.value, context, expr);
      }
    }

    // Check if this is a captured variable in a closure - if so, don't use temp variable name
    if (
      functionContext.currentClosureCaptures &&
      functionContext.currentClosureCaptures.includes(expr.token.value) &&
      expr.$?.env &&
      functionContext.currentClosureCaptureFrameLevel !== undefined &&
      checkVariableIsClosureCaptured(
        expr.token.value,
        expr.$.env,
        functionContext.currentClosureCaptureFrameLevel
      )
    ) {
      // Don't return early - let it fall through to closure capture logic
    } else {
      // Check if this variable has a parameterAlias
      const varNameToUse = getVariableNameForCodegen(
        expr.$.variableName,
        expr.$?.env
      );
      return sanitizeForCIdentifier(varNameToUse);
    }
  }

  // Check if this atom has a compile-time value
  // This is only reached for closure-captured variables (non-closure variables return early above)
  // For closure-captured variables, we should NOT inline their values - we access them via closure context
  // So this code path should never actually inline a value for variables
  if (expr.$?.value) {
    if (isUnknownValue(expr.$.value)) {
      throw new Error(
        `Cannot generate code for unknown compile-time value of atom: ${exprToString(expr)}`
      );
    }
    // Only inline if this is NOT a variable (e.g., it's a literal constant without a variable name)
    // But all variables should have been handled above, so this is just for safety
    return generateComptValue(expr.$.value, context, expr);
  }

  const isClosureCaptured =
    expr.$?.env && functionContext.currentClosureCaptureFrameLevel !== undefined
      ? checkVariableIsClosureCaptured(
          expr.token.value,
          expr.$.env,
          functionContext.currentClosureCaptureFrameLevel
        )
      : false;

  if (
    functionContext.currentClosureCaptures &&
    functionContext.currentClosureCaptures.includes(expr.token.value) &&
    functionContext.currentClosureCaptureFrameLevel !== undefined &&
    (expr.$?.env ? isClosureCaptured : true) // If no env info, trust currentClosureCaptures
  ) {
    // We're accessing a captured variable in a closure function
    // The closure_context parameter is a void* that points directly to the capture struct
    // Need to cast it to the appropriate capture struct type
    const captureTypeCName = functionContext.currentClosureCaptureTypeCName;
    if (captureTypeCName) {
      // Cast void* closure_context directly to the capture struct pointer
      return `((${captureTypeCName}*)closure_context)->${sanitizeForCIdentifier(expr.token.value)}`;
    }
    // Fallback to old approach if we can't determine the type (should not happen)
    return `closure_context->${sanitizeForCIdentifier(expr.token.value)}`;
  }

  // Fallback: Check if this is a closure function by looking at the current function name and finding its type
  if (
    functionContext.currentFunctionName &&
    !functionContext.currentClosureCaptures
  ) {
    // Find the function value being generated
    const currentFunctionEntry = Object.values(functionContext.functions).find(
      (entry) => entry.cName === functionContext.currentFunctionName
    );

    if (currentFunctionEntry && currentFunctionEntry.value.type.isClosure) {
      // This is a closure function, find its closure type
      const closureTypeEntry = Object.values(functionContext.types).find(
        (t) =>
          isFunctionType(t.type) &&
          t.type.isClosure &&
          t.type === currentFunctionEntry.value.type
      );

      if (closureTypeEntry) {
        // Note: captureType is no longer on ClosureType, use naming convention
        const captureStructName = `${closureTypeEntry.cName}_capture`;
        return `((${captureStructName}*)closure_context->data)->${sanitizeForCIdentifier(expr.token.value)}`;
      }
    }
  }

  // Check if this variable has a parameterAlias (used in anonymous functions
  // where the actual parameter name differs from the expected interface parameter name)
  const varNameToUse = getVariableNameForCodegen(expr.token.value, expr.$?.env);
  return sanitizeForCIdentifier(varNameToUse);
}

/**
 * Generate C code for a compile-time value - extracted from original codegen-c.ts
 */
function generateComptValue(
  value: Value,
  context: CodeGenContext,
  _sourceExpr?: Expr
): string {
  if (isNumberValue(value)) {
    // For numbers, we can directly return the value as a string
    return valueToString(value);
  } else if (isBooleanValue(value)) {
    // For booleans, return true/false
    return value.value ? "true" : "false";
  } else if (isComptStringValue(value)) {
    // Check if there's a converted runtime type (e.g., compt_string -> [u8]
    const targetType =
      _sourceExpr?.$?.convertedRuntimeType || _sourceExpr?.$?.type;

    // Check if the target type is a pointer to a slice (e.g., [u8]
    // In Yo, [u8] is a fat pointer (slice value), not a pointer to a slice struct
    // So we generate a slice struct value directly
    if (targetType && isPtrType(targetType)) {
      const childType = targetType.childType;
      if (isSliceType(childType)) {
        const sliceCType = getTypeString(childType, context);
        const stringLiteral = JSON.stringify(value.value);
        const stringLength = Buffer.byteLength(value.value, "utf8");

        // Generate slice struct value (fat pointer)
        return `(${sliceCType}){ .data = (uint8_t*)${stringLiteral}, .length = ${stringLength} }`;
      }
    }

    // For regular strings, return the C string literal with proper escaping
    return JSON.stringify(value.value);
  } else if (isEnumValue(value)) {
    // For enums, check if it's optimized as nullable pointer
    const enumType = value.type;
    const nullablePointerType = canOptimizeAsNullablePointer(enumType);

    if (nullablePointerType) {
      // Generate optimized nullable pointer construction
      const variant = enumType.variants.find(
        (v) => v.name === value.variantName
      );
      if (!variant) {
        return `// Error: Variant ${value.variantName} not found in enum`;
      }

      if (!variant.fields || variant.fields.length === 0) {
        // This is the null case (None variant)
        return "NULL";
      } else if (variant.fields.length === 1 && value.fields.length === 1) {
        // This is the pointer case (Some variant)
        return generateComptValue(value.fields[0]!, context);
      }
    }

    // Check if this enum can be optimized as a simple C enum
    const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
    if (simpleEnumOptimizable) {
      // For simple enums, just return the enum constant
      return getEnumVariantCName(enumType, value.variantName, context);
    }

    // Generate regular tagged union construction
    const cName = context.types[enumType.id]?.cName;
    if (!cName) {
      return `// Error: No C type name found for enum ${typeToString(enumType)}`;
    }

    const variantTag = getEnumVariantCName(
      enumType,
      value.variantName,
      context
    );

    if (!value.fields || value.fields.length === 0) {
      // Variant with no data
      return `(${cName}){ .tag = ${variantTag} }`;
    } else {
      // Variant with data
      const variant = enumType.variants.find(
        (v) => v.name === value.variantName
      );
      if (!variant || !variant.fields) {
        return `// Error: Variant ${value.variantName} not found or has no fields`;
      }

      // Filter out unit type fields
      const nonUnitFields = value.fields
        .map((field, index) => {
          const variantElement = variant.fields![index];
          if (variantElement && !isUnitType(variantElement.type)) {
            const fieldName = sanitizeForCIdentifier(variantElement.label);
            const fieldCode = generateComptValue(field, context);
            return `.${fieldName} = ${fieldCode}`;
          }
          return null;
        })
        .filter((f) => f !== null);

      // If all fields are unit types, just return the tag
      if (nonUnitFields.length === 0) {
        return `(${cName}){ .tag = ${variantTag} }`;
      }

      return `(${cName}){ .tag = ${variantTag}, .data = { .${value.variantName} = { ${nonUnitFields.join(", ")} } } }`;
    }
  } else if (isStructValue(value)) {
    // For structs, we need to generate a struct initialization
    const type = value.type;
    if (type && isStructType(type)) {
      const cName = context.types[type.id]?.cName;
      if (!cName) {
        return `// Error: No C type name found for struct ${typeToString(type)}\n`;
      }

      // Handle newtype as zero-cost abstraction
      if (
        type.isNewtype &&
        type.fields.length === 1 &&
        value.fields.length === 1
      ) {
        // For newtype, just use the underlying value with a cast
        const underlyingValue = generateComptValue(value.fields[0]!, context);
        return `((${cName})(${underlyingValue}))`;
      }

      if (type.isReferenceSemantics) {
        // For object compile-time values, use constructor function
        const fieldValues = value.fields.map((field) =>
          generateComptValue(field, context)
        );

        const constructorName = `__yo_new_${cName}`;
        return `${constructorName}(${fieldValues.join(", ")})`;
      } else {
        // For regular struct compile-time values, generate as before
        const fields = value.fields.map((field, index) => {
          const fieldValue = field;
          const fieldName = sanitizeForCIdentifier(type.fields[index]!.label);
          const fieldCode = generateComptValue(fieldValue, context);
          return `.${fieldName} = ${fieldCode}`;
        });

        return `(${cName}){ ${fields.join(", ")} }`;
      }
    }
  } else if (isArrayValue(value)) {
    // For array values, generate struct wrapper initialization
    const arrayType = value.type;
    const arrayTypeName = getTypeString(arrayType, context);
    const elementCodes = value.elements.map((element) =>
      generateComptValue(element, context)
    );
    return `(${arrayTypeName}){ .data = { ${elementCodes.join(", ")} } }`;
  } else if (isFunctionValue(value)) {
    // For function values, we need to register them and return their C function name
    const cName = context.functions[value.funcId]?.cName;
    if (cName) {
      return cName; // Return the function name as a function pointer
    } else {
      return `// Error: No C function name found for function value with ID ${value.funcId}\n`;
    }
  } else if (isTypeValue(value)) {
    // For type values, we can return the C type name if available
    const type = value.value;
    if (type) {
      if (context.types[type.id]) {
        return context.types[type.id]!.cName;
      } else {
        return `/* Error: No C type name found for type ${typeToString(type)} */`;
      }
    }
  }

  return ""; // No need to generate. It might be module value, etc
}

/**
 * Generate field access for structs, unions, and enums - extracted from original codegen-c.ts
 */
function generateFieldAccess(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (expr.args.length !== 2) {
    return "/* ERROR: field access requires exactly 2 arguments */";
  }

  const objectExpr = expr.args[0];
  const fieldExpr = expr.args[1];

  if (!objectExpr || !fieldExpr) {
    return "/* ERROR: invalid field access arguments */";
  }

  const objectCode = generateExpr(objectExpr, indent, context);
  const objectType = objectExpr.$?.type;
  const objectValue = objectExpr.$?.value;

  if (exprIsAtom(fieldExpr)) {
    const fieldName = fieldExpr.token.value;

    // Check if this field access is actually a method access (function from type's module or nested modules)
    // This includes both direct type methods and methods from nested modules
    if (expr.$?.value && isFunctionValue(expr.$.value)) {
      const functionValue = expr.$.value;
      const cFunctionName =
        context.functions[functionValue.funcId]?.cName || functionValue.funcId;
      return cFunctionName;
    }

    // Fallback: Check if this is an Gc method call (___drop, ___dup, ___dispose)
    // Sometimes, we only called addARCFunctionSignaturesToStructType / addARCFunctionSignaturesToEnumType
    // So they are using the `undefined` function value, before we actually update its module fields.
    if (
      !expr.$?.value &&
      (BuiltinFunctions.___dispose.includes(fieldName) ||
        BuiltinFunctions.___drop.includes(fieldName) ||
        BuiltinFunctions.___dup.includes(fieldName)) &&
      objectType
    ) {
      // For Gc methods, we need to look up the function from the type's module
      // and return the function name directly instead of treating it as field access
      let typeModule: ModuleType | null = null;

      if (isStructType(objectType)) {
        typeModule = objectType.module;
      } else if (isEnumType(objectType)) {
        typeModule = objectType.module;
      }

      if (typeModule) {
        // Find the function in the type's module
        const functionElement = typeModule.fields.find(
          (field) =>
            field.label === fieldName &&
            field.assignedValue &&
            isFunctionValue(field.assignedValue)
        );

        if (functionElement && isFunctionValue(functionElement.assignedValue)) {
          const functionValue = functionElement.assignedValue;
          const cFunctionName =
            context.functions[functionValue.funcId]?.cName ||
            functionValue.funcId;
          return cFunctionName;
        } else {
          return `/* ERROR: Gc method ${fieldName} not found in type module */`;
        }
      } else {
        return `/* ERROR: No module found for Gc method ${fieldName} */`;
      }
    }

    // Handle newtype field access - just return the object itself (zero-cost abstraction)
    if (isNewtypeType(objectType) && objectType.fields.length === 1) {
      // For newtype, accessing the single field just returns the value itself
      // since newtype is typedef'd to the underlying type
      const singleField = objectType.fields[0];
      if (singleField && singleField.label === fieldName) {
        return objectCode;
      }
    }

    // Check if the object is an enum type
    if (isEnumType(objectType)) {
      const enumType = objectType;

      // Check if this enum is optimized as a nullable pointer
      const nullablePointerType = canOptimizeAsNullablePointer(enumType);
      if (nullablePointerType) {
        // For optimized nullable pointer enums, direct field access should be simplified
        // ptr.value becomes ptr (since ptr is already the pointer)
        // NOTE: No need to check fieldName, as the nullablePointerType always only has one field
        // if (fieldName === "value") {
        return objectCode; // Return the pointer directly
        // }
      }

      // For enum field access, we need to determine which variant contains this field
      // and generate the appropriate path: object.data.VariantName.fieldName
      for (const variant of enumType.variants) {
        if (variant.fields) {
          for (const field of variant.fields) {
            if (field.label === fieldName) {
              // Found the field in this variant
              const variantName = variant.name;
              return `${objectCode}.data.${variantName}.${sanitizeForCIdentifier(fieldName)}`;
            }
          }
        }
      }

      return `/* ERROR: field ${fieldName} not found in enum ${enumType.typeName} */`;
    } else if (isTypeValue(objectValue) && isEnumType(objectValue.value)) {
      const enumType = objectValue.value;
      const variant = enumType.variants.find((v) => v.name === fieldName);
      const cName = context.types[enumType.id]?.cName;

      // Accessing variant that has no fields.
      // Like: Color.Red
      if (!!variant && !variant.fields && cName) {
        const tagName = getEnumVariantCName(enumType, variant.name, context);
        return `(${cName}){ .tag = ${tagName}, .data = {  } }`;
      }
    }
    // Special handling for slice types: even if they appear as pointer types in AST,
    // they should use dot notation because we generate them as struct values
    else if (isPtrType(objectType) && isSliceType(objectType.childType)) {
      // For slice types, always use dot notation regardless of pointer level in AST
      return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
    }
    // Check if the object is pointer or reference
    else if (isPtrType(objectType)) {
      if (fieldName === "*") {
        // Regular dereference for pointers/references
        // Ensure proper parenthesization: (*ptr) not *(ptr)
        return `(*${objectCode})`; // Dereference the pointer/reference
      } else {
        // Dereference until not a pointer/reference
        let dereferenceLevel = 0;
        let currentType: Type = objectType;
        while (isPtrType(currentType)) {
          dereferenceLevel++;
          currentType = currentType.childType;
        }

        // IMPORTANT: For reference-semantics types (objects), the type is already a pointer in C.
        // So *(MyBox) in Yo becomes MyBox** in C, which requires 2 dereferences, not 1.
        // We need to add an extra dereference level for reference-semantics types.
        if (
          dereferenceLevel > 0 &&
          isStructType(currentType) &&
          currentType.isReferenceSemantics
        ) {
          dereferenceLevel++;
        }

        // Check if the dereferenced type is a newtype accessing its single field
        if (isNewtypeType(currentType) && currentType.fields.length === 1) {
          const singleField = currentType.fields[0];
          if (singleField && singleField.label === fieldName) {
            // For newtype, accessing the single field through a pointer just dereferences the pointer
            // since newtype is typedef'd to the underlying type
            if (dereferenceLevel === 1) {
              return `(*${objectCode})`;
            } else {
              return `${"*".repeat(dereferenceLevel)}(${objectCode})`;
            }
          }
        }

        if (dereferenceLevel > 0) {
          // For pointer types, use arrow notation for field access
          if (dereferenceLevel === 1) {
            return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
          } else {
            // Multiple levels of dereference: (*ptr)->field for ptr**
            // Need to parenthesize the dereferenced expression to get correct precedence
            const dereferencedObjectCode = `(${"*".repeat(dereferenceLevel - 1)}${objectCode})`;
            return `${dereferencedObjectCode}->${sanitizeForCIdentifier(fieldName)}`;
          }
        } else {
          // If no dereferencing is needed, just access the field
          return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
        }
      }
    }
    // For tuple type, we need to convert the field to index
    else if (isTupleType(objectType)) {
      if (fieldName.match(/^\d+$/)) {
        return `${objectCode}._${fieldName}`;
      } else {
        const index = objectType.fields.findIndex(
          (field) => field.label === fieldName
        );
        return `${objectCode}._${index}`;
      }
    }
    // Handle dynamic dispatch method access
    else if (isDynType(objectType)) {
      // For dyn types, access methods through vtable
      // e.g. s.speak becomes s.vtable->speak (Dyn is value type, vtable is pointer)
      return `${objectCode}.vtable->${sanitizeForCIdentifier(fieldName)}`;
    } else {
      // For C structs and unions, access fields directly
      // Check if this is a reference-counted type (object)
      if (isObjectType(objectType)) {
        // For ref types (pointers), access field directly: ptr->field
        return `${objectCode}->${sanitizeForCIdentifier(fieldName)}`;
      } else {
        // For regular structs/enums, access fields directly
        return `${objectCode}.${sanitizeForCIdentifier(fieldName)}`;
      }
    }
  }

  return "/* ERROR: field name must be an identifier */";
}

/**
 * Generate a conditional expression (cond) as a value expression - extracted from original codegen-c.ts
 */
function generateCondExpression(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  // Check if the cond expression has been evaluated and has a variable name
  if (expr.$) {
    const tempVar = expr.$.variableName;
    const valueType = expr.$.type;
    const isUnit = valueType && isUnitType(valueType);

    // For unit types, don't declare a temporary variable
    if (!isUnit && tempVar) {
      const varType = getTypeString(valueType, context);
      context.emitter.emitLine(`${indent}${varType} ${tempVar};`);
    }

    // Generate if-else chain for each condition => value pair
    // Strategy:
    // - If all conditions before a compile-time true are compile-time false, just generate the value directly
    // - Otherwise: First condition becomes `if (...) {}`, all subsequent become nested in a single `else { ... }`

    // First pass: check if we can optimize to direct value generation
    let firstNonFalseBranchIndex = -1;
    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        const condition = arg.args[0];
        if (condition) {
          const isFalse =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false;
          if (!isFalse) {
            firstNonFalseBranchIndex = i;
            break;
          }
        }
      }
    }

    // Check if the first non-false branch is a compile-time true
    let canOptimizeToDirect = false;
    if (firstNonFalseBranchIndex >= 0) {
      const firstArg = expr.args[firstNonFalseBranchIndex];
      if (
        firstArg &&
        exprIsFunctionCall(firstArg) &&
        exprIsFunctionCallOf(firstArg, "=>", 2)
      ) {
        const firstCondition = firstArg.args[0];
        if (
          firstCondition &&
          isBooleanValue(firstCondition.$?.value) &&
          firstCondition.$.value.value === true
        ) {
          canOptimizeToDirect = true;
        }
      }
    }

    // If we can optimize to direct generation, just generate the value expression
    if (canOptimizeToDirect && firstNonFalseBranchIndex >= 0) {
      const arg = expr.args[firstNonFalseBranchIndex];
      if (
        arg &&
        exprIsFunctionCall(arg) &&
        exprIsFunctionCallOf(arg, "=>", 2)
      ) {
        const value = arg.args[1];
        if (value) {
          // Generate the value expression directly
          const valueCode = generateExpr(value, indent, context);

          // Check if we need to assign to temp variable
          if (tempVar && !isUnit) {
            if (
              valueCode &&
              valueCode !== "" &&
              valueCode !== "continue" &&
              valueCode !== "break" &&
              !valueCode.includes("return")
            ) {
              context.emitter.emitLine(`${indent}${tempVar} = ${valueCode};`);
            }
          }
        }
      }

      // For unit types, return empty string; for others, return temp variable
      return isUnit ? "" : (tempVar ?? "");
    }

    // Otherwise, generate full if-else chain
    let currentIndent = indent;
    let elseBlockDepth = 0; // Track how many else blocks we need to close at the end
    let hasEmittedBranch = false; // Track whether we've emitted any branch (not skipped)

    for (let i = 0; i < expr.args.length; i++) {
      const arg = expr.args[i];
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=>", 2)) {
        // This is a condition => value pair
        const condition = arg.args[0];
        const value = arg.args[1];

        if (condition && value) {
          // Skip compile-time false conditions
          if (
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === false
          ) {
            continue;
          }

          // For the first EMITTED branch, generate `if (...) {}` or just `{}`
          if (!hasEmittedBranch) {
            if (
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true
            ) {
              // Compile-time true as first condition - just use a block
              context.emitter.emitLine(`${currentIndent}{`);
            } else {
              // Regular condition
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
            hasEmittedBranch = true;
          } else {
            // For subsequent conditions, wrap in `else {` and increment depth
            context.emitter.emitLine(`${currentIndent}else {`);
            elseBlockDepth++;
            currentIndent += "  ";

            const isCompileTimeTrue =
              isBooleanValue(condition.$?.value) &&
              condition.$.value.value === true;

            if (isCompileTimeTrue) {
              // Compile-time true - no condition needed, value goes directly in the else block
              // We'll close the else block at the end, not here
            } else {
              // Regular condition - generate if inside the else block
              const conditionCode = generateExpr(
                condition,
                currentIndent,
                context
              );
              context.emitter.emitLine(
                `${currentIndent}if (${conditionCode}) {`
              );
            }
          }

          // Determine the indent for the value block
          const isCompileTimeTrue =
            isBooleanValue(condition.$?.value) &&
            condition.$.value.value === true;

          // For compile-time true in else block (not first branch), don't add extra indentation
          const valueIndent =
            hasEmittedBranch && isCompileTimeTrue
              ? currentIndent
              : currentIndent + "  ";

          // Handle begin blocks specially in conditional expressions
          if (
            exprIsFunctionCall(value) &&
            exprIsFunctionCallOf(value, BuiltinKeywords.begin)
          ) {
            // For begin blocks in conditionals, we need to generate the statements inline
            // like generateLoopBody but also capture the final expression result

            const beginArgs = value.args;

            // Generate each statement except the last one
            for (let j = 0; j < beginArgs.length - 1; j++) {
              const arg = beginArgs[j]!;
              const argCode = generateExpr(arg, valueIndent, context);
              // Skip temp variable references
              if (
                argCode &&
                arg.$ &&
                !isTempVariableName(arg.$.env.modulePath, argCode)
              ) {
                context.emitter.emitLine(`${valueIndent}${argCode};`);
              }
            }

            // Generate the final expression and assign it to temp variable
            if (beginArgs.length > 0) {
              const finalExpr = beginArgs[beginArgs.length - 1]!;
              // Generate deferred dup expressions for the final expression (e.g., returning a borrowed value)
              if (finalExpr.$?.deferredDupExpressions) {
                generateDeferredDupExpressions(
                  finalExpr,
                  valueIndent,
                  context as FunctionGenerationContext
                );
              }
              const finalExprCode = generateExpr(
                finalExpr,
                valueIndent,
                context
              );

              if (finalExprCode) {
                // Check if this is a control flow statement
                if (
                  finalExprCode === "continue" ||
                  finalExprCode === "break" ||
                  (exprIsFunctionCall(finalExpr) &&
                    exprIsFunctionCallOf(finalExpr, BuiltinKeywords.return)) ||
                  finalExprCode.includes("return")
                ) {
                  // For control flow statements, emit them directly without assignment
                  context.emitter.emitLine(`${valueIndent}${finalExprCode};`);
                } else if (tempVar && !isUnit) {
                  context.emitter.emitLine(
                    `${valueIndent}${tempVar} = ${finalExprCode};`
                  );
                }
              }
            }

            // Generate deferred drop expressions for the begin block
            if (value.$?.deferredDropExpressions) {
              generateDeferredDropExpressions(value, valueIndent, context);
            }
          } else {
            // Generate deferred dup expressions for non-begin value expressions
            if (value.$?.deferredDupExpressions) {
              generateDeferredDupExpressions(
                value,
                valueIndent,
                context as FunctionGenerationContext
              );
            }
            // Generate the value expression INSIDE the conditional block
            const valueCode = generateExpr(value, valueIndent, context);

            // Check if this is a control flow statement or unit expression
            if (
              valueCode === "continue" ||
              valueCode === "break" ||
              (exprIsFunctionCall(value) &&
                exprIsFunctionCallOf(value, BuiltinKeywords.return)) ||
              valueCode.includes("return")
            ) {
              // For control flow statements, emit them directly without assignment
              context.emitter.emitLine(`${valueIndent}${valueCode};`);
            } else if (valueCode === "" || !valueCode) {
              // For unit expressions, don't emit anything
            } else if (tempVar) {
              // For regular expressions, assign to temp variable (only if not unit type)
              if (!isUnit) {
                context.emitter.emitLine(
                  `${valueIndent}${tempVar} = ${valueCode};`
                );
              }
            }
          }

          // Close the if/block for this condition
          // For compile-time true in an else block, we don't close anything here (the else block closes at the end)
          // For all other cases, close the if block or the initial block
          const needsClosing = !(hasEmittedBranch && isCompileTimeTrue);
          if (needsClosing) {
            context.emitter.emitLine(`${currentIndent}}`);
          }
        }
      }
    }

    // Close all the else blocks we opened
    for (let i = 0; i < elseBlockDepth; i++) {
      currentIndent = currentIndent.slice(0, -2); // Remove 2 spaces
      context.emitter.emitLine(`${currentIndent}}`);
    }

    // For unit types, return empty string; for others, return temp variable
    return isUnit ? "" : (tempVar ?? "");
  }

  // Fallback for non-evaluated expressions
  return '/* "cond" expression is not evaluated */';
}

/**
 * Generate a match expression as a value (C switch statement) - extracted from original codegen-c.ts
 */
function generateMatchExpression(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!expr.$) {
    return `/* "match" expression is not evaluated */`;
  }
  const tempVariableName = expr.$.variableName;
  const valueType = expr.$.type;
  const isUnit = valueType && isUnitType(valueType);

  // Create temp variable declaration
  if (!isUnit && tempVariableName) {
    const varType = getTypeString(valueType, context);
    context.emitter.emitLine(`${indent}${varType} ${tempVariableName};`);
  }

  // Generate the matched value
  const matchedValueCode = generateExpr(expr.args[0]!, indent, context);
  const matchValueType = expr.args[0]!.$?.type;
  if (!matchValueType) {
    return `// Error: "match" expression requires an enum type`;
  }

  // Check if it's a pointer/reference type OR reference semantics type
  // If yes, then automatically dereference one-level of it.
  let ptrOrRefType: TypeTag.Ptr | "ref_semantics" | undefined = undefined;

  let enumType: Type;
  if (isPtrType(matchValueType)) {
    enumType = matchValueType.childType;
    ptrOrRefType = matchValueType.tag;
  } else if (isObjectType(matchValueType)) {
    // ref enum types are represented as pointers in C
    enumType = matchValueType;
    ptrOrRefType = "ref_semantics";
  } else {
    enumType = matchValueType;
  }

  if (!isEnumType(enumType)) {
    return `// Error: "match" expression requires an enum type`;
  }
  const enumCName = context.types[enumType.id]?.cName;
  if (!enumCName) {
    return `// Error: "match" expression enum type ${enumType.typeName} has no C name`;
  }

  // Check if this enum is optimized as a nullable pointer
  const nullablePointerType = canOptimizeAsNullablePointer(enumType);
  if (nullablePointerType) {
    // Generate optimized nullable pointer matching using if/else instead of switch
    const caseExprs = expr.args.slice(1);

    // Find which variant is the null case and which is the pointer case
    let nullCase: { caseBody: Expr } | null = null;
    let pointerCase: {
      caseBody: Expr;
      variantName: string;
      casePattern: Expr;
    } | null = null;

    for (const caseExpr of caseExprs) {
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        const caseValue = caseExpr.args[0]!; // .None, .Some(ptr)
        const caseBody = caseExpr.args[1]!;

        if (
          caseValue &&
          caseBody &&
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".") // Destructuring pattern like .None
        ) {
          nullCase = { caseBody };
        } else {
          // Destructuring pattern like .Some(value)
          // Handle destructuring pattern
          const variantExpr = (caseValue as FuncCallExpr).func;
          // Check if variant is a field access like .Some
          if (
            variantExpr &&
            exprIsFunctionCall(variantExpr) &&
            exprIsFunctionCallOf(variantExpr, ".")
          ) {
            const variantNameExpr = variantExpr.args[0]!;
            if (variantNameExpr && exprIsAtom(variantNameExpr)) {
              const variantName = variantNameExpr.token.value;
              pointerCase = {
                caseBody,
                variantName,
                casePattern: caseValue,
              };
            }
          }
        }
      }
    }

    // Generate the optimized if/else structure
    context.emitter.emitLine(
      `${indent}if (${ptrOrRefType && ptrOrRefType !== "ref_semantics" ? "*" : ""}${matchedValueCode} != NULL) {`
    );

    if (pointerCase) {
      // For nullable pointer optimization with destructuring pattern like .Some(value),
      // we need to bind the destructured variable to the pointer value
      let destructuredVarName: string | undefined;
      if (
        exprIsFunctionCall(pointerCase.casePattern) &&
        pointerCase.casePattern.args.length > 0
      ) {
        // Destructuring pattern: .Some(value)
        const destructuredVar = pointerCase.casePattern.args[0];
        if (destructuredVar && exprIsAtom(destructuredVar)) {
          destructuredVarName = destructuredVar.token.value;
          const varType = nullablePointerType;
          // Declare and bind the destructured variable to the pointer
          context.emitter.emitLine(
            `${indent}  ${getTypeString(varType, context)} ${destructuredVarName} = ${matchedValueCode};`
          );
        }
      }

      // Add destructured variable to localShadowedVariables so it uses the local C var
      const functionContext = context as FunctionGenerationContext;
      if (destructuredVarName && functionContext.inStateMachine) {
        if (!functionContext.localShadowedVariables) {
          functionContext.localShadowedVariables = new Set();
        }
        functionContext.localShadowedVariables.add(destructuredVarName);
      }

      const bodyCode = generateCaseBody(
        pointerCase.caseBody,
        indent + "  ",
        context
      );

      // Remove destructured variable from localShadowedVariables after generating body
      if (destructuredVarName && functionContext.localShadowedVariables) {
        functionContext.localShadowedVariables.delete(destructuredVarName);
      }

      // Check if body has control flow (return, break, continue) - don't assign temp in that case
      const hasControlFlow =
        bodyCode === "" ||
        bodyCode === "break" ||
        bodyCode === "continue" ||
        bodyCode.includes("return");
      if (!isUnit && tempVariableName && !hasControlFlow) {
        // For nullable pointer match, the body returns the actual value
        // If bodyCode is empty or just returns the matched value itself, use the matched value
        const resultCode = bodyCode || matchedValueCode;
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${resultCode};`
        );
      } else if (bodyCode && bodyCode !== "") {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}} else {`);

    if (nullCase) {
      const bodyCode = generateCaseBody(
        nullCase.caseBody,
        indent + "  ",
        context
      );
      // Check if body has control flow (return, break, continue) - don't assign temp in that case
      const hasControlFlow =
        bodyCode === "" ||
        bodyCode === "break" ||
        bodyCode === "continue" ||
        bodyCode.includes("return");
      if (!isUnit && tempVariableName && !hasControlFlow) {
        context.emitter.emitLine(
          `${indent}  ${tempVariableName} = ${bodyCode};`
        );
      } else if (bodyCode && bodyCode !== "") {
        context.emitter.emitLine(`${indent}  ${bodyCode};`);
      }
    }

    context.emitter.emitLine(`${indent}}`);
    return isUnit ? "" : (tempVariableName ?? "");
  }

  // Check if this enum can be optimized as a simple C enum
  const simpleEnumOptimizable = canOptimizeAsSimpleEnum(enumType);
  if (simpleEnumOptimizable) {
    // Generate optimized simple enum matching
    context.emitter.emitLine(
      `${indent}switch (${ptrOrRefType && ptrOrRefType !== "ref_semantics" ? "*" : ""}${matchedValueCode}) {`
    );

    const caseExprs = expr.args.slice(1);
    for (let i = 0; i < caseExprs.length; i++) {
      const caseExpr = caseExprs[i];
      if (
        exprIsFunctionCall(caseExpr) &&
        exprIsFunctionCallOf(caseExpr, "=>", 2)
      ) {
        // This is a case => value pair
        const caseValue = caseExpr.args[0];
        const caseBody = caseExpr.args[1];

        if (
          caseValue &&
          caseBody &&
          exprIsFunctionCall(caseValue) &&
          exprIsFunctionCallOf(caseValue, ".", 1)
        ) {
          const variantName = caseValue.args[0]!.token.value;
          const variantTag = getEnumVariantCName(
            enumType,
            variantName,
            context
          );

          // Generate the case label
          context.emitter.emitLine(`${indent}case ${variantTag}:`);

          // Generate the body of the case
          const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
          if (!isUnit && tempVariableName && bodyCode) {
            context.emitter.emitLine(
              `${indent}  ${tempVariableName} = ${bodyCode};`
            );
          } else if (bodyCode) {
            context.emitter.emitLine(`${indent}  ${bodyCode};`);
          }

          // Check if we need to break out of the loop instead of just the switch
          if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
            context.emitter.emitLine(
              `${indent}  goto ${context.currentLoopLabel};`
            );
          } else if (
            context.currentLoopLabel &&
            caseBody.$?.controlFlow === "continue"
          ) {
            // For continue, we still need to break the switch, then the loop will continue naturally
            // But actually, continue should jump to the beginning of the loop
            // We'll just use break here and let the loop continue on its own
            context.emitter.emitLine(`${indent}  break;`);
          } else {
            context.emitter.emitLine(`${indent}  break;`);
          }
        }
      }
    }

    context.emitter.emitLine(`${indent}}`);
    return isUnit ? "" : (tempVariableName ?? "");
  }

  // Original tagged union matching
  context.emitter.emitLine(
    `${indent}switch (${ptrOrRefType === "ref_semantics" || ptrOrRefType ? matchedValueCode + "->tag" : "(" + matchedValueCode + ").tag"}) {`
  );

  const caseExprs = expr.args.slice(1);
  for (let i = 0; i < caseExprs.length; i++) {
    const caseExpr = caseExprs[i];
    if (
      exprIsFunctionCall(caseExpr) &&
      exprIsFunctionCallOf(caseExpr, "=>", 2)
    ) {
      // This is a case => value pair
      const caseValue = caseExpr.args[0];
      let caseBody = caseExpr.args[1];

      if (
        caseValue &&
        caseBody &&
        // caseValue now has to be a variant:
        exprIsFunctionCall(caseValue) &&
        caseValue.func.tag === ExprTag.Atom &&
        caseValue.func.token.value === "." &&
        caseValue.args.length >= 1 // Allow 1 or more arguments for destructuring
      ) {
        const variantName = caseValue.args[0]!.token.value; // Get the variant name
        const variantTag = getEnumVariantCName(enumType, variantName, context);

        // Generate the case label
        context.emitter.emitLine(`${indent}case ${variantTag}:`);

        // Handle destructuring patterns like .Point(point) => { ... }
        if (caseValue.args.length > 1) {
          // This is a destructuring pattern
          const variant = enumType.variants.find((v) => v.name === variantName);
          if (variant && variant.fields) {
            // Generate local variable declarations for destructured fields
            for (
              let fieldIndex = 0;
              fieldIndex <
              Math.min(caseValue.args.length - 1, variant.fields.length);
              fieldIndex++
            ) {
              const destructuredVar = caseValue.args[fieldIndex + 1]!; // Skip the variant name
              const variantElement = variant.fields[fieldIndex];

              if (destructuredVar.tag === ExprTag.Atom && variantElement) {
                // Skip unit type fields - they don't exist in the generated struct
                if (isUnitType(variantElement.type)) {
                  continue;
                }

                const varName = destructuredVar.token.value;
                const fieldName = sanitizeForCIdentifier(variantElement.label);
                const fieldType = getTypeString(variantElement.type, context);

                // Generate variable declaration and assignment
                const accessPrefix =
                  ptrOrRefType === "ref_semantics" || ptrOrRefType ? "->" : ".";
                context.emitter.emitLine(
                  `${indent}  /* MARKER: Generating destructured variable ${varName} */`
                );
                context.emitter.emitLine(
                  `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                );
                // Check if this variable needs to be stored in the state machine
                // For async contexts, pattern-matched variables that are used across await points
                // need to be stored in the state machine structure
                const functionContext = context as FunctionGenerationContext;
                if (
                  functionContext?.inStateMachine &&
                  functionContext.stateMachineVariables
                ) {
                  // Find the variable ID by searching through state machine variables
                  // The state machine tracks variables by their ID
                  let varId: string | undefined;

                  // Try to get ID from expr metadata if available
                  // if (destructuredVar.$?.id) {
                  //   varId = destructuredVar.$.id;
                  // } else
                  if (destructuredVar.$?.env) {
                    // Try to look up in environment
                    const vars = getVariablesFromEnv(
                      destructuredVar.$.env,
                      varName
                    );
                    if (vars.length > 0) {
                      varId = vars[vars.length - 1]!.id;
                    }
                  }

                  if (
                    varId &&
                    functionContext.stateMachineVariables.has(varId)
                  ) {
                    // This variable crosses an await boundary, store it in state machine
                    context.emitter.emitLine(
                      `${indent}  sm->var_${varId} = ${varName};`
                    );
                  }
                }
              }
            }
          }
        }

        if (
          exprIsFunctionCall(caseBody) &&
          exprIsFunctionCallOf(caseBody, "=>", 2)
        ) {
          const renameExpr = caseBody.args[0]!;
          context.emitter.emitLine(
            `${indent}  ${getTypeString(matchValueType, context)} ${renameExpr.token.value} = ${matchedValueCode};`
          );

          caseBody = caseBody.args[1]!; // Get the value part of the case
        }

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (!isUnit && tempVariableName && bodyCode) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        // Check if we need to break out of the loop instead of just the switch
        if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
          context.emitter.emitLine(
            `${indent}  goto ${context.currentLoopLabel};`
          );
        } else if (
          context.currentLoopLabel &&
          caseBody.$?.controlFlow === "continue"
        ) {
          context.emitter.emitLine(`${indent}  break;`);
        } else {
          context.emitter.emitLine(`${indent}  break;`);
        }
      }
      // Handle destructuring patterns like .Point(point) => { ... }
      else if (
        caseValue &&
        caseBody &&
        exprIsFunctionCall(caseValue) &&
        exprIsFunctionCall(caseValue.func) &&
        caseValue.func.func.tag === ExprTag.Atom &&
        caseValue.func.func.token.value === "." &&
        caseValue.func.args.length === 1
      ) {
        // Extract variant name from .Point(point) pattern
        const variantName = caseValue.func.args[0]!.token.value;
        const variantTag = getEnumVariantCName(enumType, variantName, context);
        const destructuringParams = caseValue.args;

        // Generate the case label
        context.emitter.emitLine(`${indent}case ${variantTag}:`);

        // Generate local variable declarations for destructured fields
        const variant = enumType.variants.find((v) => v.name === variantName);
        if (variant && variant.fields && destructuringParams.length > 0) {
          for (
            let fieldIndex = 0;
            fieldIndex <
            Math.min(destructuringParams.length, variant.fields.length);
            fieldIndex++
          ) {
            const destructuredVar = destructuringParams[fieldIndex]!;
            const variantElement = variant.fields[fieldIndex];

            if (destructuredVar.tag === ExprTag.Atom && variantElement) {
              const varName = destructuredVar.token.value;

              // Skip if variable name is "_" (ignore pattern)
              if (varName !== "_") {
                // For unit type fields, generate a comment instead of a variable
                // This allows the variable name to be "declared" without generating invalid C
                if (isUnitType(variantElement.type)) {
                  context.emitter.emitLine(
                    `${indent}  // ${varName} is unit type (no value)`
                  );
                  // Register this as a unit variable so expression generation can handle it
                  // (Expression generation should skip generating references to unit variables)
                } else {
                  const fieldName = sanitizeForCIdentifier(
                    variantElement.label
                  );
                  const fieldType = getTypeString(variantElement.type, context);

                  // Generate variable declaration and assignment
                  const accessPrefix =
                    ptrOrRefType === "ref_semantics" || ptrOrRefType
                      ? "->"
                      : ".";
                  context.emitter.emitLine(
                    `${indent}  ${fieldType} ${varName} = ${matchedValueCode}${accessPrefix}data.${variantName}.${fieldName};`
                  );

                  // Check if this variable needs to be stored in the state machine
                  const functionContext = context as FunctionGenerationContext;
                  if (
                    functionContext?.inStateMachine &&
                    functionContext.stateMachineVariables
                  ) {
                    let varId: string | undefined;

                    // if (destructuredVar.$?.id) {
                    //   varId = destructuredVar.$.id;
                    // } else
                    if (destructuredVar.$?.env) {
                      const vars = getVariablesFromEnv(
                        destructuredVar.$.env,
                        varName
                      );
                      if (vars.length > 0) {
                        varId = vars[vars.length - 1]!.id;
                      }
                    }

                    if (
                      varId &&
                      functionContext.stateMachineVariables.has(varId)
                    ) {
                      // This variable crosses an await boundary, store it in state machine
                      context.emitter.emitLine(
                        `${indent}  sm->var_${varId} = ${varName};`
                      );
                    }
                  }
                }
              }
            }
          }
        }

        if (
          exprIsFunctionCall(caseBody) &&
          exprIsFunctionCallOf(caseBody, "=>", 2)
        ) {
          const renameExpr = caseBody.args[0]!;
          context.emitter.emitLine(
            `${indent}  ${getTypeString(matchValueType, context)} ${renameExpr.token.value} = ${matchedValueCode};`
          );

          caseBody = caseBody.args[1]!; // Get the value part of the case
        }

        // Generate the body of the case
        const bodyCode = generateCaseBody(caseBody, indent + "  ", context);
        if (!isUnit && tempVariableName && bodyCode) {
          context.emitter.emitLine(
            `${indent}  ${tempVariableName} = ${bodyCode};`
          );
        } else if (bodyCode) {
          context.emitter.emitLine(`${indent}  ${bodyCode};`);
        }

        // Check if we need to break out of the loop instead of just the switch
        if (context.currentLoopLabel && caseBody.$?.controlFlow === "break") {
          context.emitter.emitLine(
            `${indent}  goto ${context.currentLoopLabel};`
          );
        } else if (
          context.currentLoopLabel &&
          caseBody.$?.controlFlow === "continue"
        ) {
          context.emitter.emitLine(`${indent}  break;`);
        } else {
          context.emitter.emitLine(`${indent}  break;`);
        }
      }
    }
  }

  context.emitter.emitLine(`${indent}}`);

  // Generate deferred drop expressions for the match expression after the switch closes
  // This ensures owned variables (like the matched enum) are cleaned up
  if (expr.$?.deferredDropExpressions) {
    generateDeferredDropExpressions(expr, indent, context);
  }

  return isUnit ? "" : (tempVariableName ?? ""); // Return the temp variable name
}

/**
 * Generate a return statement for a function body expression - extracted from original codegen-c.ts
 */
export function generateReturnStatement(
  expr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  switch (expr.tag) {
    case ExprTag.Atom: {
      // Use generateExpressionAsCode to handle compile-time values
      let atomCode = generateAtom(expr, context);

      // Handle deferred dup expressions for atoms (borrowed parameters that need to be duped before returning)
      if (
        expr.$?.deferredDupExpressions &&
        expr.$.deferredDupExpressions.length > 0
      ) {
        generateDeferredDupExpressions(
          expr,
          indent,
          context as FunctionGenerationContext
        );
        // Use the duped value's variable name instead of the original
        const dupExpr = expr.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          atomCode = sanitizeForCIdentifier(dupExpr.$.variableName);
        }
      }

      context.emitter.emitLine(`${indent}return ${atomCode};`);
      break;
    }
    case ExprTag.FuncCall: {
      // Handle deferred dup expressions for function calls (e.g., field access that needs duping)
      if (
        expr.$?.deferredDupExpressions &&
        expr.$.deferredDupExpressions.length > 0
      ) {
        // Check if expr has a variableName for storing the intermediate value
        if (expr.$?.variableName) {
          // Generate the expression value without the variableName to get the raw expression
          const savedVariableName = expr.$.variableName;
          expr.$.variableName = undefined;
          const rawCode = generateFuncCall(expr, indent, context);
          expr.$.variableName = savedVariableName;

          // Declare and assign the temp variable
          const exprType = getTypeString(expr.$.type!, context);
          const exprTempVar = sanitizeForCIdentifier(savedVariableName);
          if (exprTempVar !== rawCode) {
            context.emitter.emitLine(
              `${indent}${exprType} ${exprTempVar} = ${rawCode};`
            );
          }
        } else {
          // No temp variable name, just generate the expression
          const rawCode = generateFuncCall(expr, indent, context);
          context.emitter.emitLine(`${indent}${rawCode};`);
        }

        // Generate the deferred dup expressions
        generateDeferredDupExpressions(
          expr,
          indent,
          context as FunctionGenerationContext
        );

        // Use the duped value's variable name for the return
        const dupExpr = expr.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          const dupedValue = sanitizeForCIdentifier(dupExpr.$.variableName);
          context.emitter.emitLine(`${indent}return ${dupedValue};`);
        } else {
          // Fallback: return the raw code
          const funcCallCode = generateFuncCall(expr, indent, context);
          context.emitter.emitLine(`${indent}return ${funcCallCode};`);
        }
      } else {
        // No deferred dup expressions, generate normally
        const funcCallCode = generateFuncCall(expr, indent, context);
        if (!exprIsFunctionCallOf(expr, BuiltinKeywords.return)) {
          context.emitter.emitLine(`${indent}return ${funcCallCode};`);
        } else {
          context.emitter.emitLine(`${indent}${funcCallCode};`);
        }
      }
      break;
    }
  }
}

/**
 * Generate Yo operator function call - extracted from original codegen-c.ts
 */
function generateYoInlineFunctionCall(
  functionName: string,
  args: string[],
  expr: FuncCallExpr,
  context: CodeGenContext
): string {
  // +
  if (BuiltinFunctions.__yo_op_add.includes(functionName)) {
    return `((${args[0]!}) + (${args[1]!}))`;
  }
  // -
  else if (BuiltinFunctions.__yo_op_sub.includes(functionName)) {
    return `((${args[0]!}) - (${args[1]!}))`;
  }
  // *
  else if (BuiltinFunctions.__yo_op_mul.includes(functionName)) {
    return `((${args[0]!}) * (${args[1]!}))`;
  }
  // /
  else if (BuiltinFunctions.__yo_op_div.includes(functionName)) {
    return `((${args[0]!}) / (${args[1]!}))`;
  }
  // %
  else if (BuiltinFunctions.__yo_op_mod.includes(functionName)) {
    return `((${args[0]!}) % (${args[1]!}))`;
  }
  // neg -
  else if (BuiltinFunctions.__yo_op_neg.includes(functionName)) {
    return `(-(${args[0]!}))`;
  }
  // ==
  else if (BuiltinFunctions.__yo_op_eq.includes(functionName)) {
    return `((${args[0]!}) == (${args[1]!}))`;
  }
  // !=
  else if (BuiltinFunctions.__yo_op_neq.includes(functionName)) {
    return `((${args[0]!}) != (${args[1]!}))`;
  }
  // <
  else if (BuiltinFunctions.__yo_op_lt.includes(functionName)) {
    return `((${args[0]!}) < (${args[1]!}))`;
  }
  // <=
  else if (BuiltinFunctions.__yo_op_lte.includes(functionName)) {
    return `((${args[0]!}) <= (${args[1]!}))`;
  }
  // >
  else if (BuiltinFunctions.__yo_op_gt.includes(functionName)) {
    return `((${args[0]!}) > (${args[1]!}))`;
  }
  // >=
  else if (BuiltinFunctions.__yo_op_gte.includes(functionName)) {
    return `((${args[0]!}) >= (${args[1]!}))`;
  }
  // !
  else if (BuiltinFunctions.__yo_op_not.includes(functionName)) {
    return `(!(${args[0]!}))`;
  }
  // &
  else if (BuiltinFunctions.__yo_op_bit_and.includes(functionName)) {
    return `((${args[0]!}) & (${args[1]!}))`;
  }
  // |
  else if (BuiltinFunctions.__yo_op_bit_or.includes(functionName)) {
    return `((${args[0]!}) | (${args[1]!}))`;
  }
  // ^
  else if (BuiltinFunctions.__yo_op_bit_xor.includes(functionName)) {
    return `((${args[0]!}) ^ (${args[1]!}))`;
  }
  // ~
  else if (BuiltinFunctions.__yo_op_bit_complement.includes(functionName)) {
    return `(~(${args[0]!}))`;
  }
  // <<
  else if (BuiltinFunctions.__yo_op_bit_left_shift.includes(functionName)) {
    return `((${args[0]!}) << (${args[1]!}))`;
  }
  // >>
  else if (BuiltinFunctions.__yo_op_bit_right_shift.includes(functionName)) {
    return `((${args[0]!}) >> (${args[1]!}))`;
  }
  // __yo_noop
  else if (BuiltinFunctions.__yo_noop.includes(functionName)) {
    return "";
  }
  // __yo_return_self
  else if (BuiltinFunctions.__yo_return_self.includes(functionName)) {
    // This is a special case where we just return the first argument
    return `(*${args[0]!})`;
  }
  // __yo_ms_sleep
  else if (BuiltinFunctions.__yo_ms_sleep.includes(functionName)) {
    // Cross-platform sleep - takes milliseconds
    // Windows Sleep takes milliseconds, usleep takes microseconds
    return `(
#ifdef _WIN32
Sleep(${args[0]!})
#else
usleep((${args[0]!}) * 1000)
#endif
)`;
  }
  // __yo_decr_rc
  else if (BuiltinFunctions.__yo_decr_rc.includes(functionName)) {
    return `__yo_decr_rc((void*)(${args[0]!}))`;
  }
  // __yo_as - generic type casting for primitives and pointers
  else if (BuiltinFunctions.__yo_as.includes(functionName) && expr.$?.type) {
    // The return type tells us what to cast to
    const targetCType = getTypeString(expr.$.type, context);
    return `((${targetCType})(${args[0]!}))`;
  }
  // __yo_ptr_add
  else if (BuiltinFunctions.__yo_ptr_add.includes(functionName)) {
    return `(${args[0]!} + ${args[1]!})`;
  }
  // __yo_ptr_sub
  else if (BuiltinFunctions.__yo_ptr_sub.includes(functionName)) {
    return `(${args[0]!} - ${args[1]!})`;
  }
  // __yo_ptr_diff
  else if (BuiltinFunctions.__yo_ptr_diff.includes(functionName)) {
    return `(${args[0]!} - ${args[1]!})`;
  }
  // __yo_ptr_eq
  else if (BuiltinFunctions.__yo_ptr_eq.includes(functionName)) {
    return `(${args[0]!} == ${args[1]!})`;
  }
  // __yo_ptr_neq
  else if (BuiltinFunctions.__yo_ptr_neq.includes(functionName)) {
    return `(${args[0]!} != ${args[1]!})`;
  }
  // __yo_ptr_lt
  else if (BuiltinFunctions.__yo_ptr_lt.includes(functionName)) {
    return `(${args[0]!} < ${args[1]!})`;
  }
  // __yo_ptr_lte
  else if (BuiltinFunctions.__yo_ptr_lte.includes(functionName)) {
    return `(${args[0]!} <= ${args[1]!})`;
  }
  // __yo_ptr_gt
  else if (BuiltinFunctions.__yo_ptr_gt.includes(functionName)) {
    return `(${args[0]!} > ${args[1]!})`;
  }
  // __yo_ptr_gte
  else if (BuiltinFunctions.__yo_ptr_gte.includes(functionName)) {
    return `(${args[0]!} >= ${args[1]!})`;
  }
  // __yo_slice_len - access the length field of a slice fat pointer
  else if (BuiltinFunctions.__yo_slice_len.includes(functionName)) {
    return `(${args[0]!}.length)`;
  }
  // Handle other operators that are not defined in Yo
  else {
    return `/* Unhandled operator ${functionName} */`;
  }
}

/**
 * Generate step expression for for loop increment section.
 * This generates the step expression inline without emitting it as a statement.
 */
function generateStepExpression(
  stepExpr: Expr,
  context: CodeGenContext
): string {
  // Handle begin blocks specially for multiple step expressions
  if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, BuiltinKeywords.begin)
  ) {
    // Extract all assignment expressions from the begin block
    const assignments: string[] = [];

    for (const arg of stepExpr.args) {
      if (exprIsFunctionCall(arg) && exprIsFunctionCallOf(arg, "=", 2)) {
        const lhs = arg.args[0]!;
        const rhs = arg.args[1]!;

        const lhsCode = generateExpr(lhs, "", context);
        const rhsCode = generateExpr(rhs, "", context);

        assignments.push(`${lhsCode} = ${rhsCode}`);
      }
    }

    // Join multiple assignments with comma operator
    return assignments.join(", ");
  }
  // Handle single assignment expressions
  else if (
    exprIsFunctionCall(stepExpr) &&
    exprIsFunctionCallOf(stepExpr, "=", 2)
  ) {
    const lhs = stepExpr.args[0]!;
    const rhs = stepExpr.args[1]!;

    // For step expressions, we want inline assignment like "i = i + 1"
    const lhsCode = generateExpr(lhs, "", context);
    const rhsCode = generateExpr(rhs, "", context);

    return `${lhsCode} = ${rhsCode}`;
  }

  // For other expressions, just generate normally
  return generateExpr(stepExpr, "", context);
}

/**
 * Generate body statements for loop bodies.
 * This handles begin blocks by extracting their statements without the surrounding braces.
 */
function generateLoopBody(
  bodyExpr: Expr,
  indent: string,
  context: CodeGenContext
): void {
  // Handle begin blocks specially for loop bodies
  if (
    exprIsFunctionCall(bodyExpr) &&
    exprIsFunctionCallOf(bodyExpr, BuiltinKeywords.begin)
  ) {
    // Generate each statement in the begin block directly
    for (const arg of bodyExpr.args) {
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }
    }

    // Generate deferred drop expressions before end of loop body
    if (bodyExpr.$?.deferredDropExpressions) {
      for (const dropExpr of bodyExpr.$.deferredDropExpressions) {
        const dropCode = generateExpr(dropExpr, indent, context);
        if (dropCode) {
          context.emitter.emitLine(`${indent}${dropCode};`);
        }
      }
    }
  } else {
    // For non-begin expressions, generate normally
    const bodyCode = generateExpr(bodyExpr, indent, context);
    if (bodyCode) {
      context.emitter.emitLine(`${indent}${bodyCode};`);
    }
  }
}

/**
 * Generate case body for match/cond expressions, handling begin blocks specially
 * Returns the body code string for assignment to temp variable
 */
function generateCaseBody(
  bodyExpr: Expr,
  indent: string,
  context: CodeGenContext
): string {
  // Handle begin blocks specially
  if (
    exprIsFunctionCall(bodyExpr) &&
    exprIsFunctionCallOf(bodyExpr, BuiltinKeywords.begin)
  ) {
    const beginArgs = bodyExpr.args;

    // Generate each statement except the last one
    for (let j = 0; j < beginArgs.length - 1; j++) {
      const arg = beginArgs[j]!;
      const argCode = generateExpr(arg, indent, context);
      if (argCode) {
        context.emitter.emitLine(`${indent}${argCode};`);
      }
    }

    // Get the final expression code for return/assignment
    let finalExprCode = "";
    if (beginArgs.length > 0) {
      const finalExpr = beginArgs[beginArgs.length - 1]!;
      // Generate deferred dup expressions for the final expression (e.g., returning a borrowed value)
      if (
        finalExpr.$?.deferredDupExpressions &&
        finalExpr.$.deferredDupExpressions.length > 0
      ) {
        generateDeferredDupExpressions(
          finalExpr,
          indent,
          context as FunctionGenerationContext
        );
        // Use the duped value's variable name instead of the original expression
        const dupExpr = finalExpr.$.deferredDupExpressions[0]!;
        if (exprIsFunctionCall(dupExpr) && dupExpr.$?.variableName) {
          finalExprCode = sanitizeForCIdentifier(dupExpr.$.variableName);
        } else {
          finalExprCode = generateExpr(finalExpr, indent, context);
        }
      } else {
        finalExprCode = generateExpr(finalExpr, indent, context);
      }
    }

    // Generate deferred drop expressions for the begin block
    if (bodyExpr.$?.deferredDropExpressions) {
      generateDeferredDropExpressions(bodyExpr, indent, context);
    }

    return finalExprCode;
  } else {
    // For non-begin expressions, check for deferred dup expressions
    if (bodyExpr.$?.deferredDupExpressions) {
      generateDeferredDupExpressions(
        bodyExpr,
        indent,
        context as FunctionGenerationContext
      );
    }
    return generateExpr(bodyExpr, indent, context);
  }
}

/**
 * Generate C code for while loop expression
 * Supports both while(condition, body) and while(condition, step, body) forms
 * The 3-argument form is transpiled to a C for loop, 2-argument form to a C while loop
 */
function generateWhileLoop(
  expr: FuncCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  const args = expr.args;

  if (args.length === 2) {
    // 2-argument form: while(condition, body) -> C while loop
    // We need to re-evaluate the condition on each iteration, so we use while(true)
    // and check the condition inside with a break statement
    const conditionExpr = args[0]!;
    const bodyExpr = args[1]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    context.currentLoopLabel = savedLoopLabel;

    return "";
  } else if (args.length === 3) {
    // 3-argument form: while(condition, step, body) -> C for loop
    // We need to re-evaluate the condition on each iteration
    const conditionExpr = args[0]!;
    const stepExpr = args[1]!;
    const bodyExpr = args[2]!;

    // Track that we're in a loop for proper break/continue handling in nested match expressions
    const savedLoopLabel = context.currentLoopLabel;
    const loopLabel = `loop_${Math.random().toString(36).substr(2, 9)}`;
    context.currentLoopLabel = loopLabel;

    context.emitter.emitLine(`${indent}while (true) {`);
    const conditionCode = generateExpr(conditionExpr, indent + "  ", context);
    context.emitter.emitLine(`${indent}  if (!(${conditionCode})) {`);
    context.emitter.emitLine(`${indent}    break;`);
    context.emitter.emitLine(`${indent}  }`);
    generateLoopBody(bodyExpr, indent + "  ", context);
    const stepCode = generateStepExpression(stepExpr, context);
    context.emitter.emitLine(`${indent}  ${stepCode};`);
    context.emitter.emitLine(`${indent}}`);
    context.emitter.emitLine(`${indent}${loopLabel}:;`);

    context.currentLoopLabel = savedLoopLabel;

    return "";
  } else {
    context.emitter.emitLine(
      `${indent}/* Error: while loop expects 2 or 3 arguments, got ${args.length} */`
    );
    return "";
  }
}

export function generateDeferredDropExpressions(
  expr: Expr,
  indent: string,
  context: FunctionGenerationContext
) {
  const emitter = context.emitter;

  if (expr.$?.deferredDropExpressions) {
    for (const dropExpr of expr.$.deferredDropExpressions) {
      const dropCode = generateExpr(dropExpr, indent, context);
      if (dropCode) {
        emitter.emitLine(`${indent}${dropCode};`);
      }
    }
  }
}

/**
 * Generate C code for all deferred dup expressions.
 * This is used to generate dup calls for expressions that need reference counting.
 * The dup expressions are created during evaluation and deferred to codegen to ensure
 * proper context (e.g., closure captures, state machine variables).
 */
export function generateDeferredDupExpressions(
  expr: Expr,
  indent: string,
  context: FunctionGenerationContext
) {
  const emitter = context.emitter;

  if (expr.$?.deferredDupExpressions) {
    for (const dupExpr of expr.$.deferredDupExpressions) {
      if (exprIsFunctionCall(dupExpr)) {
        const dupCode = generateExpr(dupExpr, indent, context);
        if (dupCode) {
          emitter.emitLine(`${indent}${dupCode};`);
        }
      }
    }
  }
}

/**
 * Pre-register async block state machine types before generating function declarations.
 * This ensures that when function prototypes are generated, the correct state machine
 * struct names are already registered in context.types.
 */
export function preRegisterAsyncBlockTypes(
  context: FunctionGenerationContext
): void {
  // Iterate through all functions and find async blocks
  for (const funcId in context.functions) {
    const { value: functionValue } = context.functions[funcId]!;
    if (functionValue.body) {
      preRegisterAsyncBlocksInExpr(functionValue.body, context);
    }
  }
}

/**
 * Recursively search for async blocks in an expression and pre-register their types.
 */
function preRegisterAsyncBlocksInExpr(
  expr: Expr,
  context: FunctionGenerationContext
): void {
  if (!expr) return;

  if (exprIsFunctionCall(expr)) {
    const funcCallExpr = expr as FuncCallExpr;

    // Check if this is an async block
    if (exprIsFunctionCallOf(expr, BuiltinFunctions.async)) {
      // Found an async block - extract info and pre-register type
      const futureType = expr.$?.type;
      if (futureType && typeImplementsFuture(futureType)) {
        const futureModuleType = extractFutureModuleFromType(futureType);
        if (futureModuleType) {
          const asyncBlockId =
            expr.$?.variableName || `async_block_${Date.now()}`;
          const structName = `${asyncBlockId}_state_t`;

          // Store the struct name directly on the expression for later lookup
          // This is more reliable than context.types which can be overwritten
          if (expr.$) {
            expr.$.asyncStateMachineStructName = structName;
          }

          // Also register in context.types for backward compatibility with getTypeString
          // Note: this may be overwritten by later async blocks with the same output type,
          // which is why we also store on the expression itself
          context.types[futureModuleType.id] = {
            type: futureModuleType,
            cName: structName,
          };

          // Emit forward declaration for the state machine struct
          // The full struct definition will be emitted later during generateAsyncBlock
          context.emitter.emitDeclarationLine(
            `typedef struct ${structName}_struct ${structName}; // Forward declaration for async state machine`
          );
        }
      }
    }

    // Recursively search in arguments
    for (const arg of funcCallExpr.args) {
      preRegisterAsyncBlocksInExpr(arg, context);
    }
  }
}

/**
 * Generate all deferred async block implementations.
 * This must be called after all regular functions are generated,
 * so that async block resume/constructor functions don't get nested inside other functions.
 */
export function generateDeferredAsyncBlocks(
  context: FunctionGenerationContext
): void {
  if (
    !context.deferredAsyncBlocks ||
    context.deferredAsyncBlocks.length === 0
  ) {
    return;
  }

  const emitter = context.emitter;

  // Emit all async block struct definitions in a dependency-safe order.
  // This avoids incomplete-type errors when one state machine embeds another by value.
  emitDeferredAsyncBlockStructDefinitions(context);

  emitter.emitLine(`// Deferred async block implementations`);

  for (const asyncBlockInfo of context.deferredAsyncBlocks) {
    const {
      bodyExpr,
      asyncBlockId,
      structName,
      resumeFunctionName,
      constructorName,
      disposeFunctionName,
      futureType,
      //      futureModuleType,
      resultType,
      resultTypeCName,
      captureType,
      analysis,
    } = asyncBlockInfo;

    // Generate state machine dispose function
    generateAsyncBlockStateDisposeFunction(
      asyncBlockId,
      structName,
      disposeFunctionName,
      captureType,
      analysis,
      context
    );

    emitter.emitLine(``);

    // Generate resume function implementation
    generateAsyncBlockResumeFunction(
      bodyExpr,
      asyncBlockId,
      structName,
      resumeFunctionName,
      analysis,
      futureType,
      captureType,
      context
    );

    emitter.emitLine(``);

    // Generate constructor function implementation
    generateAsyncBlockConstructor(
      asyncBlockId,
      structName,
      resumeFunctionName,
      constructorName,
      disposeFunctionName,
      futureType,
      resultType,
      resultTypeCName,
      captureType,
      context
    );

    emitter.emitLine(``);
  }
}
