export enum TokenType {
  // operators
  Operator = "operator",

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
  InfixIdentifier = "infix_identifier", // `add`

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
