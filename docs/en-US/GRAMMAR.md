# Yo Language Grammar

This document describes the grammar of the Yo programming language as implemented in the parser and lexer.

## Core Syntax

```abnf
;; Top-Level Program Structure
Program ::= Whitespace* [Expression (Whitespace* ";" Whitespace* Expression)*] Whitespace* ";"?

;; Expression - The primary construct
;; Everything in Yo is an expression
Expression ::= PrimaryExpression PrimaryEnd*

;; Primary Expression - Starting point of any expression
PrimaryExpression ::=
  | Atom
  | ParenExpression
  | ArrayExpression
  | CurlyBracketExpression
  | DotExpression

;; Primary End - Suffix operations that can follow a primary expression
PrimaryEnd ::=
  | FieldAccess           ;; obj.field or .variant
  | InfixOperator         ;; expr + expr, expr `add` expr
  | FunctionCall          ;; func(args), with no whitespace before '('
```

## Atoms

```abnf
;; Atoms - The smallest unit of expression
Atom ::= Literal | Identifier | Operator

;; Literals
Literal ::=
  | BooleanLiteral
  | NumberLiteral
  | StringLiteral
  | CharLiteral

BooleanLiteral ::= "true" | "false"

;; Number Literals
NumberLiteral ::= IntegerLiteral | FloatLiteral

IntegerLiteral ::=
  | DecimalInteger
  | HexInteger
  | BinaryInteger
  | OctalInteger

DecimalInteger ::= Digit (Digit | '_')*
HexInteger     ::= '0' ('x' | 'X') HexDigit (HexDigit | '_')*
BinaryInteger  ::= '0' ('b' | 'B') ('0' | '1') (('0' | '1') | '_')*
OctalInteger   ::= '0' ('o' | 'O') OctalDigit (OctalDigit | '_')*

FloatLiteral   ::=
  | Digit (Digit | '_')* '.' Digit (Digit | '_')* Exponent?
  | Digit (Digit | '_')* Exponent

Exponent       ::= ('e' | 'E') ('+' | '-')? Digit (Digit | '_')*

Digit          ::= '0'..'9'
HexDigit       ::= '0'..'9' | 'a'..'f' | 'A'..'F'
OctalDigit     ::= '0'..'7'

;; String and Character Literals
StringLiteral  ::= '"' StringChar* '"'
StringChar     ::= [^"\\] | EscapeSequence

CharLiteral    ::= "'" (CharChar | EscapeSequence) "'"
CharChar       ::= [^'\\]

EscapeSequence ::= '\\' AnyChar
```

## Identifiers and Operators

```abnf
;; Identifier
;; Supports Unicode characters and optional trailing ! or ?
Identifier ::= IdentifierStart IdentifierContinue* ('!' | '?')?

IdentifierStart    ::= Letter | '_'
IdentifierContinue ::= Letter | Digit | '_'
Letter             ::= 'a'..'z' | 'A'..'Z' | UnicodeChar
UnicodeChar        ::= '\xA0'..'\uFFFF'
Digit              ::= '0'..'9'

;; Backtick Identifier - Used for infix notation
;; Example: 3 `add` 4
BacktickIdentifier ::= '`' Identifier '`'

;; Operators — Yo has a CLOSED operator set (plans/reference/OPERATOR_SET_AND_PRECEDENCE.md).
;; A run of operator characters is split greedily against the table below,
;; longest match first; a run containing no table operator is a lex error.
;; So `**x` lexes as '*' '*' 'x' — there is no `**` token. New operators are
;; added to the compiler deliberately, like keywords.
Operator      ::= DotOperator | TableOperator
DotOperator   ::= '.' | '..' | '..=' | '...' | '...#'

TableOperator ::= ;; two-character (matched first)
                  '!=' | '&&' | '->' | '::' | ':=' | '<:' | '<<' | '<='
                | '==' | '=>' | '>=' | '>>' | '?=' | '||'
                  ;; one-character
                | '!' | '#' | '%' | '&' | '*' | '+' | '-' | '/'
                | ':' | '<' | '=' | '>' | '?' | '^' | '|' | '~'

;; RESERVED operators — lexable but can never be bound or overloaded:
;; '=' ':=' '::' ':' '=>' '->' '<:' '?=' '&&' '||' '#' '...#' '..' '..=' '...'
```

## Composite Expressions

```abnf
;; Parenthesized Expressions
;; Can be: grouping, unit type, or tuple
ParenExpression ::=
  | '(' ')'                                           ;; Unit type ()
  | '(' Expression ')'                                ;; Grouping
  | '(' Expression (',' Expression)+ ')'              ;; Tuple (comma-separated)
  | '(' Expression (';' Expression)+ ';'? ')'         ;; Tuple type (semicolon-separated)

;; Array Expressions
;; Square brackets with comma or semicolon separators
ArrayExpression ::=
  | '[' ']'                                           ;; Empty array literal
  | '[' Expression (',' Expression)* ']'              ;; Array literal [1, 2, 3]
  | '[' Expression ';' Expression ']'                 ;; Array type [i32; 5]

;; Curly Bracket Expressions
;; Can be: struct literal (anonymous record) or begin block
;; Separator determines the interpretation:
;; - Comma or no separator: struct literal { x: 1, y: 2 } or { x, y }
;; - Semicolon: begin block { expr; expr; expr }
CurlyBracketExpression ::=
  | '{' '}'                                           ;; Empty struct literal
  | '{' Expression (',' Expression)* ','? '}'         ;; Struct literal (comma-separated)
  | '{' ';' '}'                                       ;; Empty begin block
  | '{' Expression (';' Expression)* ';'? '}'         ;; Begin block (semicolon-separated)

;; Dot Expression
;; Leading dot for enum variants or tagged unions
;; Example: .Some(value) or .Ok
DotExpression ::= '.' PrimaryExpression
```

## Function Calls and Operators

```abnf
;; Field Access
;; Must have no whitespace around the dot
FieldAccess ::= '.' Identifier
              | '.' Operator

;; Infix Operator
;; Yo has no operator precedence. A chain of the SAME operator is
;; left-associative; adjacent DIFFERENT operators require explicit parentheses.
InfixOperator ::=
  | Whitespace* Operator Whitespace* Expression       ;; Regular infix: a + b
  | Whitespace* BacktickIdentifier Whitespace* Expression  ;; Backtick infix: a `add` b

;; Function Call
;; Calls must use parentheses, and there must be no whitespace before '('.
FunctionCall ::=
  | Expression '(' ArgumentList ')'                   ;; func(arg1, arg2)

ArgumentList ::= [Expression (',' Expression)*]
```

## Function Signatures and Parameter Modifiers

A parameter is `label : Type`, optionally wrapped by ONE modifier call.
Modifiers wrap the **label**, never the type:

```abnf
Parameter ::= ParameterLabel ':' Type
ParameterLabel ::=
  | Identifier                  ;; by value (reference-semantics types: a shared handle)
  | 'inout' '(' Identifier ')'  ;; second-class reference to a caller lvalue (binding write-back)
  | 'own' '(' Identifier ')'    ;; consumes the caller's handle (move)
  | 'comptime' '(' Identifier ')' ;; compile-time-only parameter
  | 'quote' '(' Identifier ')'  ;; macro parameter (receives the AST)
```

```rust
swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({ ... });
sink :: (fn(own(victim) : Holder) -> unit)({ ... });
```

Placement rules for `inout`:

- Parameter position (`inout(name) : T`) is the ONLY position where
  `inout` may appear.
- `inout` is **rejected in return-type position** (`-> inout(T)`,
  `-> (inout(name) : T)`), as a local binding (`inout(r) := lvalue;`), and
  inside any other type expression (`Option(inout(T))`, struct fields,
  generic arguments).
- See [FLOWABILITY.md](./FLOWABILITY.md) for the semantics.

## Comments and Whitespace

```abnf
;; Whitespace
Whitespace ::= ' ' | '\t' | '\n' | '\r'

;; Comments
SingleLineComment ::= '//' [^\n]* '\n'?
MultiLineComment  ::= '/*' (MultiLineComment | [^*] | '*' [^/])* '*/'
;; Note: Multi-line comments support nesting

;; Token Separators
Separator ::= ',' | ';'
```

## Parsing Rules

### Whitespace Sensitivity

1. **Field access** (`.`): No whitespace allowed before or after the dot

   - Valid: `obj.field`, `person.name`
   - Invalid: `obj . field`, `obj .field`

2. **Function calls**: Calls require immediate parentheses

   - Valid: `func(arg1, arg2)`
   - Invalid: `func (arg1, arg2)` or `func arg1, arg2`
   - Control-flow keywords are calls: write `return(value)`, `return()`, `unwind(value)`, or `unwind()`
   - Prefix operators (`-` `!` `~` `&` `*` `?` `^`) bind exactly ONE postfix expression (plans/reference/PREFIX_OPERATOR_OPERAND_RULE.md Rule 1): `-1`, `!ready`, `&x`, `?*T`, and `3 - -3` are valid; an INFIX operand still needs parens (`-(1 + 2)`), and the parenthesized call form (`-(x)`) is unchanged

3. **Infix operators**: no precedence
   - A chain of the same operator is left-associative: `a + b + c` ⇒ `(a + b) + c`
   - Adjacent different operators require explicit parentheses: `a + b * c` is an error; write `(a + b) * c` or `a + (b * c)`
   - Standard infix: `a + b`
   - Backtick infix: ``a `add` b``

### Separator Semantics

1. **Comma (`,`)**: Creates array literals, tuples, or struct literals

   - In `[]`: array literal
   - In `()`: tuple value
   - In `{}`: struct literal (anonymous record)

2. **Semicolon (`;`)**: Creates type expressions or begin blocks
   - In `()`: tuple type
   - In `[]`: array type `[T; N]` or slice type `[T]`
   - In `{}`: begin block (sequence of statements)

### Special Cases

1. **Empty constructs**:

   - `()` - unit value
   - `[]` - empty array
   - `{}` - empty struct
   - `{;}` - empty begin block

2. **Shorthand struct syntax**:

   - `{ x, y }` desugars to `_( x: x, y: y )`
   - Identifiers without colons use their name as both key and value

3. **Leading dot**:
   - `.Something` is sugar for enum variants or tagged unions
   - Can be used with or without arguments: `.Ok(value)` or `.None`

```

```
