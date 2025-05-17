```abnf
;; Grammar
;; Since everything in Yo is a function, the grammar is much simpler

;; Core Syntax
Program ::= [Expression (";" Expression)*] ";"?
Expression ::=
  | FunctionCall
  | Atom
  | ArrayLiteral
  | TupleLiteral
  | BlockExpression
  | RecordLiteral
  | "(" Expression ")"  // Parentheses for grouping

;; Atoms - The smallest unit of expression
Atom ::= Symbol | Literal

;; Literals
Literal ::= BooleanLiteral | NumberLiteral | StringLiteral | CharLiteral
BooleanLiteral ::= "true" | "false"
NumberLiteral ::= IntegerLiteral | FloatLiteral
IntegerLiteral ::= Digit+
FloatLiteral ::= Digit+ "." Digit+
StringLiteral ::= '"' [^\"]* '"'
CharLiteral ::= "'" [^\'] "'"

;; Symbol
Symbol  ::= Identifier | Operator

;; Identifier and Operator definitions
Identifier ::= (Letter | '_') (Letter | Digit | '_')* ('!' | '?')?
Letter     ::= 'a'..'z' | 'A'..'Z'
Digit      ::= '0'..'9'

;; Operators
Operator   ::= OperatorChar+
OperatorChar ::= '!' | '#' | '$' | '%' | '&' | '*' | '+' | '-' | '.' | '/' | ':' | '<' | '=' | '>' | '?' | '@' | '\\' | '^' | '|' | '~'

;; Array Literal - uses square brackets with comma-separated expressions
ArrayLiteral ::= "[" [Expression ("," Expression)*] "]"

;; Tuple Literal - uses parentheses with comma-separated expressions
;; For single-element tuples, a trailing comma is required to distinguish from grouping
TupleLiteral ::= "(" Expression "," [Expression ("," Expression)*] ")"  ;; Multi-element tuple with comma
               | "(" ")"  ;; Empty tuple

;; Block Expression - uses curly braces with semicolon-separated expressions
;; Must have at least one semicolon to distinguish from RecordLiteral
BlockExpression ::= "{" Expression ";" [Expression (";" Expression)*] ";"? "}"  ;; At least one expression followed by a semicolon
                  | "{" ";" "}"  ;; Empty block with just a semicolon

;; Record Literal - uses curly braces with comma-separated expressions
;; Records can have either key-value pairs (with colons) or just field names
RecordLiteral ::= "{" [Expression ("," Expression)*] ","? "}"  ;; Optional trailing comma
                | "{" "}"  ;; Empty record

;; Whitespace token
Whitespace ::= ' ' | '\t' | '\n' | '\r'

;; Function Call (the primary construct)
;; Note: Space between function name and parentheses affects parsing
FunctionCall ::= Expression Whitespace* "(" [Expression ("," Expression)*] ")"  ;; No space: Regular function call - func(arg1, arg2)
               | Expression Whitespace+ Expression ("," Expression)*            ;; Space-separated args - func arg1, arg2
               | Expression Operator Expression                                ;; Infix operator - arg1 + arg2
```
