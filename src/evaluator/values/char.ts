import { Environment } from "../../env";
import { formatErrorMessage } from "../../error";
import { AtomExpr } from "../../expr";
import { TokenType } from "../../token";
import { createComptIntValue } from "../../value";

export function evaluateCharLiteral(
  expr: AtomExpr,
  env: Environment,
): AtomExpr {
  if (expr.token.type === TokenType.Char) {
    const charCode = parseCharLiteral(expr.token.value);
    const value = createComptIntValue(BigInt(charCode));
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
      errorMessage: `Expected char literal, got ${expr.tag}`,
    });
  }
}

// Helper function to parse char literals and handle escape sequences
function parseCharLiteral(tokenValue: string): number {
  // Remove the surrounding quotes: 'a' -> a, '\t' -> \t
  const innerValue = tokenValue.slice(1, -1);

  if (innerValue.length === 1) {
    // Simple character like 'a', 'b', etc.
    return innerValue.charCodeAt(0);
  } else if (innerValue.length === 2 && innerValue[0] === "\\") {
    // Escape sequence like '\n', '\t', etc.
    const escapeChar = innerValue[1];
    switch (escapeChar) {
      case "n":
        return 10; // newline
      case "t":
        return 9; // tab
      case "r":
        return 13; // carriage return
      case "\\":
        return 92; // backslash
      case "'":
        return 39; // single quote
      case '"':
        return 34; // double quote
      case "0":
        return 0; // null character
      case "a":
        return 7; // bell
      case "b":
        return 8; // backspace
      case "f":
        return 12; // form feed
      case "v":
        return 11; // vertical tab
      default:
        throw new Error(`Unknown escape sequence: \\${escapeChar}`);
    }
  } else {
    throw new Error(`Invalid char literal: ${tokenValue}`);
  }
}
