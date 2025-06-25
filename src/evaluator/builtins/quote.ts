import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  FuncCallExpr,
} from "../../expr";
import { isExprListType, isExprType } from "../../types";
import {
  createExprValue,
  isExprListValue,
  isExprValue,
  isUnknownValue,
  valueToString,
} from "../../value";
import { EvaluatorContext } from "../context";

export function processUnquotesInExpr({
  expr,
  env,
  context,
}: {
  expr: Expr;
  env: Environment;
  context: EvaluatorContext;
}): Expr {
  if (exprIsAtom(expr)) {
    return expr;
  } else {
    // If it's a function call, we need to check the args and func
    const func = expr.func;
    const args = expr.args;

    if (
      exprIsAtom(func) &&
      exprIsAtomOf(func, BuiltinKeywords.unquote) &&
      args.length === 1
    ) {
      // If the function is `unquote`, we need to evaluate the first argument
      const arg = args[0]!;
      const evaluatedArg = context.evaluateExpression({
        expr: arg,
        env,
        context: {
          ...context,
        },
      });
      if (
        !evaluatedArg.$ ||
        !isExprType(evaluatedArg.$.type) ||
        !evaluatedArg.$.value
      ) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected expression type for "unquote" argument, got:\n${exprToString(arg)}`,
        });
      }
      const exprValue = evaluatedArg.$.value;
      if (isUnknownValue(exprValue)) {
        // If the value is unknown, we return the original expr
        return expr;
      } else if (isExprValue(exprValue)) {
        // If the value is an expression, we return the expression
        return exprValue.value;
      } else {
        // If the value is not an expression, we throw an error
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected expression value for "unquote" argument, got:\n${valueToString(exprValue)}`,
        });
      }
    } else {
      // If it's not a function call of `unquote`, we need to process the func and args
      const newFunc = processUnquotesInExpr({
        expr: func,
        env,
        context: {
          ...context,
        },
      });
      const newArgs: Expr[] = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;

        // Handle unquote_splicing
        if (
          exprIsFunctionCall(arg) &&
          exprIsFunctionCallOf(arg, BuiltinKeywords.unquote_splicing)
        ) {
          let unquoteSplicingArgs: Expr[] | undefined = undefined;

          // Evaluate the unquote_splicing arguments
          // and flatten them into the newArgs array
          if (arg.args.length !== 1) {
            throw formatErrorMessage({
              token: arg.token,
              errorMessage: `Expected exactly one argument for "unquote_splicing", got ${arg.args.length}`,
            });
          }
          const unquoteSplicingArg = arg.args[0]!;
          const evaluatedUnquoteSplicingArg = context.evaluateExpression({
            expr: unquoteSplicingArg,
            env,
            context: {
              ...context,
            },
          });
          if (
            !evaluatedUnquoteSplicingArg.$ ||
            !isExprListType(evaluatedUnquoteSplicingArg.$.type) ||
            !evaluatedUnquoteSplicingArg.$.value
          ) {
            throw formatErrorMessage({
              token: unquoteSplicingArg.token,
              errorMessage: `Expected ExprList for "unquote_splicing" argument, got:\n${exprToString(unquoteSplicingArg)}`,
            });
          }

          const exprListValue = evaluatedUnquoteSplicingArg.$.value;
          if (isExprListValue(exprListValue)) {
            if (exprListValue.elements.every((el) => isExprValue(el))) {
              unquoteSplicingArgs = exprListValue.elements.map(
                (el) => el.value
              );
            }
          } else {
            // TODO: exprListValue is unknown value.
          }
          if (unquoteSplicingArgs) {
            unquoteSplicingArgs.forEach((arg) => {
              newArgs.push(arg);
            });
          } else {
            // Meet unknown value, we just ignore it
            newArgs.push(arg);
          }
        } else {
          newArgs.push(
            processUnquotesInExpr({
              expr: arg,
              env,
              context: {
                ...context,
              },
            })
          );
        }
      }

      const newExpr = {
        ...expr,
        func: newFunc,
        args: newArgs,
      };
      return newExpr;
    }
  }
}

export function evaluateQuote({
  expr,
  env,
  context,
}: {
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
  const quotedExpr = processUnquotesInExpr({
    expr: expr.args[0]!,
    env: env,
    context: {
      ...context,
    },
  });

  const exprValue = createExprValue(quotedExpr);
  expr.$ = {
    env,
    type: exprValue.type,
    value: exprValue,
    isMutable: false,
    pathCollection: [],
  };
  return expr;
}
