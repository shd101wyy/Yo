# 代数效应与处理器

## 概述

Yo 支持**代数效应** — 一次性定界续延（one-shot delimited continuations）。效应是常规函数参数，其处理器体可能使用 `unwind` 丢弃续延或 `return(value)` 恢复续延。

所有参数均为显式参数，不存在隐式（`using`/`given`）参数。

代码生成策略为**证据传递**（evidence passing）— 效应处理器函数指针作为额外的 C 参数传递。

## 设计

| 原则       | 决策                             |
| ---------- | -------------------------------- |
| 显式参数   | 所有函数参数在每次调用时显式传递 |
| 证据传递   | 处理器函数指针作为 C 参数        |
| 一次性续延 | `return` 恢复，`unwind` 丢弃     |
| 效应多态   | `forall(E : Struct)` + `e : E`   |
| 效应捆绑   | 匿名结构体 `{ raise, log }`      |

## 语法

### 声明与使用效应

```rust
// 声明效应操作类型
Raise :: (fn(msg : String) -> i32);

// 使用该效应的函数 — 常规参数
safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(
  cond(
    (y == 0) => raise("div-by-zero"),
    true => (x / y)
  )
);

// 安装处理器 — 常规变量声明
raise_handler := (msg) -> { unwind(42); };

// 调用点 — 显式参数传递
result := safe_divide(1, 0, raise_handler);
```

### 续延控制

- **`unwind(value)`** — 丢弃续延，从所在函数返回
- **`return(value)`** — 以 `value` 恢复续延

### 效应传播

函数通过接受效应作为参数并转发给被调用者来传播效应：

```rust
wrapper :: (fn(x : i32, raise : Raise) -> i32)(
  safe_divide(x, 0, raise)
);
```

### 效应行多态

效应多态函数使用 `forall(E : Struct)`，`E` 绑定到效应处理器的匿名结构体：

```rust
run :: (fn(forall(T : Type, E : Struct),
    f : (fn(e : E) -> T),
    e : E) -> T)(f(e));

effects := { raise : my_raise, log : my_log };
result := run(might_fail, effects);
```

无效应 → 空结构体 `{}`：

```rust
result := run(pure_func, {});
```

### 异步 + 效应

`Future` 在类型层是**单参数**的：`Future(T, E)`，其中 `E` 是承载效应捆绑的结构体类型。捆绑的类型与值结构一致。

```rust
effects := { raise, log };

fut := io.async((e) => {
  e.raise("err");
  e.log("hello");
});

result := io.await(fut, effects);
```

单效应 Future 直接传效应值，因为效应类型本身就是结构体：

```rust
// Future(T, IO) — E = IO，e = io
fut1 : Impl(Future(i32, IO));
x := io.await(fut1, io);
```

多效应 Future 使用结构体别名。常见捆绑在 `std/error.yo` 中：

```rust
// IOErr :: struct(io : IO, exn : Exception)
fut2 : Impl(Future(i32, IOErr));
y := io.await(fut2, { io, exn });
```

宽度匹配**严格** — Yo 的结构体是名义类型。如果调用方持有 `e : IOErr` 但被调用方只需要 `IO`，必须显式投影：

```rust
// fut 需要 IO；投影到 e.io
result := io.await(fut, e.io);
```

## 对比：之前 vs 之后

| 概念         | 之前（隐式）                       | 之后（显式）                |
| ------------ | ---------------------------------- | --------------------------- |
| 效应参数     | `using(raise : Raise)`             | `raise : Raise`             |
| 调用点       | `safe_divide(1, 0)`（隐式）        | `safe_divide(1, 0, raise)`  |
| 安装处理器   | `given(raise) := handler`          | `raise := handler`          |
| 处理器绑定   | `(given(raise) : Raise) = handler` | `(raise : Raise) = handler` |
| 中断续延     | `escape(value)`                    | `unwind(value)`             |
| 恢复续延     | `return(value)`                    | `return(value)`             |
| 效应行       | `forall(...(E))`                   | `forall(E : Struct)`        |
| 效应多态参数 | `using(...(E))`                    | `e : E`                     |
| 效应捆绑     | `using(raise, log)`                | `{ raise, log }`            |

## 效应着色

效应通过常规参数声明。没有隐式着色 — 每个参数在每个调用点都是显式的。

## 结构体效应记录

效应可以组织到结构体记录中：

```rust
Logger :: struct(
  info : (fn(msg : String) -> unit),
  warn : (fn(msg : String) -> unit)
);

my_logger := Logger(
  info : (msg) -> { println(msg); },
  warn : (msg) -> { println("WARNING: " + msg); unwind(()); }
);
```

## 语义

- 效应处理器是作为参数传递的常规函数值。
- `unwind(value)` 在任何函数体中有效 — 编译器通过体分析自动检测处理器函数。
- 续延是**一次性**的 — `return` 最多可调用一次。
- 处理器函数不能捕获外部运行时变量（C 代码生成限制）。
- `...(E)` 效应行展开被 `E : Struct` 取代（forall 泛型约束）。

### 处理器安装点

处理器的调用点是**安装点** — `unwind` 跳回的函数帧。编译器通过数据流判定安装与传播：

| 绑定的来源                                       | 处理     |
| ------------------------------------------------ | -------- |
| 当前 begin-block 帧内的本地定义 (`raise := ...`) | **安装** |
| 函数参数                                         | 传播     |
| 闭包捕获的外层处理器                             | 传播     |
| 重新绑定 (`r2 := r1`) — 取最内层绑定             | **安装** |

### 处理器值的逃逸限制

函数值的体中包含 `unwind` 时，它**栈绑定**于安装帧，不允许超过该帧的生命周期。编译器拒绝：

- 从函数中 `return(handler)`
- 将处理器存入堆分配值（`Box`、`Rc` 等）
- 模块层级绑定处理器
- 闭包捕获处理器后闭包可能超过安装帧生命周期

这些约束取代了旧的 `isInsideGivenHandler` 门槛。基于数据流 — 每个计算出控制函数值的表达式带有 `originFrameId` 标签，在逃逸点检查。

## 代码生成

证据传递与隐式模型保持不变。
