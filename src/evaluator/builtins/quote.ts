import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  BuiltinKeywords,
  expectExprToBeFunctionCallOf,
  type Expr,
  exprIsAtom,
  exprIsAtomOf,
  exprIsFunctionCall,
  exprIsFunctionCallOf,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { isExprListType, isExprType } from "../../types/guards";
import {
  createExprValue,
  isExprListValue,
  isExprValue,
  isUnknownValue,
  valueToString,
} from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

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
      const evaluatedArg = evaluateExpression({
        expr: arg,
        env,
        context: {
          ...context,
        },
      });
      if (!evaluatedArg.$ || !evaluatedArg.$.value) {
        throw formatErrorMessage({
          token: arg.token,
          errorMessage: `Expected expression type for "unquote" argument, got:\n${exprToString(arg)}`,
        });
      }
      // If the type is not Expr but value is unknown, return the original expr
      // (this happens during function body validation when params are unknown)
      if (!isExprType(evaluatedArg.$.type)) {
        if (isUnknownValue(evaluatedArg.$.value)) {
          return expr;
        }
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

        // Handle unquote_splicing: either ...#(x) (single token) or ...(#(x)) (two tokens)
        const isUnquoteSplicing =
          exprIsFunctionCall(arg) &&
          exprIsFunctionCallOf(arg, BuiltinKeywords.unquote_splicing);
        // Also handle ...(#(x)) parsed as spread(unquote(x))
        const isSpreadUnquote =
          !isUnquoteSplicing &&
          exprIsFunctionCall(arg) &&
          exprIsFunctionCallOf(arg, "...") &&
          arg.args.length === 1 &&
          exprIsFunctionCall(arg.args[0]!) &&
          exprIsFunctionCallOf(arg.args[0]!, BuiltinKeywords.unquote);
        if (isUnquoteSplicing || isSpreadUnquote) {
          let unquoteSplicingArgs: Expr[] | undefined = undefined;
          // For ...(#(x)), the inner arg is the unquote's argument
          const fnCallArg = arg as FnCallExpr;
          const unquoteSplicingArg = isSpreadUnquote
            ? (fnCallArg.args[0] as FnCallExpr).args[0]!
            : fnCallArg.args[0]!;
          const evaluatedUnquoteSplicingArg = evaluateExpression({
            expr: unquoteSplicingArg,
            env,
            context: {
              ...context,
            },
          });
          if (
            !evaluatedUnquoteSplicingArg.$ ||
            !evaluatedUnquoteSplicingArg.$.value
          ) {
            throw formatErrorMessage({
              token: unquoteSplicingArg.token,
              errorMessage: `Expected ExprList for "unquote_splicing" argument, got:\n${exprToString(unquoteSplicingArg)}`,
            });
          }
          // If the type is not ExprList but value is unknown, return the original arg unchanged
          // (this happens during function body validation when params are unknown)
          if (!isExprListType(evaluatedUnquoteSplicingArg.$.type)) {
            if (isUnknownValue(evaluatedUnquoteSplicingArg.$.value)) {
              newArgs.push(arg);
            } else {
              throw formatErrorMessage({
                token: unquoteSplicingArg.token,
                errorMessage: `Expected ExprList for "unquote_splicing" argument, got:\n${exprToString(unquoteSplicingArg)}`,
              });
            }
          } else {
            const exprListValue = evaluatedUnquoteSplicingArg.$.value;
            if (isExprListValue(exprListValue)) {
              if (exprListValue.elements.every((el) => isExprValue(el))) {
                unquoteSplicingArgs = exprListValue.elements.map(
                  (el) => el.value
                );
              }
            } else {
              // exprListValue is unknown value — keep original
            }
            if (unquoteSplicingArgs) {
              unquoteSplicingArgs.forEach((_arg) => {
                newArgs.push(_arg);
              });
            } else {
              // Meet unknown value, we just ignore it
              newArgs.push(arg);
            }
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
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  expectExprToBeFunctionCallOf(expr, BuiltinKeywords.quote, 1);

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
    pathCollection: [],
  };
  return expr;
}
