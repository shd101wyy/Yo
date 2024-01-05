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
  Try = "try",
  With = "with",
  As = "as",
  Const = "const",
  Defer = "defer",
  Async = "async",
  Await = "await",
  Recur = "recur",
  Infix = "infix",
  Infixl = "infixl",
  Infixr = "infixr",

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
