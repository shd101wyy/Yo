import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr, ExprTag, exprToString, FuncCallExpr } from "../../expr";
import { TokenType } from "../../token";
import { randomId } from "../../utils";
import { createExprValue, isComptStringValue } from "../../value";
import { EvaluatorContext } from "../context";
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
  expr: FuncCallExpr;
  env: Environment;
  context: EvaluatorContext;
}): FuncCallExpr {
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
    if (!isComptStringValue(evaluatedPrefixArg.$.value)) {
      throw formatErrorMessage({
        token: prefixArg.token,
        errorMessage: `Expected compt_string for prefix argument, got:\n${exprToString(
          prefixArg
        )}`,
      });
    }
    const prefixArgValue = evaluatedPrefixArg.$.value;
    prefix = prefixArgValue.value;
  }

  const symbol = prefix + randomId();
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
