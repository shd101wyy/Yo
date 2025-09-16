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
    let numberValue = expr.token.value.replace(/_/g, ""); // Remove underscores for readability
    let radix = 10;
    if (numberValue.match(/^0x/i)) {
      radix = 16; // Hexadecimal
      numberValue = numberValue.slice(2); // Remove '0x' prefix
    } else if (numberValue.match(/^0b/i)) {
      radix = 2; // Binary
      numberValue = numberValue.slice(2); // Remove '0b' prefix
    } else if (numberValue.match(/^0o/i)) {
      radix = 8; // Octal
      numberValue = numberValue.slice(2); // Remove '0o' prefix
    }

    const integerValue = parseInt(numberValue, radix);
    const value = createNumberValue(ValueTag.ComptInt, integerValue);
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
      errorMessage: `Expected integer literal, got ${expr.tag}`,
    });
  }
}
