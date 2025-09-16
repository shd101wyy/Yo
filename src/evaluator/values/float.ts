import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import { createNumberValue } from "../../value";
import { ValueTag } from "../../value-tag";

export function evaluateFloatLiteral(
  expr: AtomExpr,
  env: Environment
): AtomExpr {
  if (expr.token.type === TokenType.Float) {
    const floatValue = parseFloat(expr.token.value);
    const value = createNumberValue(ValueTag.ComptFloat, floatValue);
    expr.$ = {
      env,
      value,
      type: value.type,
      pathCollection: [],
    };
    return expr;
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected float literal, got ${expr.tag}`,
    });
  }
}
