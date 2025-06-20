import { Environment } from "../env";
import { formatErrorMessage } from "../error";
import { AtomExpr } from "../expr";
import { TokenType } from "../token";
import {
  Value,
  createBooleanValue,
  createComptStringValue,
  createNumberValue,
} from "../value";
import { ValueTag } from "../value-tag";

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
      isMutable: false,
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
      isMutable: false,
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
      pathCollection: [],
    };
    return expr;
  } else {
    throw formatErrorMessage({
      token: expr.token,
      errorMessage: `Expected boolean literal, got ${expr.tag}`,
    });
  }
}
