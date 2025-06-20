import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import { createNumberValue } from "../../value";
import { ValueTag } from "../../value-tag";

/**
 * Evaluates literal expressions (integers, floats, strings, booleans)
 */
export function evaluateIntegerLiteral(
  expr: AtomExpr,
  env: Environment
): AtomExpr {
  if (expr.token.type === TokenType.Integer) {
    const integerValue = parseInt(expr.token.value, 10);
    const value = createNumberValue(ValueTag.ComptInt, integerValue);
    expr.$ = {
      env,
      value,
      type: value.type,
      isMutable: false,
      pathCollection: [],
    };
    return expr;
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected integer literal, got ${expr.tag}`,
    });
  }
}
