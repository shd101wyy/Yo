import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { Expr, FnCallExpr, setExprAsNeedsToCallDup } from "../../expr";
import {
  areTypesCompatible,
  ArrayType,
  createArrayType,
  isArrayType,
  typeToString,
} from "../../types";
import {
  createArrayValue,
  createComptimeIntValue,
  createUnknownValue,
  isNumberValue,
  isUnknownValue,
  Value,
} from "../../value";
import { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * This function creates an array value from an ArrayType and initial values.
 * eg:
 *
 *   ArrayType :: Array(i32, 3);
 *   arr := ArrayType(1, 2, 3);
 */
export function tryToImplementArrayByArrayType({
  expr,
  arrayType,
  argExprs,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  arrayType: ArrayType;
  argExprs: Expr[];
  callerEnv: Environment;
  context: EvaluatorContext;
}): Expr {
  // Get the expected array length
  const expectedLength = arrayType.length;
  let finalArrayType = arrayType;
  let expectedLengthValue: number;

  if (isNumberValue(expectedLength)) {
    // Known length - validate argument count matches
    expectedLengthValue = Number(expectedLength.value);

    if (argExprs.length !== expectedLengthValue) {
      throw formatErrorMessage({
        token: expr.func.token,
        errorMessage: `Array constructor expects ${expectedLengthValue} elements, got ${argExprs.length}.`,
      });
    }
  } else if (isUnknownValue(expectedLength)) {
    // Unknown length - infer from argument count
    expectedLengthValue = argExprs.length;

    // Create a new array type with the inferred length
    const inferredLength = createComptimeIntValue(BigInt(expectedLengthValue));
    finalArrayType = createArrayType(arrayType.childType, inferredLength);
  } else {
    throw formatErrorMessage({
      token: expr.func.token,
      errorMessage: `Array length must be a known number value or unknown (_), got ${expectedLength}.`,
    });
  }

  // Evaluate each argument and check type compatibility
  const elements: Value[] = [];
  let env = callerEnv;

  // Keep track of the expected element type, which may need updating for nested arrays
  let expectedElementType = finalArrayType.childType;

  for (let i = 0; i < argExprs.length; i++) {
    const argExpr = argExprs[i]!;

    // Evaluate the argument with the expected element type
    const evaluatedArg = evaluateExpression({
      expr: argExpr,
      env,
      context: {
        ...context,
        expectedType: { type: expectedElementType, env },
      },
    });

    if (!evaluatedArg.$) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate array element at index ${i}.`,
      });
    }

    setExprAsNeedsToCallDup(evaluatedArg, context);

    env = evaluatedArg.$.env;

    // For the first argument, if the expected element type contains unknowns,
    // update it based on the actual evaluated type
    if (i === 0 && isArrayType(expectedElementType)) {
      const expectedArrayType = expectedElementType as ArrayType;
      if (
        isUnknownValue(expectedArrayType.length) &&
        isArrayType(evaluatedArg.$.type)
      ) {
        expectedElementType = evaluatedArg.$.type;
        // Update the final array type with the concrete element type
        finalArrayType = createArrayType(
          expectedElementType,
          finalArrayType.length
        );
      }
    }

    // Check type compatibility with the expected element type
    if (
      !areTypesCompatible(
        { type: expectedElementType, env },
        { type: evaluatedArg.$.type, env }
      )
    ) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Array element at index ${i} has incompatible type:
- Expected: ${typeToString(expectedElementType)}
- Given   : ${typeToString(evaluatedArg.$.type)}`,
      });
    }

    // Store the value if available (for compile-time arrays)
    if (evaluatedArg.$.value !== undefined) {
      elements.push(evaluatedArg.$.value);
    } else {
      // For runtime arrays, we'll create unknown values as placeholders
      elements.push(createUnknownValue(expectedElementType));
    }
  }

  // Create the array value
  const arrayValue = createArrayValue(finalArrayType, elements);

  // Set the result
  expr.$ = {
    env,
    value: arrayValue,
    type: finalArrayType,
    pathCollection: [],
  };

  return expr;
}
