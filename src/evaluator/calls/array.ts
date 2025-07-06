import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, exprToString, FuncCallExpr } from "../../expr";
import {
  areTypesCompatible,
  ArrayType,
  createUsizeType,
  SliceType,
  typeToString,
} from "../../types";
import { ArrayValue, createUnknownValue, isNumberValue } from "../../value";
import { ArrayCallResult, EvaluatorContext } from "../context";

/**
 * This is mainly used to access the array element by index.
 * eg:
 *
 *   arr := [1, 2, 3];
 *   x := arr(0);
 */
export function tryToCallArrayWithArguments({
  expr,
  arrayType,
  arrayValue,
  argExprs,
  callerEnv,
  context,
}: {
  expr: FuncCallExpr;
  arrayType: ArrayType | SliceType;
  arrayValue: ArrayValue | undefined;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
}): ArrayCallResult {
  if (argExprs.length !== 1) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `Expect 1 argument for accessing array element, got ${argExprs.length}.`,
    });
  }

  // Evaluate the first argument
  const argExpr = argExprs[0]!;
  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env: callerEnv,
    context: {
      ...context,
    },
  });
  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate argument expression:\n${exprToString(argExpr)}`,
    });
  }

  // Check if the argType matches the usize
  const argType = evaluatedArgExpr.$.type;
  if (
    !areTypesCompatible(
      {
        type: createUsizeType(),
        env: callerEnv,
      },
      {
        type: argType,
        env: callerEnv,
      }
    )
  ) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Expected usize for array index, got:\n${typeToString(argType)}`,
    });
  }

  const elementType = arrayType.elementType;

  // It's compile time known value
  if (arrayValue) {
    if (isNumberValue(evaluatedArgExpr.$.value)) {
      const index = evaluatedArgExpr.$.value.value;
      if (index < 0 || index >= arrayValue.elements.length) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Array index out of bounds: ${index}. Expected index in range [0, ${arrayValue.elements.length - 1}].`,
        });
      }
      const value = arrayValue.elements[index]!;
      return { value, elementType };
    } else {
      // TODO: Check the index bound?
      const value = createUnknownValue(arrayType.elementType);
      return { value, elementType };
    }
  }
  // It's runtime known value
  else {
    return { value: undefined, elementType };
  }
}
