# 错误处理

Yo 程序如何报告与处理失败：`Result` 值、`Error` trait 与 `AnyError`，以及
`Exception` 与 `ResumableException` 效应。效应的一般说明见
[ALGEBRAIC_EFFECTS.md](./ALGEBRAIC_EFFECTS.md)；运行时中止（溢出、越界）见
[SYNTAX.md](./SYNTAX.md#算术与失败语义)。

## 概述

Yo 提供了两种错误处理方式：

1. **Result ADT** — 使用模式匹配的显式 `Result(T, E)` 值
2. **Exception / ResumableException** — 基于代数效应的异常式控制流

## Result 类型

`Result` 类型是一个代数数据类型，用于可能失败的函数：

```yo
// 定义一个错误类型
DivisionError :: enum(
  DivideByZero,
  Overflow
);

// 可能失败的函数
safe_div :: (fn(a : i32, b : i32) -> Result(i32, DivisionError))(
  cond(
    (b == i32(0)) => .Error(.DivideByZero),
    true => .Ok(a / b)
  )
);

// 使用模式匹配处理错误
result := safe_div(10, 2);
match(
  result,
  .Ok(value) => printf("Result: %d\n", value),
  .Error(error) => match(
    error,
    .DivideByZero => printf("Error: Cannot divide by zero\n"),
    .Overflow => printf("Error: Overflow\n")
  )
);
```

## Error Trait 和 AnyError

标准库定义了用于动态错误处理的 `Error` trait 和 `AnyError` 类型：

```yo
{ Error, AnyError } :: import("std/error");

// Error trait 要求实现 ToString。`derive(Error)` 只需按声明顺序为每个变体
// 写一条消息，即可同时生成两者：
MathError :: enum(
  DivisionByZero,
  NegativeSqrt
);
derive(
  MathError,
  Error(
    .DivisionByZero => `Division by zero`,
    .NegativeSqrt => `Square root of a negative number`
  )
);
// AnyError 的载荷必须实现 Clone（见下）：
derive(MathError, Clone);

// 消息就是普通的 Yo 代码，会被拼接进绑定负载的那条 match 分支，因此变体自己的
// 字段可以按名字插值：
//   .NotFound(path : String)  =>  `not found: ${path}`
// 手写这两个 impl 依然可用；当消息不是简单的「每个变体一条字符串」时，就该那么写。
// AnyError 是 Box(Dyn(Error, Clone)) — 任何实现了 Error 和 Clone 的类型都
// 可以用 dyn(Box.new(e)) 包装。它独占其载荷，而 `throw`
// 按值传递错误，所以处理器通过移动来保留捕获的错误。
(err : AnyError) = dyn(Box.new(MathError.DivisionByZero));

// 向下转型回具体类型，借用它：
match(
  downcast(&err.*, MathError),
  .Some(math_err) => printf("Got MathError\n"),
  .None => printf("Not a MathError\n")
);
```

## Exception（不可恢复异常）

`Exception` 是用于不可恢复异常处理的效应捆绑。它的 `throw` 字段
是一个 `ctl(...) -> ret` 处理器 — 调用 `unwind(...)` 会丢弃续延，
从外围函数返回：

```yo
{ Exception } :: import("std/error");

safe_divide :: (fn(x : i32, y : i32, exn : Exception) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(Box.new(MathError.DivisionByZero))),
    true => (x / y)
  )
);

// 安装处理器 — 注意 lambda 外层的括号（Yo 没有运算符优先级）。
(exn : Exception) = Exception(
  throw : (
    err -> {
      println(`Error: ${err}`); // 打印 "Error: Division by zero"
      unwind(()); // 丢弃续延，从外围函数返回
    }
  )
);

result := safe_divide(6, 3, exn); // result = 2
safe_divide(10, 0, exn); // 处理器触发，unwind — 之后的代码不会执行
```

`Exception` 的处理器不会恢复 throw。`throw` 的恢复类型是一个由每个
throw 点各自选定的类型变量，所以处理器的每条路径都必须 `unwind(value)`
或发散（`panic(msg)`）。`return` 的处理器（带值，如
`err -> { return(i32(7)); }`，或带 `()`）是 E0627，能执行到末尾的处理器
也是：`err -> ()`，或以 `assert(false, msg);` 结尾的块，它的类型是 `()`。
错误信息会指向 `ResumableException`。

## ResumableException

`ResumableException(ResumeType)` 用于可恢复异常处理。当处理器调用
`return` 时，它会以恢复值恢复续延：

```yo
{ ResumableException } :: import("std/error");

safe_divide :: (fn(x : i32, y : i32, exn : ResumableException(i32)) -> i32)(
  cond(
    (y == i32(0)) => exn.throw(dyn(Box.new(`division by zero`))),
    true => (x / y)
  )
);

(exn : ResumableException(i32)) = ResumableException(i32)(
  throw : (
    err -> {
      println(`Error: ${err}`);
      return(i32(0)); // 以恢复值 0 恢复续延
    }
  )
);

result := safe_divide(6, 3, exn); // result = 2
result2 := safe_divide(10, 0, exn); // 处理器以 0 恢复续延，result2 = 0
```

更多示例请参阅 `tests/error.test.yo`。
