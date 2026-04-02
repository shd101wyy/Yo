import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { type Expr, exprToString, type FnCallExpr } from "../../expr";
import type { FunctionType, TraitType, Type } from "../../types/definitions";
import { areTypesCompatible } from "../../types/compatibility";
import { isFunctionType, isPtrType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import type { Value } from "../../value";
import {
  createUnknownValue,
  isFunctionValue,
  isTraitValue,
  isUnknownValue,
} from "../../value";
import type { EvaluatorContext, IndexCallResult } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { findMethodsFromGenericImpls } from "../values/impl";

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
 * Returns the auto-dereferenced result (Output type) and the pre-deref pointer type
 * for supporting &(value(arg)).
 */
export function tryToCallWithIndexTrait({
  expr,
  valueType,
  argExprs,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  valueType: Type;
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

  // Evaluate the argument to get its type
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

  // Check if there are any "index" methods at all
  const methods = findAllIndexMethods({ concreteType, env: callerEnv });

  return methods.length > 0;
}
