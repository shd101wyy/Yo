import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import { createComptStringValue } from "../../value";

export function evaluateStringLiteral(
  expr: AtomExpr,
  env: Environment
): AtomExpr {
  if (expr.token.type === TokenType.String) {
    const value = createComptStringValue(JSON.parse(expr.token.value));
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
      errorMessage: `Expected string literal, got ${expr.tag}`,
    });
  }
}
