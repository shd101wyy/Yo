# Yo 语言语法

本文档描述了 Yo 编程语言在解析器和词法分析器中实现的语法规则。

## 核心语法

```abnf
;; 顶层程序结构
Program ::= Whitespace* [Expression (Whitespace* ";" Whitespace* Expression)*] Whitespace* ";"?

;; 表达式 — 最基本的构造
;; Yo 中一切皆为表达式
Expression ::= PrimaryExpression PrimaryEnd*

;; 主表达式 — 任何表达式的起始点
PrimaryExpression ::=
  | Atom
  | ParenExpression
  | ArrayExpression
  | CurlyBracketExpression
  | DotExpression

;; 后缀操作 — 可跟在主表达式后面的后缀操作
PrimaryEnd ::=
  | FieldAccess           ;; obj.field 或 .variant
  | InfixOperator         ;; expr + expr, expr `add` expr
  | FunctionCall          ;; func(args)，且 '(' 前不能有空白
```

## 原子

```abnf
;; 原子 — 表达式的最小单元
Atom ::= Literal | Identifier | Operator

;; 字面量
Literal ::=
  | BooleanLiteral
  | NumberLiteral
  | StringLiteral
  | CharLiteral

BooleanLiteral ::= "true" | "false"

;; 数值字面量
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

;; 字符串和字符字面量
StringLiteral  ::= '"' StringChar* '"'
StringChar     ::= [^"\\] | EscapeSequence

CharLiteral    ::= "'" (CharChar | EscapeSequence) "'"
CharChar       ::= [^'\\]

EscapeSequence ::= '\\' AnyChar
```

## 标识符和运算符

```abnf
;; 标识符
;; 支持 Unicode 字符，可选尾随 ! 或 ?
Identifier ::= IdentifierStart IdentifierContinue* ('!' | '?')?

IdentifierStart    ::= Letter | '_'
IdentifierContinue ::= Letter | Digit | '_'
Letter             ::= 'a'..'z' | 'A'..'Z' | UnicodeChar
UnicodeChar        ::= '\xA0'..'\uFFFF'
Digit              ::= '0'..'9'

;; 反引号标识符 — 用于中缀表示法
;; 示例：3 `add` 4
BacktickIdentifier ::= '`' Identifier '`'

;; 运算符
;; 点运算符有特殊处理 — 只能与其他点组合
Operator      ::= DotOperator | NonDotOperator
DotOperator   ::= '.' '.'*
NonDotOperator ::= OperatorChar+ (excluding any '.')

OperatorChar  ::= '!' | '#' | '$' | '%' | '&' | '*' | '+' | '-' | '.' | '/'
                | ':' | '<' | '=' | '>' | '?' | '@' | '\\' | '^' | '|' | '~'
```

## 复合表达式

```abnf
;; 圆括号表达式
;; 可以是：分组、unit 类型或元组
ParenExpression ::=
  | '(' ')'                                           ;; Unit 类型 ()
  | '(' Expression ')'                                ;; 分组
  | '(' Expression (',' Expression)+ ')'              ;; 元组（逗号分隔）
  | '(' Expression (';' Expression)+ ';'? ')'         ;; 元组类型（分号分隔）

;; 数组表达式
;; 方括号，使用逗号或分号作为分隔符
ArrayExpression ::=
  | '[' ']'                                           ;; 空数组字面量
  | '[' Expression (',' Expression)* ']'              ;; 数组字面量 [1, 2, 3]
  | '[' Expression (';' Expression)? ']'              ;; 数组类型 [i32; 5]

;; 花括号表达式
;; 可以是：结构体字面量（匿名记录）或 begin 块
;; 分隔符决定解释方式：
;; - 逗号或无分隔符：结构体字面量 { x: 1, y: 2 } 或 { x, y }
;; - 分号：begin 块 { expr; expr; expr }
CurlyBracketExpression ::=
  | '{' '}'                                           ;; 空结构体字面量
  | '{' Expression (',' Expression)* ','? '}'         ;; 结构体字面量（逗号分隔）
  | '{' ';' '}'                                       ;; 空 begin 块
  | '{' Expression (';' Expression)* ';'? '}'         ;; begin 块（分号分隔）

;; 点表达式
;; 前导点用于枚举变体或标签联合
;; 示例：.Some(value) 或 .Ok
DotExpression ::= '.' PrimaryExpression
```

## 函数调用和运算符

```abnf
;; 字段访问
;; 点的前后不能有空格
FieldAccess ::= '.' Identifier
              | '.' Operator

;; 中缀运算符
;; Yo 没有运算符优先级。相同运算符的链是左结合的；
;; 相邻的不同运算符需要显式括号。
InfixOperator ::=
  | Whitespace* Operator Whitespace* Expression       ;; 常规中缀：a + b
  | Whitespace* BacktickIdentifier Whitespace* Expression  ;; 反引号中缀：a `add` b

;; 函数调用
;; 调用必须使用括号，且 '(' 前不能有空白。
FunctionCall ::=
  | Expression '(' ArgumentList ')'                   ;; func(arg1, arg2)

ArgumentList ::= [Expression (',' Expression)*]
```

## 函数签名与参数修饰符

参数形如 `label : Type`，可选地由**一个**修饰符调用包裹。修饰符包裹的
是**标签**，而不是类型：

```abnf
Parameter ::= ParameterLabel ':' Type
ParameterLabel ::=
  | Identifier                  ;; 按值传递（引用语义类型即共享句柄）
  | 'inout' '(' Identifier ')'  ;; 指向调用者左值的二等引用（绑定写回）
  | 'own' '(' Identifier ')'    ;; 消耗调用者的句柄（移动）
  | 'comptime' '(' Identifier ')' ;; 仅编译期参数
  | 'quote' '(' Identifier ')'  ;; 宏参数（接收 AST）
```

```rust
swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({ ... });
sink :: (fn(own(victim) : Holder) -> unit)({ ... });
```

`inout` 的位置规则：

- 参数位置（`inout(name) : T`）是 `inout` 唯一的合法位置。
- `inout` 在**返回类型位置被拒绝**（`-> inout(T)`、`-> (inout(name) : T)`），
  作为局部绑定（`inout(r) := lvalue;`）也被拒绝，更不能出现在任何其他
  类型表达式中（`Option(inout(T))`、struct 字段、泛型实参）。
- 语义详见 [FLOWABILITY.md](./FLOWABILITY.md)。

## 注释和空白

```abnf
;; 空白字符
Whitespace ::= ' ' | '\t' | '\n' | '\r'

;; 注释
SingleLineComment ::= '//' [^\n]* '\n'?
MultiLineComment  ::= '/*' (MultiLineComment | [^*] | '*' [^/])* '*/'
;; 注意：多行注释支持嵌套

;; Token 分隔符
Separator ::= ',' | ';'
```

## 解析规则

### 空格敏感性

1. **字段访问**（`.`）：点的前后不允许有空格

   - 有效：`obj.field`、`person.name`
   - 无效：`obj . field`、`obj .field`

2. **函数调用**：调用必须紧跟括号

   - 有效：`func(arg1, arg2)`
   - 无效：`func (arg1, arg2)` 或 `func arg1, arg2`
   - 前缀运算符也是调用：请写 `&(x)`、`!(ready)`、`return(value)`、`return()`、`unwind(value)` 或 `unwind()`

3. **中缀运算符**：无优先级
   - 相同运算符的链是左结合的：`a + b + c` ⇒ `(a + b) + c`
   - 相邻的不同运算符需要显式括号：`a + b * c` 是错误的；应写成 `(a + b) * c` 或 `a + (b * c)`
   - 标准中缀：`a + b`
   - 反引号中缀：``a `add` b``

### 分隔符语义

1. **逗号（`,`）**：创建数组字面量、元组或结构体字面量

   - 在 `[]` 中：数组字面量
   - 在 `()` 中：元组值
   - 在 `{}` 中：结构体字面量（匿名记录）

2. **分号（`;`）**：创建类型表达式或 begin 块
   - 在 `()` 中：元组类型
   - 在 `[]` 中：数组类型 `[T; N]` 或切片类型 `[T]`
   - 在 `{}` 中：begin 块（语句序列）

### 特殊情况

1. **空构造**：

   - `()` — unit 值
   - `[]` — 空数组
   - `{}` — 空结构体
   - `{;}` — 空 begin 块

2. **结构体简写语法**：

   - `{ x, y }` 脱糖为 `_( x: x, y: y )`
   - 不带冒号的标识符同时用作键名和值

3. **前导点**：
   - `.Something` 是枚举变体或标签联合的语法糖
   - 可以带参数也可以不带参数：`.Ok(value)` 或 `.None`

```

```
