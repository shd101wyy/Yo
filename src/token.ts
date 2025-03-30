export enum TokenType {
  // operators
  Operator = "operator",
  Dot = ".", // Dot itself is used special

  // parens
  LParen = "(",
  RParen = ")",
  LBracket = "[",
  RBracket = "]",
  LCurlyBracket = "{",
  RCurlyBracket = "}",

  // string
  Char = "char", // 'a'
  String = "string", // "abc"
  // IDEA: ` backtick reserved for quasiquote?

  // primary
  Identifier = "identifier",
  Integer = "integer",
  Float = "float",
  Boolean = "boolean",

  // punctuation
  Semicolon = ";",
  Comma = ",",

  // comment
  SingleLineComment = "single_line_comment",
  MultiLineComment = "multi_line_comment",

  // whitespace
  // ' ' | '\t' | '\n' | '\r'
  Whitespace = "whitespace",
}

export interface Token {
  type: TokenType;
  value: string;
  position: {
    // The start position of the token in the input string
    /**
     * A zero-based row value.
     */
    row: number;
    /**
     * A zero-based column value.
     */
    column: number;
    /**
     * A zero-based character index.
     */
    character: number;
  };
}

export const Operators = [
  "=",
  "+",
  "-",
  "*",
  "/",
  "<",
  ">",
  "@",
  "$",
  "~",
  "&",
  "%",
  "|",
  "!",
  "?",
  "^",
  ".",
  ":",
  "\\",
  "#",
];

export function charIsOperator(char: string): boolean {
  return Operators.includes(char);
}

export function stringIsOperator(str: string): boolean {
  let isOperator = true;
  for (let i = 0; i < str.length; i++) {
    if (!charIsOperator(str[i])) {
      isOperator = false;
      break;
    }
  }
  return isOperator;
}

export const IdentifierRegex =
  /^[_a-zA-Z\xA0-\uFFFF][_a-zA-Z0-9\xA0-\uFFFF]*[!?]?$/;

/**
 * Finds the index of the matching right bracket (closing bracket) for a left bracket (opening bracket)
 * in a token array.
 *
 * This function handles nested brackets by keeping a counter to track bracket depth.
 * It supports three types of bracket pairs: parentheses (), square brackets [], and curly braces {}.
 *
 * @param tokens - The array of tokens to search through
 * @param index - The index of the left bracket token in the array
 * @returns The index of the matching right bracket token, or -1 if no matching bracket is found
 *
 * @example
 * // If tokens[5] is a left parenthesis '('
 * const closingParenIndex = findMatchingBracketTokenIndex(tokens, 5);
 */
export function findMatchingBracketTokenIndex(
  tokens: Token[],
  index: number
): number {
  let endBracketType = TokenType.RParen;
  const startBracketType = tokens[index].type;
  if (startBracketType === TokenType.LCurlyBracket) {
    endBracketType = TokenType.RCurlyBracket;
  } else if (startBracketType === TokenType.LParen) {
    endBracketType = TokenType.RParen;
  } else if (startBracketType === TokenType.LBracket) {
    endBracketType = TokenType.RBracket;
  } else {
    throw this.formatErrorMessage(tokens[index], "Expected '{', '(' or '['");
  }
  index = index + 1;
  let count = 1;
  let endIndex = -1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!tokens[index]) {
      return -1;
    }

    if (tokens[index].type === endBracketType) {
      count = count - 1;
      if (count === 0) {
        endIndex = index;
        break;
      }
    } else if (tokens[index].type === startBracketType) {
      count = count + 1;
    }

    index = index + 1;
  }

  return endIndex;
}
