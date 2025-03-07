export enum TokenType {
  Eof = "eof",

  // operators
  Operator = "operator",

  /// Below are not available as generator operators.
  /// they are used as a part of the syntax.
  Dot = ".",
  Assign = "=",
  Colon = ":",
  FunctionArrow = "->",
  FatArrow = "=>",
  MoveFatArrow = "=>>",
  /// end
  Comptime = "#",

  // parens
  LParen = "(",
  RParen = ")",
  LBracket = "[",
  RBracket = "]",
  LCurlyBracket = "{",
  RCurlyBracket = "}",

  // comparison
  Is = "is",

  // string
  Char = "char",
  String = "string",

  // primary
  Identifier = "identifier",
  Integer = "integer",
  Float = "float",
  Boolean = "boolean",

  // keywords
  If = "if",
  Else = "else",
  For = "for",
  While = "while",
  Case = "case",
  Default = "default",
  Control = "control",
  Return = "return",
  Break = "break",
  Continue = "continue",
  //// Fallthrough = "fallthrough",
  Do = "do",
  Type = "type",
  Enum = "enum",
  Trait = "trait",
  Impl = "impl",
  Dyn = "dyn",
  Match = "match",
  Import = "import",
  Export = "export",
  From = "from",
  Move = "move",
  With = "with",
  As = "as",
  Const = "const",
  Var = "var",
  Let = "let",
  Mut = "mut",
  Defer = "defer",
  Recur = "recur",
  Infix = "infix",
  Infixl = "infixl",
  Infixr = "infixr",
  Where = "where",

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
  Declare = "declare",
  /// Closure = "closure",
  //// Switch = "switch",
  //// Function = "function",
  //// Class = "class",
  //// Instance = "instance",
  //// Extends = "extends",
  //// Effect = "effect",
  //// Handler = "handler",
  //// Implements = "implements",
  //// Try = "try",
  //// Symbol = "symbol",

  // punctuation
  Semicolon = ";",
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
  infixPrecedence?: number;
}
