import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  BuiltinFunctions,
  expectExprToBeFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { createPtrType } from "../../types/creators";
import {
  isComptimeFloatType,
  isComptimeIntType,
  isComptimeStringType,
  isPtrType,
} from "../../types/guards";
import { convertComptimeTypeToRuntimeType } from "../../types/utils";
import {
  createPtrValue,
  createUnknownValue,
  isTypeValue,
  isUnknownValue,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";
import { isImplicitlyUnsafeCapableFile } from "../memory-safety";

/**
 * Evaluate a address call
 * For example:
 *
 * &(x)
 */
export function evaluateAddressCall({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinFunctions.__yo_address_of, 1);

  // Phase C structural gate: `&(expr)` produces a raw pointer
  // value (`*(T)`). In safe code, that value would have type `*(T)`,
  // which the surrounding rules say isn't permitted. Reject at the
  // construction site so the diagnostic points at the `&(...)` call
  // rather than at some downstream use of the resulting pointer.
  // See plans/MEMORY_SAFETY.md "What Safe Code Cannot Do".
  if (
    !context.unsafeContext &&
    !isImplicitlyUnsafeCapableFile(expr.token.modulePath)
  ) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Taking an address with '&(...)' produces a raw pointer ('*(T)'), which is not available in safe code.

For in-place mutation of a value, use the 'ref(name) : T' parameter form on the receiving function. For collections, the safe types (Slice(T), ArrayList(T), HashMap(K, V)) own their interior pointers — don't take an address of an element manually. If this file genuinely needs raw pointers, add 'pragma(Pragma.AllowUnsafe);' at the top.`,
    });
  }

  const argExpr = expr.args[0]!;

  let expectedType = context.expectedType;
  if (expectedType && isPtrType(expectedType.type)) {
    // If the expected type is a pointer type, we need to use the base type
    // for the reference creation.
    expectedType = {
      ...expectedType,
      type: expectedType.type.childType,
    };
  }

  const evaluatedArgExpr = evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
      expectedType,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for reference:\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    // Throw error. Should use * to create pointer to type
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot create a pointer to a type. Did you mean to use "*"?\n${exprToString(
        argExpr
      )}`,
    });
  }
  // Create pointer value
  else {
    let argType = evaluatedArgExpr.$.type;

    // If the argument is a comptime type, convert it to its runtime equivalent
    // before creating the pointer type. This ensures we get *(str) instead of *(comptime_str).
    if (
      isComptimeIntType(argType) ||
      isComptimeFloatType(argType) ||
      isComptimeStringType(argType)
    ) {
      const runtimeType = convertComptimeTypeToRuntimeType({
        type: argType,
        expectedType: expectedType?.type,
        expr: evaluatedArgExpr,
        env,
      });
      // Update the argument's type and set convertedRuntimeType for codegen
      evaluatedArgExpr.$.type = runtimeType;
      evaluatedArgExpr.$.convertedRuntimeType = runtimeType;
      argType = runtimeType;
    }

    const pointerType = createPtrType(argType);

    // Check if we can create a compile-time pointer first.
    // This requires the source expression to have a sourceVariable with a value array
    // OR a comptimeRef for element/field access like &(arr(0)) or &(point(0)).
    // We check comptimeRef BEFORE indexTraitPtrType because comptime arrays
    // set both properties, and comptimeRef allows creating a comptime pointer
    // whereas indexTraitPtrType would return a runtime-only pointer.
    const sourceVariable = evaluatedArgExpr.$.sourceVariable;
    const comptimeRef = evaluatedArgExpr.$.comptimeRef;

    if (comptimeRef) {
      let ptrValue;
      switch (comptimeRef.kind) {
        case "array":
          ptrValue = createPtrValue(
            pointerType,
            [comptimeRef.arrayValue],
            comptimeRef.index
          );
          break;
        case "comptime_list":
          ptrValue = createPtrValue(
            pointerType,
            [comptimeRef.listValue],
            comptimeRef.index
          );
          break;
        case "struct":
          ptrValue = createPtrValue(
            pointerType,
            [comptimeRef.structValue],
            comptimeRef.fieldIndex
          );
          break;
        case "tuple":
          ptrValue = createPtrValue(
            pointerType,
            [comptimeRef.tupleValue],
            comptimeRef.fieldIndex
          );
          break;
      }

      expr.$ = {
        env,
        type: pointerType,
        value: ptrValue,
        pathCollection: evaluatedArgExpr.$.pathCollection,
        comptimeRef,
      };
    } else if (sourceVariable && sourceVariable.value) {
      // Create a compile-time pointer value that shares the value array with the source variable
      const ptrValue = createPtrValue(pointerType, sourceVariable.value);

      expr.$ = {
        env,
        type: pointerType,
        value: ptrValue,
        pathCollection: evaluatedArgExpr.$.pathCollection,
      };
    } else {
      // Check if this is &(value(i)) where value(i) was dispatched via Index trait.
      // The Index.index() method returns *(Output), which was auto-dereferenced to Output.
      // For &(value(i)), we skip the auto-deref and return the *(Output) pointer directly.
      const indexTraitPtrType = evaluatedArgExpr.$.indexTraitPtrType;
      if (indexTraitPtrType) {
        expr.$ = {
          env,
          type: indexTraitPtrType,
          value: undefined, // pointer is only available at runtime
          pathCollection: evaluatedArgExpr.$.pathCollection,
          isIndexTraitAddressOf: true,
        };
      } else if (isUnknownValue(evaluatedArgExpr.$.value)) {
        // The argument is a comptime value (UnknownValue), so &(arg) should also
        // be comptime. This handles cases like &(self.x) in ComptimeIndex impl
        // validation where self is an unknown comptime pointer.
        const ptrUnknown = createUnknownValue(pointerType, { env, context });
        expr.$ = {
          env,
          type: pointerType,
          value: ptrUnknown,
          pathCollection: evaluatedArgExpr.$.pathCollection,
        };
      } else {
        expr.$ = {
          env,
          type: pointerType,
          value: undefined, // reference is only available for runtime
          pathCollection: evaluatedArgExpr.$.pathCollection,
        };
      }
    }
    attachTempVariableToExpr(expr, false);
    return expr;
  }
}
