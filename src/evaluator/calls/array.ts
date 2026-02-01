import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FnCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  ArrayType,
  createSliceType,
  createUsizeType,
  SliceType,
  typeToString,
} from "../../types";
import {
  ArrayValue,
  createSliceValue,
  createUnknownValue,
  isNumberValue,
  SliceValue,
} from "../../value";
import { ArrayCallResult, EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

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
  sliceValue,
  argExprs,
  callerEnv,
  context,
}: {
  expr: FnCallExpr;
  arrayType: ArrayType | SliceType;
  arrayValue: ArrayValue | undefined;
  sliceValue: SliceValue | undefined;
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

  // getting the slice
  // - arr(:)
  // - arr(0:arr.length)
  if (
    (exprIsAtom(expr.args[0]!) && exprIsAtomOf(expr.args[0]!, ":")) ||
    (exprIsFunctionCall(expr.args[0]!) &&
      exprIsFunctionCallOf(expr.args[0]!, ":"))
  ) {
    const sliceType = createSliceType(arrayType.childType);

    if (exprIsAtom(expr.args[0]!)) {
      // arr(:) - full slice
      if (arrayValue) {
        // Compile-time slice from array - create SliceValue referencing the full array
        const newSliceValue = createSliceValue(
          sliceType,
          [arrayValue],
          0,
          arrayValue.elements.length
        );
        return {
          value: newSliceValue,
          type: sliceType,
          callerEnv,
        };
      } else if (sliceValue) {
        // Compile-time slice from slice - keep the same source array reference
        // s(:) on a slice returns the full slice
        return {
          value: sliceValue,
          type: sliceType,
          callerEnv,
        };
      }
      return {
        value: undefined,
        type: sliceType,
        callerEnv,
      };
    } else {
      const startExpr = expr.args[0]!.args[0]!;
      const endExpr = expr.args[0]!.args[1]!;

      // Evaluate the start and end expressions
      const evaluatedStartExpr = evaluateExpression({
        expr: startExpr,
        env: callerEnv,
        context: {
          ...context,
          expectedType: { type: createUsizeType(), env: callerEnv },
        },
      });
      if (!evaluatedStartExpr.$) {
        throw formatErrorMessage({
          token: startExpr.token,
          errorMessage: `Failed to evaluate start expression:\n${exprToString(startExpr)}`,
        });
      }
      callerEnv = evaluatedStartExpr.$.env;

      /// Expect the start expression to be usize
      const startType = evaluatedStartExpr.$.type;
      if (
        !areTypesCompatible(
          {
            type: createUsizeType(),
            env: callerEnv,
          },
          {
            type: startType,
            env: callerEnv,
          }
        )
      ) {
        throw formatErrorMessage({
          token: startExpr.token,
          errorMessage: `Expected usize for array start index, got:\n${typeToString(startType)}`,
        });
      }

      const evaluatedEndExpr = evaluateExpression({
        expr: endExpr,
        env: callerEnv,
        context: {
          ...context,
          expectedType: { type: createUsizeType(), env: callerEnv },
        },
      });
      if (!evaluatedEndExpr.$) {
        throw formatErrorMessage({
          token: endExpr.token,
          errorMessage: `Failed to evaluate end expression:\n${exprToString(endExpr)}`,
        });
      }
      callerEnv = evaluatedEndExpr.$.env;

      /// Expect the end expression to be usize
      const endType = evaluatedEndExpr.$.type;
      if (
        !areTypesCompatible(
          {
            type: createUsizeType(),
            env: callerEnv,
          },
          {
            type: endType,
            env: callerEnv,
          }
        )
      ) {
        throw formatErrorMessage({
          token: endExpr.token,
          errorMessage: `Expected usize for array end index, got:\n${typeToString(endType)}`,
        });
      }

      // Check if we can create a compile-time slice from an array
      if (
        arrayValue &&
        isNumberValue(evaluatedStartExpr.$.value) &&
        isNumberValue(evaluatedEndExpr.$.value)
      ) {
        const startValue = evaluatedStartExpr.$.value.value;
        const endValue = evaluatedEndExpr.$.value.value;
        const startIndex =
          typeof startValue === "bigint" ? Number(startValue) : startValue;
        const endIndex =
          typeof endValue === "bigint" ? Number(endValue) : endValue;

        // Bounds checking
        if (startIndex < 0 || startIndex > arrayValue.elements.length) {
          throw formatErrorMessage({
            token: startExpr.token,
            errorMessage: `Slice start index out of bounds: ${startIndex}. Expected index in range [0, ${arrayValue.elements.length}].`,
          });
        }
        if (endIndex < startIndex || endIndex > arrayValue.elements.length) {
          throw formatErrorMessage({
            token: endExpr.token,
            errorMessage: `Slice end index out of bounds: ${endIndex}. Expected index in range [${startIndex}, ${arrayValue.elements.length}].`,
          });
        }

        const newSliceValue = createSliceValue(
          sliceType,
          [arrayValue],
          startIndex,
          endIndex
        );
        return {
          value: newSliceValue,
          type: sliceType,
          callerEnv,
        };
      }

      // Check if we can create a compile-time slice from another slice
      if (
        sliceValue &&
        isNumberValue(evaluatedStartExpr.$.value) &&
        isNumberValue(evaluatedEndExpr.$.value)
      ) {
        const startValue = evaluatedStartExpr.$.value.value;
        const endValue = evaluatedEndExpr.$.value.value;
        const relativeStart =
          typeof startValue === "bigint" ? Number(startValue) : startValue;
        const relativeEnd =
          typeof endValue === "bigint" ? Number(endValue) : endValue;

        // Calculate absolute indices into the source array
        const sliceLength = sliceValue.endIndex - sliceValue.startIndex;

        // Bounds checking for slice-of-slice
        if (relativeStart < 0 || relativeStart > sliceLength) {
          throw formatErrorMessage({
            token: startExpr.token,
            errorMessage: `Slice start index out of bounds: ${relativeStart}. Expected index in range [0, ${sliceLength}].`,
          });
        }
        if (relativeEnd < relativeStart || relativeEnd > sliceLength) {
          throw formatErrorMessage({
            token: endExpr.token,
            errorMessage: `Slice end index out of bounds: ${relativeEnd}. Expected index in range [${relativeStart}, ${sliceLength}].`,
          });
        }

        // Create new slice with adjusted absolute indices, but same source array
        const absoluteStart = sliceValue.startIndex + relativeStart;
        const absoluteEnd = sliceValue.startIndex + relativeEnd;

        const newSliceValue = createSliceValue(
          sliceType,
          sliceValue.sourceArray, // Keep the same source array reference
          absoluteStart,
          absoluteEnd
        );
        return {
          value: newSliceValue,
          type: sliceType,
          callerEnv,
        };
      }

      return {
        value: undefined,
        type: sliceType,
        callerEnv,
      };
    }
  } else {
    // Evaluate the first argument
    const argExpr = argExprs[0]!;
    const evaluatedArgExpr = evaluateExpression({
      expr: argExpr,
      env: callerEnv,
      context: {
        ...context,
        expectedType: { type: createUsizeType(), env: callerEnv },
      },
    });
    if (!evaluatedArgExpr.$) {
      throw formatErrorMessage({
        token: argExpr.token,
        errorMessage: `Failed to evaluate argument expression:\n${exprToString(argExpr)}`,
      });
    }
    callerEnv = evaluatedArgExpr.$.env;

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
    const returnType = arrayType.childType;

    // Handle compile-time slice indexing
    if (sliceValue) {
      if (!evaluatedArgExpr.$.value) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected compile-time known value for slice index, got runtime value.`,
        });
      } else if (isNumberValue(evaluatedArgExpr.$.value)) {
        const indexValue = evaluatedArgExpr.$.value.value;
        const relativeIndex =
          typeof indexValue === "bigint" ? Number(indexValue) : indexValue;
        const sliceLength = sliceValue.endIndex - sliceValue.startIndex;
        if (relativeIndex < 0 || relativeIndex >= sliceLength) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Slice index out of bounds: ${relativeIndex}. Expected index in range [0, ${sliceLength - 1}].`,
          });
        }
        // Calculate absolute index into the source array
        const absoluteIndex = sliceValue.startIndex + relativeIndex;
        const sourceArray = sliceValue.sourceArray[0];
        const value = sourceArray.elements[absoluteIndex]!;

        // For compile-time slices, store a reference to the source array and absolute index
        // so assignments like s(0) = 10 can update the original array
        const arrayElementRef = {
          arrayValue: sourceArray,
          index: absoluteIndex,
        };

        return {
          value,
          index: relativeIndex,
          arrayElementRef,
          type: returnType,
          callerEnv,
        };
      } else {
        const value = createUnknownValue(returnType, {
          env: callerEnv,
          context,
        });
        return { value, type: returnType, callerEnv };
      }
    }

    // Handle compile-time array indexing
    if (arrayValue) {
      if (!evaluatedArgExpr.$.value) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected compile-time known value for array index, got runtime value.`,
        });
      } else if (isNumberValue(evaluatedArgExpr.$.value)) {
        const indexValue = evaluatedArgExpr.$.value.value;
        const index =
          typeof indexValue === "bigint" ? Number(indexValue) : indexValue;
        if (index < 0 || index >= arrayValue.elements.length) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Array index out of bounds: ${index}. Expected index in range [0, ${arrayValue.elements.length - 1}].`,
          });
        }
        const value = arrayValue.elements[index]!;

        // For compile-time arrays, store a reference to the array and index
        // so that &(arr(0)) can create a pointer to the specific element
        const arrayElementRef = { arrayValue, index };

        return { value, index, arrayElementRef, type: returnType, callerEnv };
      } else {
        // TODO: Check the index bound?
        const value = createUnknownValue(returnType, {
          env: callerEnv,
          context,
        });
        return { value, type: returnType, callerEnv };
      }
    }
    // It's runtime known value
    else {
      return { value: undefined, type: returnType, callerEnv };
    }
  }
}
