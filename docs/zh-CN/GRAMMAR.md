# Yo 语言语法

本文档描述了 Yo 编程语言在词法分析器和解析器（`src/lexer.yo`、`src/token.yo`、
`src/parser.yo`）中实现的语法规则。

## 核心语法

```abnf
;; 顶层程序结构
;; 解析器扫描 token 流，跳过空白、注释和分号，逐个解析表达式。
;; 最后一个表达式之后的 `;` 会向程序追加一个结尾的 unit `()` 表达式。
Program ::= (WsOrComment | ';')* [Expression ((WsOrComment | ';')+ Expression)*] (WsOrComment | ';')*

;; 表达式 — 最基本的构造
;; Yo 中一切皆为表达式
Expression ::=
  | PrefixExpression                 ;; -x、!flag、&v、*T、?T、^v
  | PrimaryExpression PrimaryEnd*

;; 前缀表达式 — 裸前缀运算符只绑定恰好一个后缀表达式：
;; 主表达式加上其紧随（无空白）的调用和点链。嵌套前缀递归：
;; `**T` = `*(*(T))`，`?*T` = `?(*(T))`。
;; （plans/reference/PREFIX_OPERATOR_OPERAND_RULE.md 规则 1）
PrefixExpression ::= PrefixOperator Operand
PrefixOperator   ::= '-' | '!' | '~' | '&' | '*' | '?' | '^'

;; 主表达式 — 任何表达式的起始点
PrimaryExpression ::=
  | Atom
  | ParenExpression
  | ArrayExpression
  | CurlyBracketExpression
  | DotExpression
  | TemplateString

;; 后缀操作 — 可跟在主表达式后面的后缀操作
PrimaryEnd ::=
  | FieldAccess           ;; obj.field 或 .variant
  | InfixOperator         ;; expr + expr
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
  | TemplateString
  | CharLiteral

BooleanLiteral ::= "true" | "false"

;; 数值字面量 — 一个数字是一个 token。
;; 只有十进制数字允许 `_` 分隔符；十六进制/二进制/八进制形式只接受裸数字。
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

;; Float token 必须有小数部分：只有当 '.' 后面是数字时才开始小数部分。
;; `1.foo` 词法分析为 `1` `.` `foo`；`1..2` 分析为 `1` `..` `2`。
FloatLiteral ::= Digit (Digit | '_')* '.' Digit (Digit | '_')* Exponent?

;; 指数也可以跟在整数后面（`1e5` 词法分析为一个 Integer token），
;; 但这样的 token 无法求值 —— 浮点数请写小数部分（`1.5e3`）。
Exponent       ::= ('e' | 'E') ('+' | '-')? Digit (Digit | '_')*

Digit          ::= '0'..'9'
HexDigit       ::= '0'..'9' | 'a'..'f' | 'A'..'F'
OctalDigit     ::= '0'..'7'

;; 字符串与字符字面量
;; 双引号字符串只占一行：闭合引号前出现原始换行符是"未终止的字符串字面量"
;; 错误（多行请用模板字符串）。转义在求值时解码；未知转义原样保留
;; （连反斜杠一起保留）。
StringLiteral  ::= '"' StringChar* '"'
StringChar     ::= [^"\n\r\\] | EscapeSequence

EscapeSequence ::= '\\' AnyChar
;; "" 字符串中可识别的转义：
;;   \n \t \r \\ \" \' \0 \b \f \v
;;   \uXXXX        —— 恰好四个十六进制数字
;;   \u{X..XXXXXX} —— 一到六个十六进制数字；最大码点是 10FFFF，拒绝代理区
;;   \uXXXX 高代理紧跟 \uXXXX 低代理会合并为一个星面码点（JSON 规则）

;; 模板字符串（反引号）— 多行字面量。可以跨行，`${expr}` 插值一个 Yo
;; 表达式（跟踪嵌套花括号；插值文本由子解析器解析）。模板由词法分析器
;; 解码 —— 这正是它与 "" 字符串的区别，后者的转义在求值时才解码。
TemplateString ::= '`' TemplateChar* '`'
;; TemplateChar ::= 除未转义的 '`' 之外的任意字符
;; 可识别的转义：上面 "" 列表中的全部，外加
;;   \`（字面反引号）   \$（字面美元符 —— 抑制插值）
;; Interpolation ::= '${' Expression '}'
;;                | '${' Expression ':' FormatSpec '}'
;; FormatSpec    ::= 一个或多个 [0-9A-Za-z] 或 . < > ^ + - # * _ = ~
;; （不含空格、括号或引号 —— 这样 spec 回溯永远不会越出插值）。
;; `${expr:spec}` 调用 `.format("<spec>")` 而不是 `.to_string()`；含 spec
;; 的模板自动导入 `std/fmt/format` 而不是 `std/fmt/to_string`。

CharLiteral ::= "'" (CharChar | EscapeSequence) "'"
;; 内容必须恰好是一个字符（或反斜杠加一个字符）：'ab' 是词法错误。
;; 在文件末尾被截断的字面量保留其单个字符（文件末尾的 'a 是合法 char token）。
CharChar ::= 除 ("'" | '\\') 之外的任意字符
```

## 标识符与运算符

```abnf
;; 标识符
;; 码点 U+00A0 及以上的任意字符都可以出现在标识符中（无论是否为字母），
;; 另加 ASCII 字母和 `_`。没有结尾的 `!` 或 `?` —— `foo?` 是标识符 `foo`
;; 后跟运算符 `?`。
Identifier ::= IdentifierStart IdentifierContinue*

IdentifierStart    ::= '_' | 'a'..'z' | 'A'..'Z' | Rune(≥ U+00A0)
IdentifierContinue ::= IdentifierStart | Digit
Digit              ::= '0'..'9'

;; 运算符 — Yo 拥有封闭运算符集（plans/reference/OPERATOR_SET_AND_PRECEDENCE.md）。
;; 运算符字符串会按下面的表贪婪切分（最长匹配优先）；串中不含任何表内
;; 运算符即为词法错误。因此 `**x` 词法分析为 '*' '*' 'x' —— 不存在 `**`
;; token。新运算符像关键字一样被慎重地加入编译器。
;; `@`、`$` 和 `\` 是运算符字符（会开启一个串）但不在任何表中，
;; 因此任何使用都是 "unknown operator" 词法错误。
Operator      ::= DotOperator | TableOperator

;; `.` 有自己的 TokenKind；其余是 Operator token。`..#` 不是 token ——
;; 它词法分析为 `..` 后跟 `#`。
DotOperator   ::= '.' | '..' | '..=' | '...' | '...#'

TableOperator ::= ;; 三字符（最先匹配）
                  '==>'
                  ;; 两字符（其次匹配）
                  '!=' | '&&' | '->' | '::' | ':=' | '<:' | '<<' | '<='
                | '==' | '=>' | '>=' | '>>' | '?=' | '||'
                  ;; 单字符
                | '!' | '#' | '%' | '&' | '*' | '+' | '-' | '/'
                | ':' | '<' | '=' | '>' | '?' | '^' | '|' | '~'

;; 保留运算符 — 可被词法分析但永远不能被绑定或重载：
;; '=' ':=' '::' ':' '=>' '->' '<:' '?=' '&&' '||' '#' '...#' '..' '..=' '...' '==>'
;; （'==>' 是 ghost 专属蕴含：仅用于契约子句 / ghost 绑定）

;; 不存在反引号中缀形式：反引号总是开启模板字符串，
;; 因此 `a `add` b` 是语法错误。
```

## 复合表达式

```abnf
;; 括号表达式
;; 可以是：分组、unit 值、元组值或元组类型。
;; 在同一个 (...) 中混用 `,` 和 `;` 是解析错误。
ParenExpression ::=
  | '(' ')'                                           ;; Unit 值 ()
  | '(' Expression ')'                                ;; 分组
  | '(' Expression (',' Expression)+ ','? ')'         ;; 元组值（逗号分隔）
  | '(' Expression (';' Expression)+ ';'? ')'         ;; 元组类型（分号分隔）

;; 数组表达式
;; 在同一个 [...] 中混用 `,` 和 `;` 是解析错误。
ArrayExpression ::=
  | '[' ']'                                           ;; 空数组值
  | '[' Expression (',' Expression)* ','? ']'         ;; 数组值（逗号分隔）
  | '[' Expression ';' Expression ']'                 ;; 数组类型 [T; N]

;; 旧的切片类型形式 `[T]` 和 `[T;]` 已移除 —— 内建 Slice 类型已删除
;; （plans/archive/SLICE_REWORK.md），两者都是解析错误，提示改写为
;; `RawSlice(T)`。单元素数组值用尾随逗号书写：`[expr,]`。

;; 花括号表达式
;; 花括号组在没有分号时是记录（RECORD）—— 这条规则在所有位置一致：
;; 值、`::` / `:=` / `=` 的左侧、以及 `match` 载荷模式。这种一致性是
;; 有意为之（2026-09-16 决定，plans/archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md §4）：
;; 模式与字面量永远不会对一个花括号的含义产生分歧。需要知道的结果是：
;; `{ x }` 是单字段记录，而不是单表达式块 —— 值直接写 `x`，块写 `{ x; }`。
;; 编译器在能报告的地方都会明确提示。
;; 分隔符决定解释方式：
;; - 逗号或无分隔符：记录字面量 { x: 1, y: 2 } 或 { x, y }
;; - 分号：begin 块 { expr; expr; expr }
CurlyBracketExpression ::=
  | '{' '}'                                           ;; 空记录
  | '{' Field (',' Field)* ','? '}'                   ;; 记录字面量（逗号分隔）
  | '{' ';' '}'                                       ;; 空 begin 块（begin(unit)）
  | '{' Expression (';' Expression)* ';'? '}'         ;; begin 块（分号分隔）

;; 记录的 Field 是裸标识符（改写为 `name : name`）或 `key : value` 对；
;; 逗号组中的其他任何内容都是解析错误
;; "{ ... } without semicolons is parsed as a struct literal, not a block.
;; To write a block, use semicolons: { stmt1; stmt2; }"。
Field ::= Identifier | Expression ':' Expression

;; begin 块的尾随 `;` 会追加一个结尾 unit：`{ x; y; }` 的值是 `()`；
;; `{ x; y }` 的值是 `y`。

;; 点表达式
;; 前导点用于枚举变体或标签联合
;; 示例：.Some(value) 或 .Ok
DotExpression ::= '.' PrimaryExpression
```

## 函数调用与运算符

```abnf
;; 字段访问
;; 点的两侧都必须紧贴，只有一个例外：位于行首的点会延续表达式
;; （跨行方法链）。以点结尾的行是错误。
FieldAccess ::= Expression '.' PrimaryExpression

;; 中缀运算符
;; Yo 没有运算符优先级。同一运算符的链左结合；相邻的不同运算符
;; 需要显式括号。
InfixOperator ::=
  | Whitespace* Operator Whitespace* Expression       ;; 普通中缀：a + b

;; 函数调用
;; 调用必须使用括号，且 '(' 前不能有空白。
;; 参数列表中 ')' 前不允许尾随逗号。
FunctionCall ::=
  | Expression '(' ArgumentList ')'                   ;; func(arg1, arg2)

ArgumentList ::= [Expression (',' Expression)*]
```

## 函数签名与参数修饰符

参数是 `label : Type`，可选地被恰好一个修饰符调用包裹。
修饰符包裹的是**标签**，绝不是类型：

```abnf
Parameter ::= ParameterLabel ':' Type
ParameterLabel ::=
  | Identifier                  ;; 按值（引用语义类型：共享句柄）
  | 'inout' '(' Identifier ')'  ;; 指向调用方左值的二等引用（绑定写回）
  | 'own' '(' Identifier ')'    ;; 消费调用方的句柄（移动）
  | 'comptime' '(' Identifier ')' ;; 仅限编译期的参数
  | 'quote' '(' Identifier ')'  ;; 宏参数（接收 AST）
```

```rust
swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({ ... });
sink :: (fn(own(victim) : Holder) -> unit)({ ... });
```

`inout` 的位置规则：

- 参数位置（`inout(name) : T`）是 `inout` 唯一可以出现的位置。
- `inout` 在**返回类型位置被拒绝**（`-> inout(T)`、`-> (inout(name) : T)`）、
  作为局部绑定被拒绝（`inout(r) := lvalue;`），以及在任何其他类型表达式
  中被拒绝（`Option(inout(T))`、结构体字段、泛型参数）。
- 语义见 [FLOWABILITY.md](./FLOWABILITY.md)。

## 注释与空白

```abnf
;; 空白 — 恰好这四种（rune.is_whitespace 只覆盖 ASCII）
Whitespace ::= ' ' | '\t' | '\n' | '\r'

;; 注释 — `///` 和 `/**`（以及 `//!` / `/*!`）形式是文档注释，
;; 由 `yo doc` 提取。
SingleLineComment    ::= '//' [^\n]* '\n'?
DocLineComment       ::= '///' [^\n]* '\n'?     ;; 但 '////' 是普通注释
InnerDocLineComment  ::= '//!' [^\n]* '\n'?
MultiLineComment     ::= '/*' (MultiLineComment | [^*] | '*' [^/])* '*/'
DocBlockComment      ::= '/**' MultiLineComment '*/'   ;; 但 '/**/' 是普通注释
InnerDocBlockComment ::= '/*!' MultiLineComment '*/'
;; 注意：多行注释支持嵌套

;; token 分隔符
Separator ::= ',' | ';'
```

## 解析规则

### 空白敏感性

1. **字段访问**（`.`）：点的两侧不允许空白，例外是行首的点 —— 它延续
   表达式（跨行方法链）：

   - 合法：`obj.field`、`person.name`
   - 非法：`obj . field`、`obj .field`
   - 合法（方法链）：

   ```rust
   n := list
     .len()
     .to_string();
   ```

   - 非法：以点结尾的行（`list.` 在行尾，`.len()` 在下一行）

2. **函数调用**：调用必须紧跟括号

   - 合法：`func(arg1, arg2)`
   - 非法：`func (arg1, arg2)` 或 `func arg1, arg2`
   - 控制流关键字也是调用：写 `return(value)`、`return()`、`unwind(value)` 或 `unwind()`
   - 前缀运算符（`-` `!` `~` `&` `*` `?` `^`）只绑定恰好一个后缀表达式（plans/reference/PREFIX_OPERATOR_OPERAND_RULE.md 规则 1）：`-1`、`!ready`、`&x`、`?*T`、`3 - -3` 都合法；中缀操作数仍需括号（`-(1 + 2)`），括号调用形式（`-(x)`）不变

3. **中缀运算符**：没有优先级
   - 同一运算符的链左结合：`a + b + c` ⇒ `(a + b) + c`
   - 相邻的不同运算符需要显式括号：`a + b * c` 是错误；写 `(a + b) * c` 或 `a + (b * c)`
   - 标准中缀：`a + b`

4. **`if(...)` 是语法糖**：`if` 调用在解析期被脱糖为 `cond(...)`
   （`src/expr.yo` 的 `desugar_program_if_calls`）；脱糖无法处理的调用
   （参数个数不对、标签不匹配）是错误。

### 分隔符语义

1. **逗号（`,`）**：构造数组字面量、元组值或记录字面量

   - 在 `[]` 中：数组字面量
   - 在 `()` 中：元组值
   - 在 `{}` 中：记录字面量（匿名结构体）

2. **分号（`;`）**：构造类型表达式或 begin 块
   - 在 `()` 中：元组类型
   - 在 `[]` 中：数组类型 `[T; N]`
   - 在 `{}` 中：begin 块（语句序列）

### 特殊情形

1. **空构造**：

   - `()` - unit 值
   - `[]` - 空数组
   - `{}` - 空记录
   - `{;}` - 空 begin 块

2. **记录简写**：

   - `{ x, y }` 脱糖为 `_( x: x, y: y )`
   - 没有冒号的标识符把名字同时用作键和值

3. **前导点**：
   - `.Something` 是枚举变体或标签联合的简写
   - 可带可不带参数：`.Ok(value)` 或 `.None`
