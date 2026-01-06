import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import { createBooleanValue, Value } from "../../value";

export function evaluateBooleanLiteral(
  expr: AtomExpr,
  env: Environment,
): AtomExpr {
  if (expr.token.type === TokenType.Bool) {
    const booleanValue = expr.token.value === "true";
    const value: Value = createBooleanValue(booleanValue);
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
      errorMessage: `Expected bool literal, got ${expr.tag}`,
    });
  }
}
