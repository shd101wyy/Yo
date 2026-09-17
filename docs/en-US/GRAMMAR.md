# Yo Language Grammar

This document describes the grammar of the Yo programming language as
implemented in the lexer and parser (`src/lexer.yo`, `src/token.yo`,
`src/parser.yo`).

## Core Syntax

```abnf
;; Top-Level Program Structure
;; The parser scans the token stream, skipping whitespace, comments and
;; semicolons, and parses one Expression after another. A `;` after the last
;; expression appends a final unit `()` expression to the program.
Program ::= (WsOrComment | ';')* [Expression ((WsOrComment | ';')+ Expression)*] (WsOrComment | ';')*

;; Expression - The primary construct
;; Everything in Yo is an expression
Expression ::=
  | PrefixExpression                 ;; -x, !flag, &v, *T, ?T, ^v
  | PrimaryExpression PrimaryEnd*

;; Prefix Expression - a bare prefix operator binds exactly ONE postfix
;; expression: the primary plus its tight (no-whitespace) calls and
;; dot-chains. Nested prefixes recurse: `**T` = `*(*(T))`, `?*T` = `?(*(T))`.
;; (plans/reference/PREFIX_OPERATOR_OPERAND_RULE.md Rule 1)
PrefixExpression ::= PrefixOperator Operand
PrefixOperator   ::= '-' | '!' | '~' | '&' | '*' | '?' | '^'

;; Primary Expression - Starting point of any expression
PrimaryExpression ::=
  | Atom
  | ParenExpression
  | ArrayExpression
  | CurlyBracketExpression
  | DotExpression
  | TemplateString

;; Primary End - Suffix operations that can follow a primary expression
PrimaryEnd ::=
  | FieldAccess           ;; obj.field or .variant
  | InfixOperator         ;; expr + expr
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
  | TemplateString
  | CharLiteral

BooleanLiteral ::= "true" | "false"

;; Number Literals — one number is ONE token.
;; Underscore separators are allowed in DECIMAL digits only; the
;; hex/binary/octal forms take bare digits.
NumberLiteral ::= IntegerLiteral | FloatLiteral

IntegerLiteral ::=
  | DecimalInteger
  | HexInteger
  | BinaryInteger
  | OctalInteger

DecimalInteger ::= Digit (Digit | '_')*
HexInteger     ::= '0' ('x' | 'X') HexDigit+
BinaryInteger  ::= '0' ('b' | 'B') ('0' | '1')+
OctalInteger   ::= '0' ('o' | 'O') OctalDigit+

;; A Float token needs a fractional part OR an exponent — the C/Rust/Go
;; rule: `1e5` is a Float (f64 100000.0). The '.' starts a fractional part
;; only when the next char is a digit: `1.foo` lexes as `1` `.` `foo`;
;; `1..2` as `1` `..` `2`.
FloatLiteral ::= Digit (Digit | '_')* '.' Digit (Digit | '_')* Exponent?
               | Digit (Digit | '_')* Exponent

Exponent     ::= ('e' | 'E') ('+' | '-')? Digit (Digit | '_')*
;; A sign with no digit (`1e+`) is NOT an exponent: the token stays the
;; Integer `1` and the `+` lexes as an operator.

Digit          ::= '0'..'9'
HexDigit       ::= '0'..'9' | 'a'..'f' | 'A'..'F'
OctalDigit     ::= '0'..'7'

;; String and Character Literals
;; A double-quoted string is ONE line only: a raw line break before the
;; closing quote is an "unterminated string literal" error (use a template).
;; Escapes are decoded at EVALUATION time; an unknown escape passes through
;; literally (backslash and all).
StringLiteral  ::= '"' StringChar* '"'
StringChar     ::= [^"\n\r\\] | EscapeSequence

EscapeSequence ::= '\\' AnyChar
;; Recognized escapes in a "" string:
;;   \n \t \r \\ \" \' \0 \b \f \v
;;   \uXXXX        — exactly four hex digits
;;   \u{X..XXXXXX} — one to six hex digits; the largest code point is 10FFFF,
;;                   surrogates rejected
;;   a \uXXXX high surrogate directly followed by a \uXXXX low surrogate
;;   combines into one astral code point (JSON's rule)

;; Template string (backtick) — the multiline literal. It may span lines,
;; and `${expr}` interpolates a Yo expression (nested braces are tracked;
;; the interpolation text is parsed by a sub-parse). A template is decoded
;; by the LEXER — that is the difference from the "" string, whose escapes
;; are decoded at evaluation.
TemplateString ::= '`' TemplateChar* '`'
;; TemplateChar ::= any char except an unescaped '`'
;; Recognized escapes: the "" list above, plus
;;   \` (literal backtick)   \$ (literal dollar — suppresses interpolation)
;; Interpolation ::= '${' Expression '}'
;;                | '${' Expression ':' FormatSpec '}'
;; FormatSpec    ::= one or more of [0-9A-Za-z] or . < > ^ + - # * _ = ~
;; (no spaces, brackets or quotes — the spec walk can then never leave the
;; interpolation). `${expr:spec}` calls `.format("<spec>")` instead of
;; `.to_string()`, and a template with any spec auto-imports
;; `std/fmt/format` instead of `std/fmt/to_string`.

CharLiteral ::= "'" (CharChar | EscapeSequence) "'"
;; The content must be exactly ONE character (or a backslash plus one
;; character): 'ab' is a lex error. A literal opened but hit by EOF keeps
;; its single character ('a at end of file is a valid char token).
CharChar ::= AnyCharExcept ("'" | '\\')
```

## Identifiers and Operators

```abnf
;; Identifier
;; Any code point U+00A0 and above may appear in an identifier (letter or
;; not), plus ASCII letters and `_`. There is NO trailing `!` or `?` —
;; `foo?` is the identifier `foo` followed by the operator `?`.
Identifier ::= IdentifierStart IdentifierContinue*

IdentifierStart    ::= '_' | 'a'..'z' | 'A'..'Z' | Rune(≥ U+00A0)
IdentifierContinue ::= IdentifierStart | Digit
Digit              ::= '0'..'9'

;; Operators — Yo has a CLOSED operator set (plans/reference/OPERATOR_SET_AND_PRECEDENCE.md).
;; A run of operator characters is split greedily against the table below,
;; longest match first; a run containing no table operator is a lex error.
;; So `**x` lexes as '*' '*' 'x' — there is no `**` token. New operators are
;; added to the compiler deliberately, like keywords.
;; `@`, `$` and `\` ARE operator characters (they begin a run) but appear in
;; no table, so any use is an "unknown operator" lex error.
Operator      ::= DotOperator | TableOperator

;; `.` gets its own TokenKind; the rest are Operator tokens. `..#` is NOT a
;; token — it lexes as `..` followed by `#`.
DotOperator   ::= '.' | '..' | '..=' | '...' | '...#'

TableOperator ::= ;; three-character (matched first)
                  '==>'
                  ;; two-character (matched next)
                  '!=' | '&&' | '->' | '::' | ':=' | '<:' | '<<' | '<='
                | '==' | '=>' | '>=' | '>>' | '?=' | '||'
                  ;; one-character
                | '!' | '#' | '%' | '&' | '*' | '+' | '-' | '/'
                | ':' | '<' | '=' | '>' | '?' | '^' | '|' | '~'

;; RESERVED operators — lexable but can never be bound or overloaded:
;; '=' ':=' '::' ':' '=>' '->' '<:' '?=' '&&' '||' '#' '...#' '..' '..=' '...' '==>'
;; ('==>' is ghost-only implication: contract clauses / ghost bindings only)

;; There is NO backtick-infix form: a backtick always opens a template
;; string, so `a `add` b` is a syntax error.
```

## Composite Expressions

```abnf
;; Parenthesized Expressions
;; Can be: grouping, unit value, tuple value, or tuple type.
;; Mixing `,` and `;` inside one (...) is a parse error.
ParenExpression ::=
  | '(' ')'                                           ;; Unit value ()
  | '(' Expression ')'                                ;; Grouping
  | '(' Expression (',' Expression)+ ','? ')'         ;; Tuple value (comma-separated)
  | '(' Expression (';' Expression)+ ';'? ')'         ;; Tuple type (semicolon-separated)

;; Array Expressions
;; Mixing `,` and `;` inside one [...] is a parse error.
ArrayExpression ::=
  | '[' ']'                                           ;; Empty array value
  | '[' Expression (',' Expression)* ','? ']'         ;; Array value (comma-separated)
  | '[' Expression ';' Expression ']'                 ;; Array type [T; N]

;; The old slice-type forms `[T]` and `[T;]` are REMOVED — the builtin
;; Slice type is deleted (plans/archive/SLICE_REWORK.md), so both are a
;; parse error telling you to write `RawSlice(T)`. A one-element array
;; value is written with a trailing comma: `[expr,]`.

;; Curly Bracket Expressions
;; A brace group is a RECORD unless it contains a semicolon — the same rule in
;; every position: a value, the left side of `::` / `:=` / `=`, and a `match`
;; payload pattern. That uniformity is deliberate (decided 2026-09-16,
;; plans/archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md §4): patterns and literals can
;; never disagree about what a brace means. The consequence to know is that
;; `{ x }` is a ONE-FIELD RECORD, not a one-expression block — write `x` for
;; the value and `{ x; }` for a block. The compiler says so where it can.
;; Separator determines the interpretation:
;; - Comma or no separator: record literal { x: 1, y: 2 } or { x, y }
;; - Semicolon: begin block { expr; expr; expr }
CurlyBracketExpression ::=
  | '{' '}'                                           ;; Empty record
  | '{' Field (',' Field)* ','? '}'                   ;; Record literal (comma-separated)
  | '{' ';' '}'                                       ;; Empty begin block (begin(unit))
  | '{' Expression (';' Expression)* ';'? '}'         ;; Begin block (semicolon-separated)

;; A record Field is a bare identifier (rewritten to `name : name`) or a
;; `key : value` pair; anything else in a comma group is the parse error
;; "{ ... } without semicolons is parsed as a struct literal, not a block.
;; To write a block, use semicolons: { stmt1; stmt2; }".
Field ::= Identifier | Expression ':' Expression

;; A begin block's trailing `;` appends a final unit: `{ x; y; }` has value
;; `()`; `{ x; y }` has value `y`.

;; Dot Expression
;; Leading dot for enum variants or tagged unions
;; Example: .Some(value) or .Ok
DotExpression ::= '.' PrimaryExpression
```

## Function Calls and Operators

```abnf
;; Field Access
;; The dot must be tight on BOTH sides, with ONE exception: a dot that
;; starts a new line continues the expression (method chaining across
;; lines). A line ENDING in a dot is an error.
FieldAccess ::= Expression '.' PrimaryExpression

;; Infix Operator
;; Yo has no operator precedence. A chain of the SAME operator is
;; left-associative; adjacent DIFFERENT operators require explicit parentheses.
InfixOperator ::=
  | Whitespace* Operator Whitespace* Expression       ;; Regular infix: a + b

;; Function Call
;; Calls must use parentheses, and there must be no whitespace before '('.
;; A trailing comma before ')' is NOT allowed in an argument list.
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
;; Whitespace — exactly these four (rune.is_whitespace is ASCII-only)
Whitespace ::= ' ' | '\t' | '\n' | '\r'

;; Comments — the `///` and `/**` (and `//!` / `/*!`) forms are doc
;; comments, extracted by `yo doc`.
SingleLineComment    ::= '//' [^\n]* '\n'?
DocLineComment       ::= '///' [^\n]* '\n'?     ;; but '////' is a PLAIN comment
InnerDocLineComment  ::= '//!' [^\n]* '\n'?
MultiLineComment     ::= '/*' (MultiLineComment | [^*] | '*' [^/])* '*/'
DocBlockComment      ::= '/**' MultiLineComment '*/'   ;; but '/**/' is PLAIN
InnerDocBlockComment ::= '/*!' MultiLineComment '*/'
;; Note: Multi-line comments support nesting

;; Token Separators
Separator ::= ',' | ';'
```

## Parsing Rules

### Whitespace Sensitivity

1. **Field access** (`.`): No whitespace allowed before or after the dot,
   EXCEPT a dot at the start of a line, which continues the expression
   (method chaining across lines):

   - Valid: `obj.field`, `person.name`
   - Invalid: `obj . field`, `obj .field`
   - Valid (chaining):

   ```rust
   n := list
     .len()
     .to_string();
   ```

   - Invalid: a line ending in a dot (`list.` at end of line, `.len()` on
     the next)

2. **Function calls**: Calls require immediate parentheses

   - Valid: `func(arg1, arg2)`
   - Invalid: `func (arg1, arg2)` or `func arg1, arg2`
   - Control-flow keywords are calls: write `return(value)`, `return()`, `unwind(value)`, or `unwind()`
   - Prefix operators (`-` `!` `~` `&` `*` `?` `^`) bind exactly ONE postfix expression (plans/reference/PREFIX_OPERATOR_OPERAND_RULE.md Rule 1): `-1`, `!ready`, `&x`, `?*T`, and `3 - -3` are valid; an INFIX operand still needs parens (`-(1 + 2)`), and the parenthesized call form (`-(x)`) is unchanged

3. **Infix operators**: no precedence
   - A chain of the same operator is left-associative: `a + b + c` ⇒ `(a + b) + c`
   - Adjacent different operators require explicit parentheses: `a + b * c` is an error; write `(a + b) * c` or `a + (b * c)`
   - Standard infix: `a + b`

4. **`if(...)` is sugar**: `if` calls are desugared to `cond(...)` at parse
   time (`desugar_program_if_calls` in `src/expr.yo`); a call the desugar
   leaves alone (odd arity, mismatched labels) is an error.

### Separator Semantics

1. **Comma (`,`)**: Creates array literals, tuple values, or record literals

   - In `[]`: array literal
   - In `()`: tuple value
   - In `{}`: record literal (anonymous struct)

2. **Semicolon (`;`)**: Creates type expressions or begin blocks
   - In `()`: tuple type
   - In `[]`: array type `[T; N]`
   - In `{}`: begin block (sequence of statements)

### Special Cases

1. **Empty constructs**:

   - `()` - unit value
   - `[]` - empty array
   - `{}` - empty record
   - `{;}` - empty begin block

2. **Shorthand record syntax**:

   - `{ x, y }` desugars to `_( x: x, y: y )`
   - Identifiers without colons use their name as both key and value

3. **Leading dot**:
   - `.Something` is sugar for enum variants or tagged unions
   - Can be used with or without arguments: `.Ok(value)` or `.None`
