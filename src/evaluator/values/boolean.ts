import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import { createBooleanValue, Value } from "../../value";

export function evaluateBooleanLiteral(
  expr: AtomExpr,
  env: Environment
): AtomExpr {
  if (expr.token.type === TokenType.Boolean) {
    const booleanValue = expr.token.value === "true";
    const value: Value = createBooleanValue(booleanValue);
    expr.$ = {
      env,
      value,
      type: value.type,
      isMutable: false,
    };
    return expr;
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected boolean literal, got ${expr.tag}`,
    });
  }
}
