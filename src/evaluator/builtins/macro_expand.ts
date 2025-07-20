import { Environment } from "../../env";
import { formatErrorMessage, MoParserError } from "../../error";
import { exprIsFunctionCall, exprToString, FuncCallExpr } from "../../expr";
import {
  createExprType,
  isComptIntType,
  isExprType,
  typeToString,
} from "../../types";
import { createExprValue, isComptIntValue, isExprValue } from "../../value";
import { evaluateFunctionCall } from "../calls/function";
import { EvaluatorContext } from "../context";
import { processUnquotesInExpr } from "./quote";

/**
 * macro_expand will expand the macro call and return the expanded expression.
 * eg:
 *
 *   macro_expand(quote(3 + 4));
 *   macro_expand(quote(if true, 1, 2));
 *   macro_expand(quote(add(1, 2, 3)), 2); // expand only 2 levels
 *
 * It accepts an Expr as the first argument and an optional compt_int as the second argument.
 * If the second argument is not provided, it expands until no more expansion is possible.
 * If the second argument is provided, it expands only that many levels.
 */
export function evaluateMacroExpand({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  // Accept 1 or 2 arguments
  if (expr.args.length !== 1 && expr.args.length !== 2) {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `"macro_expand" expects 1 or 2 arguments, but got ${expr.args.length}`,
    });
  }

  const argExpr = expr.args[0]!;
  const evaluatedArgExpr = context.evaluateExpression({
    expr: argExpr,
    env,
    context: {
      ...context,
    },
  });

  if (!evaluatedArgExpr.$) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `Failed to evaluate the argument expression for "macro_expand":\n${argExpr.toString()}`,
    });
  }
  env = evaluatedArgExpr.$.env;

  if (!isExprType(evaluatedArgExpr.$.type)) {
    throw formatErrorMessage({
      token: argExpr.token,
      errorMessage: `The argument expression for "macro_expand" must be an Expr value, but got: ${typeToString(evaluatedArgExpr.$.type)}`,
    });
  }

  // Handle optional second argument for expansion level
  let maxExpansionLevel: number | null = null;
  if (expr.args.length === 2) {
    const levelArgExpr = expr.args[1]!;
    const evaluatedLevelArgExpr = context.evaluateExpression({
      expr: levelArgExpr,
      env,
      context: {
        ...context,
      },
    });

    if (!evaluatedLevelArgExpr.$) {
      throw formatErrorMessage({
        token: levelArgExpr.token,
        errorMessage: `Failed to evaluate the level argument expression for "macro_expand":\n${levelArgExpr.toString()}`,
      });
    }

    if (!isComptIntType(evaluatedLevelArgExpr.$.type)) {
      throw formatErrorMessage({
        token: levelArgExpr.token,
        errorMessage: `The level argument for "macro_expand" must be a compt_int value, but got: ${typeToString(evaluatedLevelArgExpr.$.type)}`,
      });
    }

    if (!isComptIntValue(evaluatedLevelArgExpr.$.value)) {
      throw formatErrorMessage({
        token: levelArgExpr.token,
        errorMessage: `The level argument for "macro_expand" must be a compt_int value`,
      });
    }

    maxExpansionLevel = evaluatedLevelArgExpr.$.value.value;
    if (maxExpansionLevel < 0) {
      throw formatErrorMessage({
        token: levelArgExpr.token,
        errorMessage: `The level argument for "macro_expand" must be non-negative, but got: ${maxExpansionLevel}`,
      });
    }
  }

  const exprValue = evaluatedArgExpr.$.value;
  if (isExprValue(exprValue)) {
    let currentExpr = exprValue.value;
    let currentEnv = env;
    let expansionCount = 0;

    // Keep expanding while the expression is a function call that can be expanded
    // and we haven't reached the maximum expansion level (if specified)
    while (
      exprIsFunctionCall(currentExpr) &&
      (maxExpansionLevel === null || expansionCount < maxExpansionLevel)
    ) {
      try {
        const expandedExpr = evaluateFunctionCall({
          expr: currentExpr,
          env: currentEnv,
          context: {
            ...context,
          },
          forMacroExpansion: true,
        });

        if (!expandedExpr.$) {
          // If expansion failed, stop expanding
          break;
        }

        currentEnv = expandedExpr.$.env;

        // Check if the expanded expression is an ExprValue
        if (isExprValue(expandedExpr.$.value)) {
          const newExpr = expandedExpr.$.value.value;
          if (exprToString(newExpr) === exprToString(currentExpr)) {
            // If the expression didn't change, stop expanding to avoid infinite loop
            break;
          }
          currentExpr = newExpr;
          expansionCount++;
        } else {
          // If the result is not an expression value (e.g., compile-time function call),
          // stop expanding as we shouldn't use its result for macro expansion
          break;
        }
      } catch (error) {
        // Throw the error if it's a MoParserError with isAssertionError flag
        // which means is from `compt_assert` or similar assertion
        if (error instanceof MoParserError && error.isAssertionError) {
          throw error;
        }
        // If evaluation throws an error, stop expanding
        break;
      }
    }
    currentExpr = processUnquotesInExpr({
      expr: currentExpr,
      env: currentEnv,
      context: { ...context },
    });

    expr.$ = {
      env: currentEnv,
      type: createExprType(),
      value: createExprValue(currentExpr),
      isMutable: evaluatedArgExpr.$.isMutable,
      pathCollection: evaluatedArgExpr.$.pathCollection,
    };
  } else {
    // Unknown value;
    expr.$ = {
      env,
      type: evaluatedArgExpr.$.type,
      value: evaluatedArgExpr.$.value,
      isMutable: evaluatedArgExpr.$.isMutable,
      pathCollection: evaluatedArgExpr.$.pathCollection,
    };
  }
  return expr;
}
