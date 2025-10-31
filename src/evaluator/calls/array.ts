import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import {
  areTypesCompatible,
  ArrayType,
  createSliceType,
  createUsizeType,
  SliceType,
  typeToString,
} from "../../types";
import { ArrayValue, createUnknownValue, isNumberValue } from "../../value";
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

  // getting the slice
  // - arr(:)
  // - arr(0:arr.length)
  if (
    (exprIsAtom(expr.args[0]!) && exprIsAtomOf(expr.args[0]!, ":")) ||
    (exprIsFunctionCall(expr.args[0]!) &&
      exprIsFunctionCallOf(expr.args[0]!, ":"))
  ) {
    if (exprIsAtom(expr.args[0]!)) {
      return {
        value: undefined,
        type: createSliceType(arrayType.elementType),
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

      return {
        value: undefined,
        type: createSliceType(arrayType.elementType),
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
    const returnType = arrayType.elementType;

    // It's compile time known value
    if (arrayValue) {
      if (!evaluatedArgExpr.$.value) {
        throw formatErrorMessage({
          token: argExpr.token,
          errorMessage: `Expected compile-time known value for array index, got runtime value.`,
        });
      } else if (isNumberValue(evaluatedArgExpr.$.value)) {
        const index = evaluatedArgExpr.$.value.value;
        if (index < 0 || index >= arrayValue.elements.length) {
          throw formatErrorMessage({
            token: argExpr.token,
            errorMessage: `Array index out of bounds: ${index}. Expected index in range [0, ${arrayValue.elements.length - 1}].`,
          });
        }
        const value = arrayValue.elements[index]!;
        return { value, index, type: returnType, callerEnv };
      } else {
        // TODO: Check the index bound?
        const value = createUnknownValue(returnType);
        return { value, type: returnType, callerEnv };
      }
    }
    // It's runtime known value
    else {
      return { value: undefined, type: returnType, callerEnv };
    }
  }
}
