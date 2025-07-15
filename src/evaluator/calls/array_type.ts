import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  Expr,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  ArrayType,
  typeToString,
} from "../../types";
import { createArrayValue, createUnknownValue, isNumberValue, Value } from "../../value";
import { EvaluatorContext } from "../context";

/**
 * This function creates an array value from an ArrayType and initial values.
 * eg:
 *
 *   ArrayType := Array(i32, 3);
 *   arr := ArrayType(1, 2, 3);
 */
export function tryToImplementArrayByArrayType({
  expr,
  arrayType,
  argExprs,
  callerEnv,
  context,
}: {
  expr: FuncCallExpr;
  arrayType: ArrayType;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
}): Expr {
  // Get the expected array length
  const expectedLength = arrayType.length;
  let expectedLengthValue: number;
  
  if (isNumberValue(expectedLength)) {
    expectedLengthValue = Number(expectedLength.value);
  } else {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `Array length must be a known number value, got ${expectedLength}.`,
    });
  }

  // Check if the number of arguments matches the array length
  if (argExprs.length !== expectedLengthValue) {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `Array constructor expects ${expectedLengthValue} elements, got ${argExprs.length}.`,
    });
  }

  // Evaluate each argument and check type compatibility
  const elements: Value[] = [];
  let env = callerEnv;

  for (let i = 0; i < argExprs.length; i++) {
    const argExpr = argExprs[i]!;
    
    // Evaluate the argument
    const evaluatedArg = context.evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
        expectedType: { type: arrayType.elementType, env },
      },
    });

    if (!evaluatedArg.$) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate array element at index ${i}.`,
      });
    }

    env = evaluatedArg.$.env;

    // Check type compatibility
    if (
      !areTypesCompatible(
        { type: arrayType.elementType, env },
        { type: evaluatedArg.$.type, env }
      )
    ) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Array element at index ${i} has incompatible type:
- Expected: ${typeToString(arrayType.elementType)}
- Given   : ${typeToString(evaluatedArg.$.type)}`,
      });
    }

    // Store the value if available (for compile-time arrays)
    if (evaluatedArg.$.value !== undefined) {
      elements.push(evaluatedArg.$.value);
    } else {
      // For runtime arrays, we'll create unknown values as placeholders
      elements.push(createUnknownValue(arrayType.elementType));
    }
  }

  // Create the array value
  const arrayValue = createArrayValue(arrayType, elements);

  // Set the result
  expr.$ = {
    env,
    value: arrayValue,
    type: arrayType,
    isMutable: false,
    pathCollection: [],
  };

  return expr;
}
