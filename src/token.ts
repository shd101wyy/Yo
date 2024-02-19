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
  // Resume = "resume",
  // Abort = "abort",
  Control = "control",
  Return = "return",
  Break = "break",
  Continue = "continue",
  //// Fallthrough = "fallthrough",
  Let = "let",
  // Mut = "mut",
  Do = "do",
  Type = "type",
  Enum = "enum",
  Interface = "interface",
  Class = "class",
  // Trait = "trait",
  Instance = "instance",
  Extends = "extends",
  Effect = "effect",
  Match = "match",
  //// Handler = "handler",
  Implements = "implements",
  Import = "import",
  Export = "export",
  From = "from",
  Move = "move",
  Read = "read",
  Write = "write",
  Own = "own",
  Copy = "copy",
  // Owned = "owned",
  // Readonly = "readonly",
  // Writable = "writable",
  //// Unique = "unique",
  //// Shared = "shared",
  //// Weak = "weak",
  Try = "try",
  With = "with",
  As = "as",
  Const = "const",
  Var = "var",
  Defer = "defer",
  Async = "async",
  Await = "await",
  Recur = "recur",
  Infix = "infix",
  Infixl = "infixl",
  Infixr = "infixr",
  Where = "where",
  Given = "given",
  Using = "using",

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
