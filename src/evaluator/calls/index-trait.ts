import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { type Expr, type FnCallExpr, exprToString } from "../../expr";
import type { FunctionType, TraitType, Type } from "../../types/definitions";
import { areTypesCompatible } from "../../types/compatibility";
import {
  isArrayType,
  isFunctionType,
  isPtrType,
  isSliceType,
} from "../../types/guards";
import { typeToString } from "../../types/utils";
import type { Value } from "../../value";
import {
  createUnknownValue,
  isArrayValue,
  isComptimeStringValue,
  isFunctionValue,
  isSliceValue,
  isTraitValue,
  isUnknownValue,
} from "../../value";
import type { EvaluatorContext, IndexCallResult } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { findMethodsFromGenericImpls } from "../values/impl";
import {
  tryComptimeArraySliceIndex,
  tryComptimeStringIndex,
} from "./comptime-index";

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

  // Find a method whose signature matches: (self: *(Self), idx: ArgType) -> *(Output)
  for (const method of methods) {
    const fnType = method.type;
    // Must have exactly 2 parameters: self and idx
    if (fnType.parameters.length !== 2) {
      continue;
    }
    const selfParam = fnType.parameters[0]!;
    const idxParam = fnType.parameters[1]!;

    // self must be a pointer type
    if (!isPtrType(selfParam.type)) {
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
 * For comptime values (arrays, slices, strings), this function directly
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
  const sliceValue =
    selfValue && isSliceValue(selfValue) ? selfValue : undefined;
  const stringValue =
    selfValue && isComptimeStringValue(selfValue) ? selfValue.value : undefined;
  const hasComptimeValue = !!(
    arrayValue ||
    sliceValue ||
    stringValue !== undefined
  );

  // For comptime array/slice values, try comptime dispatch first
  if (
    hasComptimeValue &&
    (arrayValue || sliceValue) &&
    (isArrayType(valueType) || isSliceType(valueType))
  ) {
    const comptimeResult = tryComptimeArraySliceIndex({
      argExpr,
      arrayValue,
      sliceValue,
      arrayType: valueType as
        | import("../../types/definitions").ArrayType
        | import("../../types/definitions").SliceType,
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

  // Fast path: Array and Slice always have Index impls (defined in prelude)
  if (isArrayType(concreteType) || isSliceType(concreteType)) {
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
