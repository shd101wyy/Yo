import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  attachTempVariableToExpr,
  type Expr,
  type FnCallExpr,
  setExprAsNeedsToCallDup,
} from "../../expr";
import { areTypesCompatible } from "../../types/compatibility";
import { createArrayType } from "../../types/creators";
import type { ArrayType } from "../../types/definitions";
import { isArrayType } from "../../types/guards";
import { typeToString } from "../../types/utils";
import {
  createArrayValue,
  createComptimeIntValue,
  isNumberValue,
  isUnknownValue,
  type Value,
} from "../../value";
import type { EvaluatorContext } from "../context";
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
  const runtimeArgExprsInOrder: Expr[] = [];
  let allElementsAreComptime = true;
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

    // Record the element for codegen either way; whether the ARRAY as a whole
    // is a compile-time constant is decided below.
    runtimeArgExprsInOrder.push(evaluatedArg);

    // Store the value if available (for compile-time arrays). An
    // `UnknownValue` does NOT count: it means "type known, value not" — a
    // RUNTIME element — so an array containing one is not a constant.
    if (
      evaluatedArg.$.value !== undefined &&
      !isUnknownValue(evaluatedArg.$.value)
    ) {
      elements.push(evaluatedArg.$.value);
    } else {
      allElementsAreComptime = false;
    }
  }

  // Only a fully compile-time array gets a compile-time value. Stamping one
  // with manufactured `UnknownValue` placeholders (as this used to) told
  // codegen "emit this as a constant", and its comptime emitter has no case
  // for an Unknown — it produced
  //   .data = { /* skip generating: <comptime Box(i32)> */, ... }
  // i.e. an EMPTY initializer slot, so any array of RC/reference elements
  // failed to compile with "expected expression". The array-LITERAL path
  // (values/array.ts) already guarded this way, which is why `[a, b,]` worked
  // while `Array(T, N)(a, b)` did not.
  //
  // Leaving the value undefined routes the expression to the same runtime
  // emitter the literal form uses (`generateAnonymousArray`), which builds
  // the struct from `runtimeArgExprsInOrder` and honours the per-element
  // deferred dups already attached above.
  const arrayValue = allElementsAreComptime
    ? createArrayValue(finalArrayType, elements)
    : undefined;

  // Set the result
  expr.$ = {
    env,
    value: arrayValue,
    type: finalArrayType,
    pathCollection: [],
    runtimeArgExprsInOrder,
  };

  if (!arrayValue) {
    // Runtime construction needs a temp to materialize into, exactly as the
    // array-literal path does.
    attachTempVariableToExpr(expr, true);
  }

  return expr;
}
