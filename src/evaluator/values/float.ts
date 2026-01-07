import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import { isF32Type, isF64Type } from "../../types";
import { createNumberValue } from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";

export function evaluateFloatLiteral(
  expr: AtomExpr,
  env: Environment,
  context: EvaluatorContext
): AtomExpr {
  if (expr.token.type === TokenType.Float) {
    const floatValue = parseFloat(expr.token.value);

    let valueTag: ValueTag = ValueTag.ComptFloat;
    if (context.expectedType) {
      const expectedType = context.expectedType.type;
      if (isF32Type(expectedType)) {
        valueTag = ValueTag.F32;
      } else if (isF64Type(expectedType)) {
        valueTag = ValueTag.F64;
      }
    }

    const value = createNumberValue(valueTag, floatValue);
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
