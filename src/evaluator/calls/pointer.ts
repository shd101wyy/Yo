import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { exprToString, type FnCallExpr } from "../../expr";
import { createPtrType } from "../../types/creators";
import { isPtrType } from "../../types/guards";
import { typeIsControlBound, typeToString } from "../../types/utils";
import { createTypeValue, isTypeValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Evaluate a raw pointer call
 * For example:
 *
 * I32Ptr :: *(i32);
 * x := 1;
 * p := &(x); // p: *(i32)
 */
export function evaluateRawPointerCall({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const argExpr = expr.args[0]!;

  let expectedType = context.expectedType;
  if (expectedType && isPtrType(expectedType.type)) {
    // If the expected type is a reference type, we need to use the base type
    // for the reference creation.
    expectedType = {
      ...expectedType,
      type: expectedType.type.childType,
    };
  } else {
    // QUESTION: Should we set expectedType to undefined?
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
      errorMessage: `Failed to evaluate the argument expression for pointer:\n${exprToString(
        argExpr
      )}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  // Check if the argExpr is a type
  // Create pointer type
  if (isTypeValue(evaluatedArgExpr.$.value)) {
    const typeValue = evaluatedArgExpr.$.value;
    const baseType = typeValue.value;

    // §4 escape boundary (rule 11): a pointer/reference type cannot
    // have a control-bound pointee. Pointers to control-bound storage
    // would let writes-through-pointer escape the install frame —
    // e.g. `slot.* = local_cf` where `slot` lives at an outer frame.
    // Banning the type entirely prevents the construction.
    if (typeIsControlBound(baseType)) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Cannot form a pointer to a control-bound type. The pointee transitively contains a \`ctl(...) -> ret\` function value, whose lifetime is bound to its install frame. A pointer would allow writes-through-indirection that escape that frame.

Pointee type: ${typeToString(baseType)}

If you need to thread a handler through code, pass it by value (handlers are fn-pointer-sized; copying is free).`,
      });
    }

    // Create the pointer type
    const pointerType = createPtrType(baseType);
    const typeValueForPointer = createTypeValue(pointerType);
    expr.$ = {
      env,
      type: typeValueForPointer.type,
      value: typeValueForPointer,
      pathCollection: [],
    };
    return expr;
  }
  // Create pointer value
  else {
    // Throw error. Should use & to create a pointer to a value.
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Cannot create a pointer to a value. Use "&" to create a pointer to a value:\n${exprToString(
        argExpr
      )}`,
    });
  }
}
