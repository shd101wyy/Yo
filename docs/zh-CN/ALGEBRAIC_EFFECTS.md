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

```rust
effects := { raise, log };

fut := io.async((e : typeof(effects)) => {
  e.raise("err");
  e.log("hello");
});

result := io.await(fut, effects);
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

## 代码生成

证据传递与隐式模型保持不变。
