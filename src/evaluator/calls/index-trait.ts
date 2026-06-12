import type { Environment } from "../../env";
import { addVariableToEnv, getVariablesFromEnv, pushEnvFrame } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  type Expr,
  type FnCallExpr,
  type ComptimeRef,
  exprToString,
} from "../../expr";
import { PlaceholderToken } from "../../token";
import { areTypesCompatible } from "../../types/compatibility";
import {
  createPtrType,
  createUsizeType,
} from "../../types/creators";
import type {
  ArrayType,
  FunctionType,
  StructType,
  TraitType,
  Type,
} from "../../types/definitions";
import {
  isArrayType,
  isFunctionType,
  isPtrType,
  isStructType,
} from "../../types/guards";
import {
  convertComptimeTypeToRuntimeType,
  typeToString,
} from "../../types/utils";
import type { ArrayValue, Value } from "../../value";
import {
  createPtrValue,
  createTypeValue,
  createUnknownValue,
  isArrayValue,
  isComptimeStringValue,
  isFunctionValue,
  isNumberValue,
  isPtrValue,
  isStructValue,
  isTupleValue,
  isTraitValue,
  isTypeValue,
  isUnknownValue,
} from "../../value";
import type { EvaluatorContext, IndexCallResult } from "../context";
import { computeComptimeStringIndex } from "../builtins/comptime-index-fns";
import { evaluateExpression } from "../exprs/expr";
import { findMethodsFromGenericImpls } from "../values/impl";
import { evaluateComptimeFunctionCall } from "./comptime-fn";

/**
 * Find all methods named "index" on a concrete type, checking both
 * direct trait impls (on type.trait) and generic impls (in genericImplRegistry).
 */
function findAllIndexMethods({
  concreteType,
  env,
}: {
  concreteType: Type;
  env: Environment;
}): { type: FunctionType; value: Value | undefined }[] {
  const methods: { type: FunctionType; value: Value | undefined }[] = [];

  // Check direct trait methods (non-generic impls)
  if (concreteType.trait) {
    // Check impl'd traits stored with empty label
    for (const field of concreteType.trait.fields) {
      if (
        field.label === "" &&
        field.assignedValue &&
        isTraitValue(field.assignedValue)
      ) {
        const implTraitValue = field.assignedValue;
        const implTraitType = implTraitValue.type as TraitType;
        const methodIndex = implTraitType.fields.findIndex(
          (f) => f.label === "index" && isFunctionType(f.type)
        );
        if (methodIndex >= 0) {
          const method = implTraitType.fields[methodIndex]!;
          if (isFunctionType(method.type)) {
            const value = implTraitValue.fields[methodIndex];
            let methodType = method.type;
            if (isFunctionValue(value) && value.specializedType) {
              methodType = value.specializedType;
            }
            methods.push({ type: methodType, value });
          }
        }
      }

      // Also check direct methods
      if (field.label === "index" && isFunctionType(field.type)) {
        methods.push({ type: field.type, value: field.assignedValue });
      }
    }
  }

  // Check generic impl registry
  const genericMethods = findMethodsFromGenericImpls({
    concreteType,
    methodName: "index",
    env,
  });
  methods.push(...genericMethods);

  return methods;
}

/**
 * Check if a type has an `index` method (from Index trait or compatible impl).
 * Returns the matching method's function type and value, or undefined if not found.
 */
function findIndexMethod({
  concreteType,
  argType,
  env,
}: {
  concreteType: Type;
  argType: Type;
  env: Environment;
}): { type: FunctionType; value: Value | undefined } | undefined {
  const methods = findAllIndexMethods({ concreteType, env });

  if (methods.length === 0) {
    return undefined;
  }

  // Find a method whose signature matches:
  //   (self : *(Self), idx : ArgType) -> *(Output)
  // OR
  //   (inout(self) : Self, idx : ArgType) -> *(Output)
  // Both shapes are accepted — inout is the modern form that doesn't
  // need a `pragma(Pragma.AllowUnsafe)` at the call site.
  for (const method of methods) {
    const fnType = method.type;
    // Must have exactly 2 parameters: self and idx
    if (fnType.parameters.length !== 2) {
      continue;
    }
    const selfParam = fnType.parameters[0]!;
    const idxParam = fnType.parameters[1]!;

    // self must be a pointer type OR an ref parameter
    if (!isPtrType(selfParam.type) && !selfParam.isRef) {
      continue;
    }

    // idx type must be compatible with the argument type
    if (
      areTypesCompatible({ type: idxParam.type, env }, { type: argType, env })
    ) {
      // Return type must be a pointer type
      if (isPtrType(fnType.return.type)) {
        return method;
      }
    }
  }

  return undefined;
}

/**
 * Try to dispatch a call `value(arg)` via the Index trait.
 *
 * Desugars: value(arg) → Index(typeof(arg)).index(&(value), arg).*
 *
 * For comptime values (arrays, strings), this function directly
 * computes the result using comptime indexing helpers, returning the
 * computed value with arrayElementRef for mutation support.
 *
 * For runtime values, returns UnknownValue with method type info for codegen.
 */
export function tryToCallWithIndexTrait({
  expr,
  valueType,
  selfValue,
  argExprs,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  valueType: Type;
  /** The compile-time value of self, if known. Enables comptime index dispatch. */
  selfValue?: Value;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
}): IndexCallResult {
  if (argExprs.length !== 1) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `Index trait expects exactly 1 argument, got ${argExprs.length}.`,
    });
  }

  const argExpr = argExprs[0]!;

  // Check if self has a comptime value that can be indexed at compile time
  const arrayValue =
    selfValue && isArrayValue(selfValue) ? selfValue : undefined;
  const stringValue =
    selfValue && isComptimeStringValue(selfValue) ? selfValue.value : undefined;

  // For comptime array values, try comptime dispatch first
  if (arrayValue && isArrayType(valueType)) {
    const comptimeResult = tryComptimeArrayIndex({
      argExpr,
      arrayValue,
      arrayType: valueType,
      env: callerEnv,
      context,
    });
    if (comptimeResult) {
      // Enrich with Index method info for codegen (needed for runtime fallback paths)
      const indexMethod = findIndexMethodSafe({
        concreteType: valueType,
        argExpr,
        callerEnv,
        context,
      });
      if (indexMethod) {
        comptimeResult.indexMethodType = indexMethod.fnType;
        comptimeResult.indexMethodValue = indexMethod.value;
      }
      return comptimeResult;
    }
  }

  // For comptime string values, try comptime dispatch
  if (stringValue !== undefined) {
    const comptimeResult = tryComptimeStringIndex({
      argExpr,
      strValue: stringValue,
      env: callerEnv,
      context,
    });
    // Enrich with Index method info for codegen
    const indexMethod = findIndexMethodSafe({
      concreteType: valueType,
      argExpr,
      callerEnv,
      context,
    });
    if (indexMethod) {
      comptimeResult.indexMethodType = indexMethod.fnType;
      comptimeResult.indexMethodValue = indexMethod.value;
    }
    return comptimeResult;
  }

  // For comptime values of custom types (structs, enums, etc.), try ComptimeIndex dispatch.
  // This handles types like Point that implement ComptimeIndex(usize).
  if (
    selfValue &&
    !isUnknownValue(selfValue) &&
    !arrayValue &&
    stringValue === undefined
  ) {
    const comptimeResult = tryComptimeCustomTypeIndex({
      expr,
      argExpr,
      selfValue,
      valueType,
      callerEnv,
      context,
    });
    if (comptimeResult) {
      return comptimeResult;
    }
  }

  // Runtime path: evaluate the argument to get its type, find the Index method,
  // and return UnknownValue with method info for codegen.
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env: callerEnv,
    context: {
      ...context,
      expectedType: undefined,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate index argument:\n${exprToString(argExpr)}`,
    });
  }
  callerEnv = evaluatedArgExpr.$.env;
  const argType = evaluatedArgExpr.$.type;

  // Find the matching index method
  const indexMethod = findIndexMethod({
    concreteType: valueType,
    argType,
    env: callerEnv,
  });

  if (!indexMethod) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `Type "${typeToString(valueType)}" does not implement Index(${typeToString(argType)}).`,
    });
  }

  const fnType = indexMethod.type;
  // The return type of index is *(Output) — get the Output type by dereferencing
  const ptrReturnType = fnType.return.type;
  if (!isPtrType(ptrReturnType)) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `Index method must return a pointer type, got: ${typeToString(ptrReturnType)}`,
    });
  }
  const outputType = ptrReturnType.childType;

  // The result value is unknown at compile time (runtime dispatch through trait method)
  const resultValue = createUnknownValue(outputType, {
    env: callerEnv,
    context,
  });
  // Mark as runtime-only so overload resolution doesn't prefer comptime functions
  if (isUnknownValue(resultValue)) {
    resultValue.isRuntimeOnly = true;
  }

  return {
    value: resultValue,
    type: outputType,
    ptrType: ptrReturnType,
    indexMethodType: fnType,
    indexMethodValue: indexMethod.value,
    callerEnv,
  };
}

/**
 * Helper to find the Index method for a type, evaluating the arg expression
 * to get its type. Used to enrich comptime results with method info for codegen.
 * Returns undefined if no method found (non-fatal).
 */
function findIndexMethodSafe({
  concreteType,
  argExpr,
  callerEnv,
  context,
}: {
  concreteType: Type;
  argExpr: Expr;
  callerEnv: Environment;
  context: EvaluatorContext;
}): { fnType: FunctionType; value: Value | undefined } | undefined {
  try {
    const evaluatedArgExpr = evaluateExpression({
      expr: argExpr,
      env: callerEnv,
      context: { ...context, expectedType: undefined },
    });
    if (!evaluatedArgExpr.$) return undefined;

    const indexMethod = findIndexMethod({
      concreteType,
      argType: evaluatedArgExpr.$.type,
      env: evaluatedArgExpr.$.env,
    });
    if (!indexMethod) return undefined;

    return { fnType: indexMethod.type, value: indexMethod.value };
  } catch {
    return undefined;
  }
}

/**
 * Find a ComptimeIndex method for a type. ComptimeIndex methods are distinguished
 * from Index methods by having comptime parameters.
 * Returns the method's function type, value, and whether it's a comptime method.
 */
function findComptimeIndexMethod({
  concreteType,
  argType,
  env,
}: {
  concreteType: Type;
  argType: Type;
  env: Environment;
}): { type: FunctionType; value: Value | undefined } | undefined {
  const methods = findAllIndexMethods({ concreteType, env });

  for (const method of methods) {
    const fnType = method.type;
    if (fnType.parameters.length !== 2) continue;

    const selfParam = fnType.parameters[0]!;
    const idxParam = fnType.parameters[1]!;

    // self must be a pointer type OR an ref parameter (modern form).
    if (!isPtrType(selfParam.type) && !selfParam.isRef) continue;

    // idx type must be compatible with the argument type
    if (
      !areTypesCompatible({ type: idxParam.type, env }, { type: argType, env })
    ) {
      continue;
    }

    // Return type must be a pointer type
    if (!isPtrType(fnType.return.type)) continue;

    // Check if this is a comptime method (both self and idx have isCompileTimeOnly)
    if (selfParam.isCompileTimeOnly && idxParam.isCompileTimeOnly) {
      return method;
    }
  }

  return undefined;
}

/**
 * Try to dispatch through ComptimeIndex for custom types (structs, enums, etc.).
 * When a comptime value like `p :: Point(3, 4)` is indexed with `p(0)`,
 * this evaluates the ComptimeIndex method at compile time.
 */
function tryComptimeCustomTypeIndex({
  expr,
  argExpr,
  selfValue,
  valueType,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  argExpr: Expr;
  selfValue: Value;
  valueType: Type;
  callerEnv: Environment;
  context: EvaluatorContext;
}): IndexCallResult | undefined {
  // Evaluate the argument
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env: callerEnv,
    context: { ...context, expectedType: undefined },
  });
  if (!evaluatedArgExpr.$ || !evaluatedArgExpr.$.value) {
    return undefined; // Runtime arg — fall through
  }

  const argType = evaluatedArgExpr.$.type;
  const argValue = evaluatedArgExpr.$.value;
  callerEnv = evaluatedArgExpr.$.env;

  // Find a ComptimeIndex method (comptime parameters)
  const comptimeMethod = findComptimeIndexMethod({
    concreteType: valueType,
    argType,
    env: callerEnv,
  });

  if (!comptimeMethod || !isFunctionValue(comptimeMethod.value)) {
    return undefined; // No ComptimeIndex impl — fall through to runtime
  }

  const fnType = comptimeMethod.type;
  const fnValue = comptimeMethod.value;

  // Create a comptime pointer to self for the first argument
  const selfPtrType = createPtrType(valueType);
  const selfPtrValue = createPtrValue(selfPtrType, [selfValue]);

  // Set up the calleeEnv with parameter bindings.
  // Use the function type's captured env as the base, then push a frame
  // with self and idx parameter values bound.
  let calleeEnv = pushEnvFrame(fnType.env);
  const selfParam = fnType.parameters[0]!;
  const idxParam = fnType.parameters[1]!;
  const paramToken = expr.func.token ?? PlaceholderToken;
  ({ env: calleeEnv } = addVariableToEnv({
    env: calleeEnv,
    variable: {
      name: selfParam.label,
      type: selfParam.type,
      value: [selfPtrValue],
      isCompileTimeOnly: true,
      isOwningTheRcValue: false,
      initializedAtToken: paramToken,
      consumedAtToken: undefined,
      token: paramToken,
    },
  }));
  ({ env: calleeEnv } = addVariableToEnv({
    env: calleeEnv,
    variable: {
      name: idxParam.label,
      type: idxParam.type,
      value: [argValue],
      isCompileTimeOnly: true,
      isOwningTheRcValue: false,
      initializedAtToken: paramToken,
      consumedAtToken: undefined,
      token: paramToken,
    },
  }));

  // Call the ComptimeIndex method as a comptime function.
  // Override isValidatingFunctionDefinition so the body actually executes
  // (we have concrete comptime values, not validation placeholders).
  const comptimeContext = {
    ...context,
    isValidatingFunctionDefinition: undefined,
  };
  const result = evaluateComptimeFunctionCall({
    functionCalleeExpr: expr.func,
    functionType: fnType,
    functionValue: fnValue,
    argValues: {
      forallArgs: [],
      args: [
        {
          value: selfPtrValue,
          parameterType: selfParam.type,
          argType: selfPtrType,
        },
        {
          value: argValue,
          parameterType: idxParam.type,
          argType,
        },
      ],
      variadicArgs: [],
    },
    callerEnv,
    calleeEnv,
    context: comptimeContext,
  });

  const returnValue = result.value;

  // A matched ComptimeIndex impl with concrete comptime inputs should surface
  // its evaluation errors instead of silently downgrading to runtime dispatch.
  const ptrReturnType = fnType.return.type;
  if (!isPtrType(ptrReturnType)) {
    return undefined;
  }
  const outputType = ptrReturnType.childType;

  // If the return is a PtrValue, deref it to get the actual value
  if (isPtrValue(returnValue)) {
    const target = returnValue.targetValue[0];
    let dereferencedValue: Value;
    let comptimeRef: ComptimeRef | undefined;

    if (isArrayValue(target)) {
      dereferencedValue = target.elements[returnValue.targetIndex]!;
      comptimeRef = {
        kind: "array",
        arrayValue: target,
        index: returnValue.targetIndex,
      };
    } else if (isStructValue(target)) {
      dereferencedValue = target.fields[returnValue.targetIndex] ?? target;
      comptimeRef = {
        kind: "struct",
        structValue: target,
        fieldIndex: returnValue.targetIndex,
      };
    } else if (isTupleValue(target)) {
      dereferencedValue = target.fields[returnValue.targetIndex] ?? target;
      comptimeRef = {
        kind: "tuple",
        tupleValue: target,
        fieldIndex: returnValue.targetIndex,
      };
    } else {
      dereferencedValue = target;
    }

    // Also find the runtime Index method for codegen
    const runtimeMethod = findIndexMethod({
      concreteType: valueType,
      argType,
      env: callerEnv,
    });

    return {
      value: dereferencedValue,
      type: outputType,
      ptrType: ptrReturnType,
      indexMethodType: runtimeMethod?.type,
      indexMethodValue: runtimeMethod?.value,
      callerEnv,
      comptimeRef,
    };
  }

  // Return value is not a PtrValue (e.g., UnknownValue during validation,
  // or builtin functions like __yo_comptime_list_index that return the element directly)
  // Propagate comptimeRef from the comptime function call if available.
  const runtimeMethod = findIndexMethod({
    concreteType: valueType,
    argType,
    env: callerEnv,
  });

  return {
    value: returnValue,
    type: outputType,
    ptrType: ptrReturnType,
    indexMethodType: runtimeMethod?.type,
    indexMethodValue: runtimeMethod?.value,
    callerEnv,
    comptimeRef: result.comptimeRef,
  };
}

/**
 * Check if a type has any matching Index impl for a given argument type.
 * This is a lightweight check used before committing to Index dispatch.
 */
export function hasIndexImpl({
  concreteType,
  argExprs,
  callerEnv,
  _context,
}: {
  concreteType: Type;
  argExprs: Expr[];
  callerEnv: Environment;
  _context: EvaluatorContext;
}): boolean {
  if (argExprs.length !== 1) {
    return false;
  }

  // Fast path: Array always has Index impls (defined in prelude)
  if (isArrayType(concreteType)) {
    return true;
  }

  // Check if there are any "index" methods at all.
  // Wrap in try/catch because findMethodsFromGenericImpls may fail during
  // specialization (e.g., Self.Output resolution fails for built-in types
  // whose Index impl hasn't been attached yet).
  try {
    const methods = findAllIndexMethods({ concreteType, env: callerEnv });
    return methods.length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// Comptime Index Helpers
// ============================================================================

/**
 * Resolves a prelude type constructor (like Range or RangeInclusive) applied to usize.
 * Looks up the constructor by name from env, calls it with usize, returns the result type.
 */
function resolvePreludeTypeWithUsize(
  name: string,
  env: Environment,
  context: EvaluatorContext
): StructType | undefined {
  const variables = getVariablesFromEnv(env, name);
  const variable = variables.find(
    (v) => v.value?.[0] && isFunctionValue(v.value[0]) && isFunctionType(v.type)
  );
  if (
    !variable ||
    !variable.value?.[0] ||
    !isFunctionValue(variable.value[0])
  ) {
    return undefined;
  }

  const funcValue = variable.value[0];
  const funcType = funcValue.type;
  const usizeTypeValue = createTypeValue(createUsizeType());

  try {
    const { value: resultValue } = evaluateComptimeFunctionCall({
      functionCalleeExpr: undefined,
      functionType: funcType,
      functionValue: funcValue,
      argValues: {
        forallArgs: [],
        args: [
          {
            value: usizeTypeValue,
            parameterType: funcType.parameters[0]!.type,
            argType: usizeTypeValue.type,
          },
        ],
        variadicArgs: [],
      },
      callerEnv: env,
      calleeEnv: env,
      context,
    });

    if (isTypeValue(resultValue) && isStructType(resultValue.value)) {
      return resultValue.value;
    }
  } catch {
    // If type constructor call fails, return undefined
  }
  return undefined;
}

// Cache Range(usize) and RangeInclusive(usize) lookups per compilation.
// Keyed on the first env frame to avoid stale cache across compilations.
const rangeTypeCache = new WeakMap<
  object,
  { range: StructType | undefined; rangeInclusive: StructType | undefined }
>();

function getCachedRangeTypes(
  env: Environment,
  context: EvaluatorContext
): { range: StructType | undefined; rangeInclusive: StructType | undefined } {
  const key = env.frames[0]!;
  let cached = rangeTypeCache.get(key);
  if (!cached) {
    cached = {
      range: resolvePreludeTypeWithUsize("Range", env, context),
      rangeInclusive: resolvePreludeTypeWithUsize(
        "RangeInclusive",
        env,
        context
      ),
    };
    rangeTypeCache.set(key, cached);
  }
  return cached;
}

/**
 * Checks whether `argType` is compatible with Range(usize) or RangeInclusive(usize).
 * Returns { isRange: true, isInclusive: boolean } or { isRange: false }.
 */
function checkRangeType(
  argType: Type,
  env: Environment,
  context: EvaluatorContext
): { isRange: boolean; isInclusive: boolean } {
  if (!isStructType(argType)) {
    return { isRange: false, isInclusive: false };
  }

  const { range: rangeType, rangeInclusive: rangeInclusiveType } =
    getCachedRangeTypes(env, context);

  if (
    rangeInclusiveType &&
    areTypesCompatible(
      { type: rangeInclusiveType, env },
      { type: argType, env }
    )
  ) {
    return { isRange: true, isInclusive: true };
  }

  if (
    rangeType &&
    areTypesCompatible({ type: rangeType, env }, { type: argType, env })
  ) {
    return { isRange: true, isInclusive: false };
  }

  return { isRange: false, isInclusive: false };
}

/**
 * Tries to perform comptime array indexing (single element access).
 * Returns an IndexCallResult if successful, or undefined to fall through to runtime dispatch.
 * Range arguments always fall through to the runtime path (the evaluator
 * rewrites runtime ranges to slice_copy method calls before reaching here).
 */
function tryComptimeArrayIndex({
  argExpr,
  arrayValue,
  arrayType,
  env,
  context,
}: {
  argExpr: Expr;
  arrayValue: ArrayValue;
  arrayType: ArrayType;
  env: Environment;
  context: EvaluatorContext;
}): IndexCallResult | undefined {
  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      expectedType: undefined,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate argument expression:\n${exprToString(argExpr)}`,
    });
  }
  const callerEnv = evaluatedArgExpr.$.env;
  const argType = evaluatedArgExpr.$.type;
  const argValue = evaluatedArgExpr.$.value;

  const { isRange } = checkRangeType(argType, env, context);

  if (isRange) {
    // Range slicing is no longer a comptime operation — fall through to the
    // runtime path (slice_copy rewriting happens before Index dispatch).
    return undefined;
  }

  // Single element access with comptime index
  return tryComptimeElementAccess({
    argExpr,
    argValue,
    arrayValue,
    arrayType,
    callerEnv,
    context,
  });
}

function tryComptimeElementAccess({
  argExpr,
  argValue,
  arrayValue,
  arrayType,
  callerEnv,
  context,
}: {
  argExpr: Expr;
  argValue: Value | undefined;
  arrayValue: ArrayValue;
  arrayType: ArrayType;
  callerEnv: Environment;
  context: EvaluatorContext;
}): IndexCallResult | undefined {
  const returnType = arrayType.childType;

  if (isNumberValue(argValue)) {
    const indexValue = argValue.value;
    const index =
      typeof indexValue === "bigint" ? Number(indexValue) : indexValue;

    if (index < 0 || index >= arrayValue.elements.length) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Array index out of bounds: ${index}. Expected index in range [0, ${arrayValue.elements.length - 1}].`,
      });
    }
    const elementValue = arrayValue.elements[index]!;
    return {
      value: elementValue,
      type: returnType,
      ptrType: createPtrType(returnType),
      indexMethodType: undefined,
      indexMethodValue: undefined,
      callerEnv,
      index,
      comptimeRef: { kind: "array", arrayValue, index },
    };
  } else if (!argValue) {
    // Runtime index into comptime array: convert to runtime type
    return {
      value: undefined,
      type: convertComptimeTypeToRuntimeType({
        type: returnType,
        env: callerEnv,
      }),
      ptrType: createPtrType(returnType),
      indexMethodType: undefined,
      indexMethodValue: undefined,
      callerEnv,
    };
  } else {
    // Unknown comptime value (e.g., UnknownValue)
    const unknownValue = createUnknownValue(returnType, {
      env: callerEnv,
      context,
    });
    return {
      value: unknownValue,
      type: returnType,
      ptrType: createPtrType(returnType),
      indexMethodType: undefined,
      indexMethodValue: undefined,
      callerEnv,
    };
  }
}

/**
 * Tries to perform comptime_str indexing: "hello"(0), "hello"(0..3), etc.
 * Returns an IndexCallResult if successful, throws on error.
 */
function tryComptimeStringIndex({
  argExpr,
  strValue,
  env,
  context,
}: {
  argExpr: Expr;
  strValue: string;
  env: Environment;
  context: EvaluatorContext;
}): IndexCallResult {
  const evaluatedArg = evaluateExpression({
    expr: argExpr,
    env,
    context: { ...context, expectedType: undefined },
  });
  if (!evaluatedArg.$ || !evaluatedArg.$.value) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate index argument for comptime string indexing`,
    });
  }
  const argType = evaluatedArg.$.type;
  const argValue = evaluatedArg.$.value;
  const callerEnv = evaluatedArg.$.env;

  const { isRange, isInclusive } = checkRangeType(argType, env, context);

  const resultValue = computeComptimeStringIndex({
    strValue,
    argValue,
    token: argExpr.token,
    isRange,
    isInclusive,
  });

  const resultType = resultValue.type;
  const ptrResultType = createPtrType(resultType);

  return {
    value: resultValue,
    type: resultType,
    ptrType: ptrResultType,
    indexMethodType: undefined,
    indexMethodValue: undefined,
    callerEnv,
  };
}
