export enum TokenType {
  Eof = "eof",

  // operators
  Add = "+",
  Subtract = "-",
  Multiply = "*",
  Divide = "/",
  Modulo = "%",

  // parens
  LParen = "(",
  RParen = ")",
  LBracket = "[",
  RBracket = "]",
  LCurlyBracket = "{",
  RCurlyBracket = "}",

  // comparison
  Equal = "==",
  NotEqual = "!=",
  LessThan = "<",
  LessThanOrEqual = "<=",
  GreaterThan = ">",
  GreaterThanOrEqual = ">=",

  // assignment
  Assign = "=",
  Negate = "!",

  // string
  Char = "char",
  String = "string",

  // primary
  Identifier = "identifier",
  Integer = "integer",
  Float = "float",
  Boolean = "boolean",

  // keywords
  Function = "function",
  If = "if",
  For = "for",
  While = "while",
  Switch = "switch",
  Case = "case",
  Resume = "resume",
  Return = "return",
  Break = "break",
  Continue = "continue",
  Fallthrough = "fallthrough",
  Let = "let",
  Const = "const",
  Type = "type",
  Enum = "enum",
  Interface = "interface",
  Effect = "effect",
  Implement = "implement",
  Import = "import",
  Export = "export",
  Extern = "extern",
  Inline = "inline",

  // reserved
  Null = "null",
  Undefined = "undefined",
  Struct = "struct",
  Union = "union",
  Override = "override",
  Match = "match",

  // punctuation
  Semicolon = ";",
  Colon = ":",
  Comma = ",",
}

export interface Token {
  type: TokenType;
  value: string;
  position: {
    /**
     * A zero-based line value.
     */
    line: number;
    /**
     * A zero-based character value
     */
    character: number;
  };
}
