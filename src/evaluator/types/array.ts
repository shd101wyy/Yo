import { addVariableToEnv, Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  exprIsAtom,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  createArrayType,
  createUsizeType,
} from "../../types";
import {
  createTypeValue,
  createUnknownValue,
  isTypeValue,
  isUnknownValue,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

export function evaluateArrayType({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  if (!exprIsFunctionCallOf(expr, BuiltinKeywords.Array, 2)) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected "Array(comptime(Type), comptime(usize))" with 2 arguments, like "Array(i32, 10)"
Got:\n${exprToString(expr)}`,
    });
  }

  const elementTypeExpr = expr.args[0]!;
  const lengthExpr = expr.args[1]!;

  // Check if length is underscore placeholder for inference
  const isLengthUnderscore =
    exprIsAtom(lengthExpr) && lengthExpr.token.value === "_";

  // Evaluate the element type expression
  const evaluatedElementTypeExpr = evaluateExpression({
    expr: elementTypeExpr,
    env,
    context: {
      ...context,
    },
  });
  if (!evaluatedElementTypeExpr.$) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Failed to evaluate the element type expression:\n${exprToString(
        elementTypeExpr
      )}`,
    });
  }
  if (!isTypeValue(evaluatedElementTypeExpr.$.value)) {
    throw formatErrorMessage({
      token: elementTypeExpr.token,
      errorMessage: `Expected type for element type, got:\n${exprToString(elementTypeExpr)}

If you are creating an array value with 1 element, please consider adding a "," in the end, like [1,]`,
    });
  }
  const childType = evaluatedElementTypeExpr.$.value.value;

  // Handle underscore placeholder for length inference
  if (isLengthUnderscore) {
    // Create an unknown value with a unique variable name for length inference
    const lengthPlaceholderName = `_array_length_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const unknownLength = createUnknownValue(
      createUsizeType(),
      lengthPlaceholderName
    );

    // Add the unknown variable to the environment
    const { env: envWithUnknownVar } = addVariableToEnv({
      env: evaluatedElementTypeExpr.$.env,
      variable: {
        name: lengthPlaceholderName,
        value: [unknownLength],
        type: createUsizeType(),
        isCompileTimeOnly: true,
        token: lengthExpr.token,
        initializedAtToken: lengthExpr.token,
        consumedAtToken: undefined,
        isOwningTheRcValue: false,
      },
    });

    const arrayType = createArrayType(childType, unknownLength);
    const arrayTypeValue = createTypeValue(arrayType);

    expr.$ = {
      env: envWithUnknownVar,
      type: arrayTypeValue.type,
      value: arrayTypeValue,
      pathCollection: [],
    };
    return expr;
  }

  // Evaluate the length expression
  const evaluatedLengthExpr = evaluateExpression({
    expr: lengthExpr,
    env,
    context: {
      ...context,
      expectedType: {
        type: createUsizeType(),
        env,
      },
    },
  });
  if (!evaluatedLengthExpr.$) {
    throw formatErrorMessage({
      token: lengthExpr.token,
      errorMessage: `Failed to evaluate the length expression:\n${exprToString(lengthExpr)}`,
    });
  }
  if (
    !areTypesCompatible(
      {
        type: createUsizeType(),
        env,
      },
      {
        type: evaluatedLengthExpr.$.type,
        env,
      }
    )
  ) {
    throw formatErrorMessage({
      token: lengthExpr.token,
      errorMessage: `Expected usize for length, got:\n${exprToString(lengthExpr)}`,
    });
  }

  const lengthValue = evaluatedLengthExpr.$.value;
  if (!lengthValue) {
    throw formatErrorMessage({
      token: lengthExpr.token,
      errorMessage: `Expected compile-time known value for length, got:\n${exprToString(lengthExpr)}`,
    });
  }

  if (isUnknownValue(lengthValue)) {
    // QUESTION: Should we do it this way?
    // Change its type to usize
    lengthValue.type = createUsizeType();
  }

  const arrayType = createArrayType(childType, lengthValue);
  const arrayTypeValue = createTypeValue(arrayType);

  expr.$ = {
    env: evaluatedLengthExpr.$.env,
    type: arrayTypeValue.type,
    value: arrayTypeValue,
    pathCollection: [],
  };
  return expr;
}
