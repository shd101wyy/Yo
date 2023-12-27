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
  FunctionArrow = "->",
  FatArrow = "=>",
  DoArrow = "<-",
  Comptime = "#",
  MutableReference = "&!",

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
  Is = "is",

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
  //// Function = "function",
  If = "if",
  Else = "else",
  //// For = "for",
  //// While = "while",
  //// Switch = "switch",
  Case = "case",
  Default = "default",
  Resume = "resume",
  Return = "return",
  Break = "break",
  Continue = "continue",
  //// Fallthrough = "fallthrough",
  Let = "let",
  Mut = "mut",
  Do = "do",
  Type = "type",
  Enum = "enum",
  // Interface = "interface",
  Class = "class",
  // Trait = "trait",
  Instance = "instance",
  Extends = "extends",
  Effect = "effect",
  //// Handler = "handler",
  //// Implement = "implement",
  Import = "import",
  Export = "export",
  From = "from",
  Move = "move",
  //// Unique = "unique",
  //// Shared = "shared",
  //// Weak = "weak",
  With = "with",
  As = "as",
  Const = "const",
  Defer = "defer",

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
