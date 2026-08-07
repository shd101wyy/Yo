# 代数效应与处理器

## 概述

Yo 支持**代数效应** — 一次性定界续延（one-shot delimited
continuations）。效应是常规函数参数，其处理器体可使用
`unwind(value)` 丢弃续延，或 `return(value)` 恢复续延。

代码生成策略为**证据传递**（evidence passing）— 处理器函数指针作为
额外的 C 参数传递。

## 设计

| 原则       | 决策                                         |
| ---------- | -------------------------------------------- |
| 显式参数   | 每个函数参数在每次调用时都显式传递           |
| 证据传递   | 处理器函数指针作为 C 参数                    |
| 一次性续延 | `return` 恢复，`unwind` 丢弃                 |
| 处理器类型 | `ctl(args) -> ret` 与 `fn(args) -> ret` 并列 |
| 逃逸纪律   | 类型层检查（`typeIsControlBound`）           |
| 效应多态   | `generic(E : Type.Struct)` + `e : E`         |
| 效应捆绑   | 匿名结构体 `{ raise, log }` 或具名结构体类型 |

## 语法

### 声明与使用效应

处理器是**控制函数**，记作 `ctl(args) -> ret`：

```rust
// 声明处理器类型
Raise :: (ctl(msg : String) -> i32);

// 把处理器作为常规参数的函数
safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(
  cond(
    (y == 0) => raise(`div-by-zero`),
    true => (x / y)
  )
);

// 安装处理器 — 类型已注解为 ctl，函数体可用 `unwind`。
// 注意：Yo 没有运算符优先级，等号右边的 lambda 需要额外的括号。
(raise : Raise) = ((msg) -> { unwind(i32(42)); });

// 调用点 — 显式传参
result := safe_divide(1, 0, raise);
```

### 续延控制

- **`unwind(value)`** — 丢弃续延，以 `value` 从所在函数返回。
- **`return(value)`** — 以 `value` 在效应调用处恢复续延。

```rust
Raise :: (ctl(msg : String) -> i32);

// Unwind 处理器：丢弃续延。所在函数最终以 i64(42) 返回。
(raise : Raise) = (
  (msg) -> {
    println(msg);
    unwind(i64(42));
  }
);

// Resume 处理器：继续执行效应调用之后的代码，效应调用处的结果是 i32(0)。
(raise : Raise) = (
  (msg) -> {
    println(msg);
    return(i32(0));
  }
);
```

### 效应传播

函数通过把效应作为参数并转发给被调用者来传播效应。**仅仅转发**
`ctl` 参数的函数自身**不必**是 `ctl` — unwind 跳回的目标是处理器
的安装帧，位于这一层之上。

```rust
// `wrapper` 是普通 fn，即使它转发了 ctl 处理器。
wrapper :: (fn(x : i32, raise : Raise) -> i32)(
  safe_divide(x, 0, raise)
);
```

#### 安装点 vs 传播点

`unwind` 跳回的是**处理器被本地绑定**的帧 — 这就是安装点。如果当前
函数是通过参数拿到处理器的，那它就是**传播点**：unwind 会越过它，
继续往上传播，直到到达真正的安装帧。Yo 完全按照绑定所在的帧来判定：

| 处理器值的来源                           | 站点   |
| ---------------------------------------- | ------ |
| 当前函数体内 `(raise : Raise) = …`       | 安装点 |
| `r2 := r`，且 `r` 本身就是本地绑定       | 安装点 |
| `record.handler`，且 `record` 是本地绑定 | 安装点 |
| 当前函数的参数 `raise : Raise`           | 传播点 |
| 来自外层作用域的捕获值                   | 传播点 |
| `record.handler`，且 `record` 是参数     | 传播点 |

重新绑定（`r2 := r`）**不会**改变安装点 — 只有最内层那次绑定所在的
帧才是决定因素。这正是为什么中间层函数可以保持为普通 `fn`，让一个
顶层安装的处理器能够穿过任意多层转发。

### 效应行多态

效应多态函数使用 `generic(E : Type.Struct)`。约束 `Type.Struct` 把
`E` 限定为结构体类型（一个效应捆绑），并在特化时启用结构体函数
指针字段自动展开为独立 C 参数。

```rust
run :: (
  fn(generic(T : Type, E : Type.Struct),
     f : (fn(e : E) -> T),
     e : E
  ) -> T
)(f(e));

effects := { raise : my_raise, log : my_log };
result := run(might_fail, effects);
```

无效应 → 空结构体 `{}`：

```rust
result := run(pure_func, {});
```

### 异步 + 效应

`Future` 由返回类型和零个或多个效应类型参数构成。每个效应参数应当
本身是结构体类型（或绑定到结构体的 generic E），调用方传入含实际
处理器的结构体值：

```rust
// 单个捆绑（最常见）
fut1 : Impl(Future(i32, IoExn));            // IoExn = { io, exn }
y := io.await(fut1, { io, exn });

// 单效应 future — 直接传递效应值
fut2 : Impl(Future(i32, Io));
x := io.await(fut2, io);
```

传给 `io.async` 的闭包必须显式标注 `e` 的类型 — 推断器无法从孤立
的闭包字面量推出 `E`。顶层调用点用 `typeof(effects)`；位于带返回
类型注解的函数体内时，可省略闭包参数注解：

```rust
effects := { raise, log };

// 顶层：用 typeof(effects) 标注 e
fut := io.async((e : typeof(effects)) => {
  e.raise(`err`);
  e.log(`hello`);
});

result := io.await(fut, effects);
```

```rust
// 函数体内、返回类型已标注 — E 由返回类型固定，闭包参数可不标注：
do_work :: (fn(io : Io) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    e.io.await(some_io_call(...), e.io);
    e.exn.throw(...);
  })
);
```

宽度匹配是**严格**的 — Yo 的结构体是名义类型。如果调用方持有
`e : IoExn` 但嵌套 future 只需要 `Io`，必须显式投影：

```rust
// fut 需要 Io；投影到 e.io
result := io.await(fut, e.io);
```

## 控制函数的类型规则

`ctl(args) -> ret` 值是**控制函数** — 其体可包含 `unwind`，其值
绑定到本地安装的栈帧。

1. **`unwind` 的位置。** `unwind(value)` 仅在 `ctl(...) -> ret` 体
   内合法。`fn(...) -> ret` 体内含 `unwind` 是类型错误。

2. **行内 lambda 注解。** 行内 lambda 体含 `unwind` 时，必须由绑定
   的 LHS 类型或 lambda 显式注解为 `ctl(...)`。不会从体内容反推。

3. **闭包不能是控制函数。** 闭包体（捕获外层变量、语法为 `=>`）
   不能含 `unwind`。处理器必须是无捕获的匿名函数。

4. **闭包不能捕获控制绑定值。** 即便闭包体中没有 `unwind`，捕获
   `ctl` 类型的值（或其类型传递性含 `ctl` 的值）也会被拒绝 —
   闭包可能逃出当前帧，把处理器带走。

5. **子类型 `fn <: ctl`**（协变）。普通 `fn(T) -> R` 可赋给
   `ctl(T) -> R` 的位置 — 非 unwind 函数在允许 unwind 的地方使用
   是合法的。反向不安全，会被拒绝。

6. **跨函数种类的泛型。** `generic(T : Type)` 既可绑定到 `fn(...)`
   也可绑定到 `ctl(...)`；`T` 的使用方式不变。

7. **控制绑定类型。** 一个类型是「控制绑定」的，当且仅当它传递性
   包含 `ctl(...) -> ret`（直接，或作为 struct/tuple/enum/union
   字段、array/slice 元素、指针指向类型）。判定函数：
   `typeIsControlBound(T)`。

8. **逃逸边界。** 控制绑定类型不能作为：

   - **函数返回类型** — 处理器会超过安装帧的生命周期。
   - **模块层级绑定的类型** — 模块作用域比任何调用帧都长。
   - **`Box(T)` / `Rc(T)` 等堆分配的类型参数** — 堆比任何栈帧都长。
   - **闭包捕获的类型**（见规则 4）。
   - **指针指向的类型** — 拒绝 `*(Raise)`，防止处理器通过指针写入
     外层存储。

9. **中间层传播。** 仅转发 `ctl` 参数（或含 `ctl` 的结构体）的
   函数自身**不必**是 `ctl`。unwind 跳回的目标在传播函数之上的
   安装帧。

### 完整示例

```rust
Raise :: (ctl(msg : String) -> i32);

// 调用方在帧 F 安装处理器
do_caller :: (fn() -> i32)({
  (raise : Raise) = (
    (msg) -> {
      println(msg);
      unwind(i32(0));        // unwind 跳回 do_caller 的帧
    }
  );
  // compute 运行于 F 之下；对 raise 的调用 unwind 回到 F
  compute(raise)
});

// 中间层：普通 fn，转发处理器
compute :: (fn(raise : Raise) -> i32)(safe_divide(1, 0, raise));

safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(
  cond((y == 0) => raise(`div-by-zero`), true => (x / y))
);
```

### 不允许的形式

```rust
Raise :: (ctl(msg : String) -> i32);

// ❌ 返回处理器 — 安装帧已死。
make_handler :: (fn() -> Raise)({
  (r : Raise) = ((msg) -> { unwind(i32(0)); });
  r          // 拒绝：返回类型是控制绑定
});

// ❌ 模块层级绑定 — 比任何调用帧都活得长。
top_handler :: (raise : Raise) = ((msg) -> { unwind(i32(0)); });

// ❌ 指向处理器的指针 — 可能通过指针写入外层存储。
P :: *(Raise);  // 拒绝

// ❌ 存入 Box — 堆超过安装帧。
b := Box(Raise).new((msg) -> { unwind(i32(0)); });

// ❌ 闭包捕获处理器 — 闭包可能逃出，带走处理器。
(r : Raise) = ((msg) -> { unwind(i32(0)); });
cb := (() => r(`hi`));  // 闭包捕获 r；拒绝
```

## 裸 `ctl` 类型效应 vs 结构体效应记录

处理器类型既可以是裸 `ctl(...) -> R`，也可以是字段为 `ctl(...) -> R`
的结构体。两种形态都是一等的 — 选哪一种纯粹是 API 形态的问题：

```rust
// 裸 ctl —— 单方法效应。
Raise :: (ctl(msg : String) -> i32);

// 结构体记录 —— 多方法效应。
Exception :: struct(
  throw : (ctl(generic(T : Type), msg : String) -> T)
);
```

经验法则：

- **直接调用的单方法效应**（`raise(msg)`）：用裸 `ctl(...) -> R`，
  更短也读得清楚。适合像 `Raise`、`Log` 这种一次性效应。
- **多方法效应**（`exn.throw(...)`、`logger.warn(...)`）：把处理器
  包在 `struct(...)` 里，让方法共享同一个命名空间，作为一个值一起
  传递。
- **Future 的效应捆绑**（`Future(T, E)`，`generic(E : Type.Struct)`）：
  捆绑本来就是 struct，处理器自然作为字段存在。

两种形态在安装点、逃逸约束和代码生成上的语义完全一致。裸 `ctl`
值就是一个函数类型的参数；结构体的 `ctl` 字段在被访问之后表现也
完全相同。

## 结构体效应记录

效应可以组织为结构体记录。处理器字段使用 `ctl(...)` 类型，结构体
值可通过本地绑定安装它们。常见捆绑（如 `Exception`、`IoExn`）位于
`std/error.yo`：

```rust
Logger :: struct(
  info : (ctl(msg : String) -> unit),
  warn : (ctl(msg : String) -> unit)
);

log_and_check :: (fn(x : i32, logger : Logger) -> i32)({
  logger.info(`checking`);
  cond((x < 0) => logger.warn(`negative`), true => ());
  x
});

(my_logger : Logger) = Logger(
  info : ((msg) -> { println(msg); return(()); }),
  warn : ((msg) -> { println(`WARNING: ${msg}`); unwind(()); })
);

result := log_and_check(42, my_logger);
```

## 语义

- 处理器体在安装帧的栈上运行 — 可以直接访问外层帧的本地变量
  （兄弟处理器、周围的变量）。代码生成通过内联处理器 / 状态机
  线程化实现这一点。
- `return(value)` 是**一次性**的 — 捕获的续延最多恢复一次。
- 处理器类型在类型层通过 `ctl(...)` 强制约束。求值器不会从体内容
  推断 `ctl`；用户必须显式注解。

## 代码生成

证据传递与隐式模型保持不变：

- 处理器函数作为 fn-ptr C 参数传递。
- 效应调用点生成：
  ```c
  __yo_effect_escaped = 0;
  result = (fn_ptr_call)(args);
  if (__yo_effect_escaped) { /* 传播 unwind */ }
  ```
- `unwind` 置 `__yo_effect_escaped = 1` 并把值存入 `__yo_unwind_value`。
- `return` 正常恢复 — 不设置标志。
