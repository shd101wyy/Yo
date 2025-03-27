```abnf
;; Grammar
;; Since everything in Mo is a function, the grammar is much simpler

;; Core Syntax
Program ::= [Expression (";" Expression)*] ";"?
Expression ::= 
  | Atom 
  | FunctionCall
  | ArrayLiteral
  | TupleLiteral
  | BlockExpression
  | RecordLiteral
  | "(" Expression ")"  // Parentheses for grouping

;; Atoms (leaf nodes)
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
InfixIdentifier ::= '`' Identifier '`'

;; Operators
Operator   ::= OperatorChar+
OperatorChar ::= '!' | '#' | '$' | '%' | '&' | '*' | '+' | '-' | '.' | '/' | ':' | '<' | '=' | '>' | '?' | '@' | '\\' | '^' | '|' | '~'

;; Array Literal - uses square brackets with comma-separated expressions
ArrayLiteral ::= "[" [Expression ("," Expression)*] "]"

;; Tuple Literal - uses parentheses with comma-separated expressions
;; For single-element tuples, a trailing comma is required to distinguish from grouping
TupleLiteral ::= "(" Expression "," [Expression ("," Expression)*] ")"
               | "(" ")"  ;; Empty tuple

;; Block Expression - uses curly braces with semicolon-separated expressions
;; Each expression must be followed by a semicolon, except for the last one (which is optional)
BlockExpression ::= "{" [Expression (";" Expression)*] ";"? "}"
                  | "{" ";" "}"  ;; Empty block with just a semicolon

;; Record Literal - uses curly braces with comma-separated expressions
;; Records can have either key-value pairs (with colons) or just field names
RecordLiteral ::= "{" [Expression ("," Expression)*] ","? "}"  ;; Optional trailing comma
                | "{" "}"  ;; Empty record

;; Function Call (the primary construct)
FunctionCall ::= Expression "(" [Expression ("," Expression)*] ")"  // func(arg1, arg2)
               | Expression Expression ("," Expression)*  // func arg1, arg2, ...
               | Expression Operator Expression  // arg1 + arg2
               | Expression InfixIdentifier Expression  // arg1 `add` arg2
```
