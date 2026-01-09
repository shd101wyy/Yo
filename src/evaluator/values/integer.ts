import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import {
  isI16Type,
  isI32Type,
  isI64Type,
  isI8Type,
  isIsizeType,
  isU16Type,
  isU32Type,
  isU64Type,
  isU8Type,
  isUsizeType,
} from "../../types";
import { createNumberValue } from "../../value";
import { ValueTag } from "../../value-tag";
import { EvaluatorContext } from "../context";

/**
 * Evaluates literal expressions (integers, floats, strings, booleans)
 */
export function evaluateIntegerLiteral(
  expr: AtomExpr,
  env: Environment,
  context: EvaluatorContext
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

    let valueTag: ValueTag = ValueTag.ComptInt;
    if (context.expectedType) {
      const expectedType = context.expectedType.type;
      if (isUsizeType(expectedType)) {
        valueTag = ValueTag.Usize;
      } else if (isIsizeType(expectedType)) {
        valueTag = ValueTag.Isize;
      } else if (isU8Type(expectedType)) {
        valueTag = ValueTag.U8;
      } else if (isI8Type(expectedType)) {
        valueTag = ValueTag.I8;
      } else if (isU16Type(expectedType)) {
        valueTag = ValueTag.U16;
      } else if (isI16Type(expectedType)) {
        valueTag = ValueTag.I16;
      } else if (isU32Type(expectedType)) {
        valueTag = ValueTag.U32;
      } else if (isI32Type(expectedType)) {
        valueTag = ValueTag.I32;
      } else if (isU64Type(expectedType)) {
        valueTag = ValueTag.U64;
      } else if (isI64Type(expectedType)) {
        valueTag = ValueTag.I64;
      }
      // QUESTION: Should we throw error here?
    }

    // For 64-bit types, use BigInt; for smaller types, use number
    const is64Bit =
      valueTag === ValueTag.U64 ||
      valueTag === ValueTag.I64 ||
      valueTag === ValueTag.Usize ||
      valueTag === ValueTag.Isize;

    let integerValue: number | bigint;
    if (is64Bit || valueTag === ValueTag.ComptInt) {
      // Parse as BigInt for 64-bit types and compt_int to preserve precision
      // For non-decimal radixes, prepend the appropriate prefix
      if (radix === 16) {
        integerValue = BigInt("0x" + numberValue);
      } else if (radix === 8) {
        integerValue = BigInt("0o" + numberValue);
      } else if (radix === 2) {
        integerValue = BigInt("0b" + numberValue);
      } else {
        integerValue = BigInt(numberValue);
      }
    } else {
      // Parse as number for smaller types
      integerValue = parseInt(numberValue, radix);
    }

    const value = createNumberValue(valueTag, integerValue);
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
