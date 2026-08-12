import { type Environment, getVariablesFromEnv } from "../../env";
import {
  extractFnTraitFromType,
  typeImplementsFn,
} from "../../evaluator/trait-checking";
import {
  type AtomExpr,
  type Expr,
  exprIsAtom,
  ExprTag,
  type FnCallExpr,
} from "../../expr";
import type { SomeType, StructType, Type } from "../../types/definitions";
import { isDynType, isStructType } from "../../types/guards";
import { TypeTag } from "../../types/tags";

/**
 * Walk a SomeType's resolvedConcreteType chain until we hit a non-SomeType.
 * Returns the final Type (or the original if not a SomeType / no resolution).
 */
export function resolveSomeTypeToConcrete(t: Type): Type {
  let cur: Type = t;
  while (cur.tag === TypeTag.SomeType) {
    const some = cur as SomeType;
    if (!some.resolvedConcreteType) break;
    if (some.resolvedConcreteType === some) break;
    cur = some.resolvedConcreteType;
  }
  return cur;
}
import type { FunctionGenerationContext } from "../functions/context";
import {
  type CodeGenContext,
  getDeferredDupTargetAtomName,
  getTypeString,
} from "../utils";
import { generateExpr } from "./expr";
import { codegenFatal } from "../constants";

/**
 * Check if a variable is captured by the closure or is a local variable.
 * A variable is captured if the latest variable with that name exists at a frame level
 * that is <= the closure capture frame level.
 * Variables at higher frame levels (more recent scopes) are local variables.
 */
export function checkVariableIsClosureCaptured(
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
 * Check if this is a closure construction expression
 */
export function isClosureConstruction(expr: FnCallExpr): boolean {
  return !!(
    expr.$?.closureFunctionValue &&
    expr.$?.type &&
    typeImplementsFn(expr.$.type)
  );
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

/**
 * Allocate and initialize a closure capture struct.
 * For Impl closures: stack-allocate the capture struct (value type semantics)
 * For Dyn closures: heap-allocate the capture struct (reference type semantics)
 *
 * @param captureType The struct type containing captured variables
 * @param closureTypeId A unique ID for generating temp variable names
 * @param sourceExpr The expression containing deferredDupExpressions (for Rc handling)
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

  // Build a lookup for deferred dup expressions
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
    // Effect param fields are zero-initialized at closure construction time.
    // They will be populated at io.spawn/io.await time.
    if (field.isEffectParam) {
      return `NULL`;
    }

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
      token: fieldExpr.token,
      $: fieldExpr.$,
    };
    return generateExpr(atomExpr, indent, context);
  });

  // Generate capture struct initialization
  const captureDataCode = `(${captureCName}){ ${captureArgs
    .map((arg, i) => {
      const field = captureType.fields[i];
      if (!field) {
        return `/* Error: missing field at index ${i} */`;
      }
      return `.${field.label} = ${arg}`;
    })
    .join(", ")} }`;

  // Generate a unique temporary variable name
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
 * Pre-pass: register all Impl(Fn(...)) closure implementations into
 * `context.implClosureCallMap` BEFORE any function bodies are codegen'd.
 *
 * Without this pre-pass, a function that uses a closure value (e.g. calls it
 * via `closure()`) may be codegen'd before the function that constructs that
 * closure — at which point the map lookup at the call site fails and the
 * fallback path emits an incorrect fn-pointer cast. Iteration order of
 * `context.functions` is insertion order, which doesn't match the dependency
 * order between closure consumers and producers.
 *
 * The map's key is the resolved concrete capture struct's type id, matching
 * what `generateClosureConstruction` (the per-site registration) uses.
 */
export function registerImplClosureCallMappings(
  context: FunctionGenerationContext
): void {
  for (const funcId in context.functions) {
    const entry = context.functions[funcId]!;
    const closureInfo = entry.value.closureInfo;
    if (!closureInfo) continue;
    const captureType = closureInfo.captureType;
    if (!captureType || !isStructType(captureType)) continue;
    if (captureType.fields.length === 0) continue;
    // Skip closures that are wrapped by an io.async state machine — those are
    // emitted as resume functions, not as standalone Impl(Fn(...)) entries.
    if (entry.value.isIoAsyncStateMachineClosure) continue;
    const captureKey = resolveSomeTypeToConcrete(captureType).id;
    if (context.implClosureCallMap.has(captureKey)) continue;
    context.implClosureCallMap.set(captureKey, {
      functionCName: entry.cName,
      callTypeId: closureInfo.closureType.isFn.callType.id,
      callType: closureInfo.closureType.isFn.callType,
      consumedCaptures: closureInfo.consumedCaptures,
    });
  }
}

/**
 * Generate C code for anonymous function/closure construction
 */
export function generateClosureConstruction(
  expr: FnCallExpr,
  indent: string,
  context: CodeGenContext
): string {
  if (!expr.$ || !expr.$.type || !expr.$.closureFunctionValue) {
    return codegenFatal(`Missing closure metadata`);
  }

  const fnTrait = extractFnTraitFromType(expr.$.type)!;
  const closureType = fnTrait.isFn.callType;
  const closureFunctionValue = expr.$.closureFunctionValue;
  const captureType = expr.$.captureType;

  const functionCName = (context as FunctionGenerationContext).functions[
    closureFunctionValue.funcId
  ]?.cName;

  if (!functionCName) {
    return codegenFatal(`Closure implementation function not found in context`);
  }

  // Check if this is a Dyn(Fn(...)) or Impl(Fn(...))
  const isDynClosure = isDynType(expr.$.type);

  // For Dyn(Fn(...)), use the DynType's C name.
  let closureCName: string | undefined;
  if (isDynClosure) {
    const dynTypeEntry = context.types[expr.$.type.id];
    if (!dynTypeEntry) {
      return codegenFatal(`Dyn closure type not found in context`);
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
      return codegenFatal(`Failed to allocate closure capture`);
    }

    const { captureTempVar } = captureResult;

    if (isDynClosure) {
      const constructorName = `__yo_create_${closureCName}`;
      const disposeFunctionName = `__yo_dispose_${closureCName}`;
      return `${constructorName}(${captureTempVar}, ${disposeFunctionName}, ${castCallFunction})`;
    } else {
      // Impl(Fn(...)) is true static dispatch
      const captureKey = resolveSomeTypeToConcrete(captureType).id;
      context.implClosureCallMap.set(captureKey, {
        functionCName,
        callTypeId: fnTrait.isFn.callType.id,
        callType: fnTrait.isFn.callType,
        consumedCaptures: closureFunctionValue.closureInfo?.consumedCaptures,
      });
      return captureTempVar;
    }
  } else {
    // Closure without captures
    if (isDynClosure) {
      const constructorName = `__yo_create_${closureCName}`;
      const disposeFunctionName = `__yo_dispose_${closureCName}`;
      return `${constructorName}(NULL, ${disposeFunctionName}, ${castCallFunction})`;
    } else {
      // Impl closures without captures: still static dispatch
      if (expr.$.type.tag === TypeTag.SomeType) {
        const someType = expr.$.type as SomeType;
        if (someType.resolvedConcreteType) {
          const concreteFinal = resolveSomeTypeToConcrete(someType);
          context.implClosureCallMap.set(concreteFinal.id, {
            functionCName,
            callTypeId: fnTrait.isFn.callType.id,
            callType: fnTrait.isFn.callType,
          });

          const concreteCName = getTypeString(
            someType.resolvedConcreteType,
            context
          );
          return `(${concreteCName}){}`;
        }
      }

      return codegenFatal(
        `Impl(Fn(...)) without captures missing resolvedConcreteType`
      );
    }
  }
}
