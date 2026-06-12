import type { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import {
  type AtomExpr,
  ExprTag,
  exprToString,
  type FnCallExpr,
} from "../../expr";
import { TokenType } from "../../token";
import { randomId } from "../../utils";
import { createExprValue, isComptimeStringValue } from "../../value";
import type { EvaluatorContext } from "../context";
import { evaluateExpression } from "../exprs/expr";

/**
 * Use gensym() to generate a unique symbol.
 * This is useful for generating unique identifiers in macros or other contexts
 * where you need a fresh symbol that won't collide with existing ones.
 * The optional prefix argument allows you to specify a string that will be
 * prepended to the generated symbol.
 */
export function evaluateGensym({
  expr,
  env,
  context,
}: {
  expr: FnCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FnCallExpr {
  const prefixArg = expr.args[0];
  let prefix: string = "";
  if (prefixArg) {
    if (expr.args.length > 1) {
      throw formatErrorMessage({
        token: expr.args[1]!.token,
        errorMessage: `Expected "gensym" with 0 or 1 argument, got: ${expr.args.length}`,
      });
    }

    // evaluate the prefix argument
    const evaluatedPrefixArg = evaluateExpression({
      expr: prefixArg,
      env,
      context: {
        ...context,
      },
    });
    if (!evaluatedPrefixArg.$) {
      throw formatErrorMessage({
        token: prefixArg.token,
        errorMessage: `Failed to evaluate the prefix argument for "gensym":\n${exprToString(
          prefixArg
        )}`,
      });
    }
    if (!isComptimeStringValue(evaluatedPrefixArg.$.value)) {
      throw formatErrorMessage({
        token: prefixArg.token,
        errorMessage: `Expected comptime_str for prefix argument, got:\n${exprToString(prefixArg)}`,
      });
    }
    const prefixArgValue = evaluatedPrefixArg.$.value;
    prefix = prefixArgValue.value;
  }

  const symbol = prefix + randomId(env.modulePath);
  const atomExpr: AtomExpr = {
    tag: ExprTag.Atom,
    token: {
      modulePath: env.modulePath,
      inputString: env.inputString,
      type: TokenType.Identifier,
      position: expr.func.token.position,
      value: symbol,
    },
  };
  const atomExprValue = createExprValue(atomExpr);

  expr.$ = {
    env,
    pathCollection: [],
    type: atomExprValue.type,
    value: atomExprValue,
  };
  return expr;
}
