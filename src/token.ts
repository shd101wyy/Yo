export enum TokenType {
  Eof = "eof",

  // operators
  Add = "+",
  Subtract = "-",
  Multiply = "*",
  Divide = "/",
  Modulo = "%",
  Exponent = "**",
  BitwiseAnd = "&",
  BitwiseOr = "|",
  BitwiseXor = "^",
  BitwiseNot = "~",
  BitwiseShiftLeft = "<<",
  BitwiseShiftRight = ">>",
  LogicalAnd = "&&",
  LogicalOr = "||",
  LogicalNot = "!",
  LambdaArrow = "=>",
  DoArrow = "<-",
  Comptime = "#",

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

  // string
  Char = "char",
  String = "string",
  Symbol = "symbol",

  // primary
  Identifier = "identifier",
  Integer = "integer",
  Float = "float",
  Boolean = "boolean",

  // keywords
  Function = "function",
  If = "if",
  Else = "else",
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
  Do = "do",
  Type = "type",
  Enum = "enum",
  // Interface = "interface",
  Trait = "trait",
  Extends = "extends",
  Effect = "effect",
  // Implement = "implement",
  Import = "import",
  Export = "export",
  Unique = "unique",
  Shared = "shared",
  Weak = "weak",
  With = "with",

  /**
   * A list of available C functions can be found at:
   * https://libc.llvm.org/index.html
   */
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
  Dot = ".",
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
