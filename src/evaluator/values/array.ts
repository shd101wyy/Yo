import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  type Expr,
  exprToString,
  type FnCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import { createArrayType } from "../../types/creators";
import type { Type } from "../../types/definitions";
import { isArrayType } from "../../types/guards";
import {
  convertComptimeTypeToRuntimeType,
  typeToString,
} from "../../types/utils";
import { createArrayValue, createNumberValue, type Value } from "../../value";
import { ValueTag } from "../../value-tag";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateArrayValue({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const arrayElementExprs = expr.args;

  // NOTE: We disallow the empty array for now.
  if (arrayElementExprs.length === 0) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected at least one element in array, got ${arrayElementExprs.length}`,
    });
  }

  const arrayLength = arrayElementExprs.length;
  let arrayElementType: Type | undefined = undefined;

  // Check if we have an expected array type from the context
  let expectedElementType: Type | undefined = undefined;
  if (context.expectedType && isArrayType(context.expectedType.type)) {
    expectedElementType = context.expectedType.type.childType;
  }
  const arrayElementValues: (Value | undefined)[] = [];
  const runtimeArgExprsInOrder: Expr[] = [];
  for (let i = 0; i < arrayElementExprs.length; i++) {
    const arrayElementExpr = arrayElementExprs[i]!;
    const evaluatedElement = evaluateExpression({
      expr: arrayElementExpr,
      env,
      context: {
        ...context,
        expectedType: expectedElementType
          ? { type: expectedElementType, env }
          : undefined,
      },
    });

    setExprAsNeedsToCallDup(evaluatedElement, context);

    if (!evaluatedElement.$) {
      throw formatErrorMessage({
        token: arrayElementExpr.token,
        errorMessage: `Failed to evaluate array element: ${exprToString(arrayElementExpr)}`,
      });
    }
    env = evaluatedElement.$.env;

    // Save value
    arrayElementValues.push(evaluatedElement.$.value);

    // Check type
    if (!arrayElementType) {
      arrayElementType = expectedElementType || evaluatedElement.$.type;
    } else {
      // Check if the type of the element matches the first element type
      if (
        !areTypesCompatible(
          { type: arrayElementType, env },
          { type: evaluatedElement.$.type, env }
        )
      ) {
        // Check if types match when converting to runtime type.
        // For example:
        //    x := 12; // x: i32
        //    arr := [1, x, 3];
        //    -  1: comptime_int
        //    -  x: i32
        //    Here we convert comptime_int to i32 to check compatibility.
        if (
          areTypesCompatible(
            {
              type: convertComptimeTypeToRuntimeType({
                type: arrayElementType,
                expectedType: undefined,
                expr: undefined,
                env,
              }),
              env,
            },
            {
              type: evaluatedElement.$.type,
              env,
            }
          )
        ) {
          arrayElementType = evaluatedElement.$.type;
        } else {
          throw formatErrorMessage({
            token: arrayElementExpr.token,
            errorMessage: `Array element type mismatch:
Expected type: ${typeToString(arrayElementType)}
Given type: ${typeToString(evaluatedElement.$.type)}`,
          });
        }
      }
    }

    // Add to runtimeArgExprsInOrder
    runtimeArgExprsInOrder.push(evaluatedElement);
  }

  const arrayType = createArrayType(
    arrayElementType!,
    createNumberValue(ValueTag.Usize, arrayLength)
  );

  const arrayValue = arrayElementValues.every((val) => !!val)
    ? createArrayValue(arrayType, arrayElementValues as Value[])
    : undefined;

  expr.$ = {
    env,
    type: arrayType,
    value: arrayValue,
    pathCollection: [],
    runtimeArgExprsInOrder,
  };

  // Attach temp variable to the expr
  attachTempVariableToExpr(expr, true);

  return expr;
}
