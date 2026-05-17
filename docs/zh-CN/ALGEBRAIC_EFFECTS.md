# 代数效应与处理器（Algebraic Effects and Handlers）

## 概述

Yo 支持**代数效应**——一种隐式参数传递和一次性 delimited continuation 的机制。该系统基于两个特性：

1. **隐式参数（`using` / `given`）** —— 上下文参数传递，静态解析并在运行时传递
2. **效应处理器（`return` / `unwind`）** —— 用于控制流效应的一次性 delimited continuations

代码生成策略是**证据传递（evidence passing）**——效应处理器函数指针作为额外的 C 参数传递，遵循 [Generalized Evidence Passing for Effect Handlers (Xie et al., 2021)](https://xnning.github.io/papers/multip.pdf) 中描述的方法。所有效应类型都以此方式处理，包括 forall 效应（作为 `void*` 传递，并在每个调用点转换为带类型的函数指针）。

## 设计原则

| 原则                     | 决策                         | 理由                                                                     |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| 显式优于隐式             | **使用 `given`**             | 显式标记避免歧义，更好的错误消息，遵循 Scala 3 先例                      |
| 证据传递                 | **总是**                     | 函数指针参数消除了状态机开销；Koka 风格的标志传播用于 unwind             |
| Forall 效应              | **void\* 转换**              | `forall` 函数指针作为 `void*` 传递，并在每个调用点转换为带类型的函数指针 |
| 一次性 continuations     | **一次性**                   | 符合 RC 模型，实现更简单，覆盖 99% 的使用场景，`resume` 是线性的         |
| 静态分发                 | **Impl（静态）**             | 处理器在词法作用域内，编译器知道类型，零开销                             |
| `return`/`unwind` 关键字 | **一次性（由语法强制执行）** | `return` 和 `unwind` 必须是最后一个表达式——只能出现一次                  |

---

## 隐式参数（`using` / `given`）

### 语法

```rust
// 声明带有隐式参数的函数
add_numbers :: (fn(
  x : i32,
  y : i32,
  using(add_fn : (fn(a : i32, b : i32) -> i32))
) -> i32)(
  add_fn(x, y)
);

// 使用 `given` 提供隐式值（:= 形式）
given(my_add) := (fn(x : i32, y : i32) -> i32)(
  x + y
);

{
  // 替代的 `given` 形式，使用 `:` 绑定
  (given(my_add2) : (fn(x : i32, y : i32) -> i32)) =
    (x, y) -> (x + y)
  ;

  // 调用——隐式参数自动解析
  result := add_numbers(3, 4);  // 解析 add_fn = my_add2

  // 调用——显式的上下文参数
  result2 := add_numbers(5, 6, using(my_add));
};

// 调用——显式的上下文参数
result3 := add_numbers(5, 6, using(my_add));

// 调用——明确跳过提供的上下文参数并回退到 `given` 查找
result4 := add_numbers(7, 8, using(undefined));
```

### 语义

- 函数签名中的 `using(name : Type)` 将参数标记为**隐式**。
- 在调用点，调用者可以省略隐式参数。编译器通过搜索环境中类型匹配的 `given` 绑定来解析它们。
- 调用者也可以通过 `using(...)` 显式提供隐式参数：`add_numbers(3, 4, using(my_custom_add))`。
- 调用点的 `using(undefined)` 表示：跳过此上下文槽的显式值并回退到 `given` 查找。
- `given` 绑定是词法作用域的运行时证据值：
  - 需要恰好一个兼容的 `given`，
  - 零匹配 => 编译时错误，
  - 多个匹配 => 编译时歧义错误（必须使用显式 `using(...)` 消除歧义）。
- 函数类型证据通过**结构类型匹配**解析（函数签名必须匹配），而不是按名称。结构体效应记录是名义类型：请定义一个具名 `struct(...)` 类型，并在所有使用点导入同一个类型。
- 函数签名只允许一个 `using(...)` 子句；调用只允许一个 `using(...)` 参数表达式。
- 内部作用域的 `given` 遮蔽外部作用域的同类型 `given`；歧义仅针对同一帧的冲突。

### 测试

参见 `tests/fn.test.yo`（"Test contextual parameters (using/given)"）了解以下示例：

- 基本隐式查找
- 调用点的显式 `using(...)`
- `using(undefined)` 回退
- 多个隐式参数
- 歧义的 `given` 错误
- 没有匹配的 `given` 错误
- `forall + using` 推断

---

## 效应处理器（`return` + `unwind`）

### 语法

```rust
// 定义一个效应操作（支持多参数）
Raise :: (fn(msg : String, msg2 : String) -> i32);

// 在函数中使用效应（效应成为隐式参数）
safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
  cond(
    (y == 0) => raise(`div-by-zero`, `I don't like it`),
    true => (x / y)
  )
);

// 处理效应——不带 resume（通过 `unwind` 丢弃 continuation）
raise_const :: (fn() -> i64)({
  (given(raise) : Raise) = ((msg, msg2) -> {
    println(msg);
    println(msg2);
    unwind(i64(42)); // unwind 用此值从 enclosing 函数返回
  });
  (i64(8) + i64(safe_divide(1, 0))) + i64(10)
});
// 返回 42 —— continuation 被丢弃

// 处理效应——带 resume（通过 `return` 调用 continuation）
raise_resume :: (fn() -> i64)({
  (given(raise) : Raise) = (fn(msg : String, msg2 : String) -> i32)({
    println(msg);
    println(msg2);
    return(i32(42)); // return(value) 用值恢复 continuation
  });
  (i64(8) + i64(safe_divide(1, 0))) + i64(10)
});
// 返回 60 —— return(42) 在 raise 调用点之后继续
```

### 语义

- 效应操作类型是一个普通的 `fn` 类型，其处理器体使用 `unwind` 或 `return` 来控制 continuation（编译器自动检测）。
- 当调用效应操作时，处理器函数通过函数指针参数直接调用。
- 处理器体接收效应的参数（例如，`msg`、`msg2`）。
- 在处理器体内：
  - **`return(value)`** —— 用 `value` 作为效应调用的结果恢复捕获的 continuation。
  - **`unwind(expr)`** —— 完全丢弃 continuation 并用 `expr` 从安装处理器的 enclosing 函数返回。
- 两种处理器形式：
  - **匿名函数处理器**（无 resume）：`(given(raise) : Raise) = ((msg, msg2) -> { unwind(expr); });`
  - **fn-typed 处理器**（带 resume）：`(given(raise) : Raise) = (fn(msg : String, msg2 : String) -> i32)({ return(value); });`
- Continuations 是**一次性**的——`return` 最多只能调用一次（语法上强制为最后一个表达式；运行时双重 resume 检查已计划但尚未实现）。
- 效应操作与 `using` 组合——效应是通过 `given` 解析的隐式参数。
- **异步上下文中的 unwind**：当在 `io.async` 任务中调用 `unwind` 时，Future 被标记为**已中止**（state = -2）。尝试对已中止的 Future 进行 `io.await` 或 `io.spawn` 会导致运行时**panic**。详见 [ASYNC_AWAIT.md](./ASYNC_AWAIT.md#aborted-futures)。

### 效应着色/传播（Effect Coloring / Propagation）

函数通过它们使用的效应被"着色"：

```rust
safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(...);

// 任何调用 safe_divide 的函数必须要么：
// 1. 处理效应（提供 `given(raise)`）
// 2. 传播它（在其自己的签名中添加 `using(raise : Raise)`）

// 选项 1：处理
handler :: (fn() -> i32)({
  given(raise) : Raise = ...;
  safe_divide(10, 0)
});

// 选项 2：传播
wrapper :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
  safe_divide(x, y)
);
```

带有使用 `unwind` 的函数类型的 `using` 参数是函数是否可能因效应而挂起的**唯一标记**：

| 签名                                       | 角色                             | 代码生成策略            | 调用者需要转换？               |
| ------------------------------------------ | -------------------------------- | ----------------------- | ------------------------------ |
| `fn(..., using(raise : Raise)) -> T`       | **传播**效应                     | 证据传递（fn ptr 参数） | 仅当它们也通过 `using` 传播时  |
| `fn() -> T`（通过 `given` 在内部处理效应） | **处理**效应                     | 处理器站点的证据传递    | **否**——调用者看到一个普通函数 |
| `fn(using(f : (fn() -> i32))) -> T`        | 隐式参数（普通 `fn`，无 unwind） | 否——普通参数            | 否                             |

处理器是边界。通过证据传递，中间函数简单地转发 fn ptr 参数——不需要状态机转换。

### 证据传递如何工作（简介）

通过证据传递，效应处理器函数作为**额外的 C 参数**（函数指针）传递。不需要状态机：

1. **效应调用**（调用 `raise(...)`）= 通过证据参数的 fn ptr 调用
2. **`return(value)`** = 处理器函数正常返回；调用者使用该值
3. **`escape(expr)`** = 处理器函数设置 `__yo_effect_escaped = 1`，将值存储在线程本地 `__yo_unwind_value`，返回 dummy；调用者检查标志并传播

调用链中的中间函数简单地转发 fn ptr 参数：

```
handler scope (given(raise) : Raise = handler_fn)
  +-- fn_a(..., raise_ptr)         <-- 将 fn ptr 转发给 fn_b
       +-- fn_b(..., raise_ptr)    <-- 将 fn ptr 转发给 raise 调用
            +-- raise_ptr(msg)     <-- 直接 fn ptr 调用
```

详见 [代码生成：两种策略](#代码生成两种策略) 了解完整细节。

### 效应多态性（`...(E)` Row Spreads）

效应行变量用 `...(Name)` 在 `forall` 内声明。命名的行允许**独立的效应集**（像 Koka 的 `e1 e2`）。

```rust
// 单个命名效应行变量 E
run :: (fn(forall(T : Type, ...(E)),
    f : (fn(using(...(E))) -> T),
    using(...(E))) -> T)(f());

// 两个独立的效应行 E1、E2
some_func :: (fn(forall(T : Type, U : Type, ...(E1), ...(E2)),
    xs : List(T),
    f1 : (fn(a : T, using(...(E1))) -> U),
    f2 : (fn(a : T, using(...(E2))) -> U),
    using(...(E1), ...(E2))) -> List(U));
```

**带闭包的效应行展开**——`...(E)` 展开也与闭包（`Impl(Fn(...))`）一起工作，并支持两种声明闭包效应的风格：

```rust
Yield :: (fn(v : i32) -> i32);
Log :: (fn(v : i32) -> unit);

// traverse 对回调需要的 ANY 效应集 E 是多态的
traverse :: (fn(
  forall(S : usize, ...(E)),
  arr : Array(i32, S),
  callback : (Impl(Fn(v : i32, using(...(E))) -> unit)),
  using(...(E))
  ) -> unit)({
    i := usize(0);
    while((i < S), {
      callback(arr(i));
      i = (i + 1);
    });
  });

// 设置处理器
(given(yield) : Yield) = (v) -> { return(v); };
(given(log)   : Log)   = (v) -> { println(v); };

arr := Array(i32, 5)(0, 1, 2, 3, 4);

// 风格 1：内联类型声明——闭包用类型声明效应行。
// 不需要调用站点的 using()；E 从闭包的声明推断。
traverse(arr, (v, using(yield : Yield, log : Log)) => {
  log(v);
  result := yield(v);
  assert((result == v), "yield should return the value");
});

// 风格 2：调用站点解析——E 从调用站点的 using(yield, log) 解析，
// 闭包用 using(_yield, _log) 重命名它们。
traverse(arr, (v, using(_yield, _log)) => {
  _log(v);
  result := _yield(v);
  assert((result == v), "yield should return the value");
}, using(yield, log));
```

在闭包和调用站点级别，效应直接在 `using()` 中列出，没有 `...(...)` 包装器。`...(E)` 语法仅在函数类型定义中使用，其中 `E` 是 forall-声明的效应行变量。

如果闭包和调用站点都声明效应，类型必须匹配，否则编译器报告错误。

语义：

- `forall(...)` 中的 `...(E)` **将 E 声明为效应行变量**——遍历隐式参数集。
- 函数类型定义中 `using(...)` 的 `...(E)` **展开**效应行的绑定参数到隐式参数。
- 在闭包/调用站点级别，效应直接列出：`using(yield, log)` 或 `using(yield : Yield, log : Log)`。
- 类型统一：调用 `run(might_fail)`，其中 `might_fail : fn(using(raise : Raise)) -> i32` 统一 `T = i32`、`E = (raise : Raise)`。
- 两行：`...(E1)` 和 `...(E2)` 从各自的函数参数独立推断；`using(...(E1), ...(E2))` 是它们的并集。

类型兼容规则：

| 期望                                | 给定                              | 兼容？                            |
| ----------------------------------- | --------------------------------- | --------------------------------- |
| `fn(using(...(E))) -> T`            | `fn(using(raise : Raise)) -> i32` | ✅ E = `(raise : Raise)`，T = i32 |
| `fn(using(...(E))) -> T`            | `fn() -> i32`                     | ✅ E = 空，T = i32                |
| `fn(using(r : Raise, ...(E))) -> T` | `fn(using(r : Raise)) -> i32`     | ✅ 命名参数匹配，E = 空           |
| `fn(using(r : Raise)) -> T`         | `fn(using(l : Log)) -> i32`       | ❌ 命名参数不匹配                 |

### 命名的效应实例（Named Effect Instances）

通过调用站点的显式 `using(...)` 支持同一效应类型的多个实例：

```rust
Logger :: (fn(msg : String) -> unit);

program :: (fn(using(info : Logger, error : Logger)) -> unit)({
  info("starting");
  error("something went wrong");
});

program(using(info_logger, error_logger));
```

不需要特殊的语言支持——这来自现有的 `using`/`given` 机制。

### 基于结构体的效应记录（Struct-Based Effect Records）

可以使用具名 `struct(...)` 记录组织效应。这对于分组相关的效应操作特别有用：

```rust
MyException :: (fn(comptime(ErrorType) : Type) -> comptime(Type))(
  struct(
    throw : (fn(forall(ResumeType : Type), error : ErrorType, resume_value : ResumeType) -> ResumeType)
  )
);

safe_divide :: (fn(x : i32, y : i32, using(exn : MyException(i32))) -> i32)(
  cond(
    (y == 0) => exn.throw(x, i32(0)),
    true => (x / y)
  )
);

// 用 `given` 安装基于结构体记录的处理器：
given(exn) := MyException(i32)(
  throw : ((val, resume_val) -> {
    return(resume_val);  // 用提供的恢复值 resume
  })
);

result := safe_divide(10, 0);  // 处理器用 0 resume
```

结构体效应记录支持：

- **`forall` 参数**在效应操作中（例如，`forall(ResumeType : Type)`）
- **嵌套结构体**——包含其他效应结构体记录的结构体
- **带标签的 `using(name : EffectStruct)`** —— 将结构体字段自动解构为隐式参数

### 带效应的控制流

效应与循环内的所有控制流结构正确交互：

```rust
GetValue :: (fn() -> i32);

(given(get_value) : GetValue) = (() -> {
  return(i32(1));
});

// break、continue 和提前返回在效应 resume 后都工作
while(runtime(true), {
  result := get_value();  // 效应调用（挂起点）

  cond(
    (result > 10) => { break; },        // 效应 resume 后 break
    (result == 0) => { continue; },     // 效应 resume 后 continue
    true => ()
  );
});
```

效应也与 tagged union `match` arms 一起工作：

```rust
while(runtime(true), {
  get_value();  // 效应调用

  opt := Option(i32).Some(counter.*);

  val := match(opt,
    .Some(v) => v,
    .None => break    // 效应 resume 后在 match arm 内 break
  );
});
```

### 传递效应传播（Transitive Effect Propagation）

当函数通过 `forall(...(E))` 是效应多态的并包含带控制流的循环时，证据传递在函数体内正确工作：

```rust
Yield :: (fn(v : i32) -> i32);

apply_effect :: (fn(forall(...(E)), n : i32, using(...(E))) -> i32)({
  counter := Box(i32)(0);
  result := Box(i32)(0);

  while(runtime((counter.* < n)), {
    counter.* = (counter.* + 1);
    cond(
      (counter.* > i32(3)) => { break; },
      true => ()
    );
  });

  return(counter.*);
});

(given(yield) : Yield) = ((v) -> { return(v); });
result := apply_effect(i32(10));
```

### 处理器函数不是闭包

效应处理器函数编译为**独立的 C 函数**——它们不是闭包。处理器函数不能引用外部作用域的变量。这是有意设计的：证据传递将处理器转换为显式的函数指针参数，这些必须是 C 中独立可调用的函数。

```rust
// 错误——处理器引用外部变量 `threshold`，编译错误：
threshold := i32(10);
(given(raise) : Raise) = ((msg) -> {
  unwind((threshold * i32(2)));  // ERROR: threshold 不在作用域内
});

// 正确——通过效应函数本身传递状态作为显式参数：
check :: (fn(x : i32, threshold : i32, using(raise : Raise)) -> i32)(
  cond(
    (x > threshold) => raise(`too large`),
    true => x
  )
);
(given(raise) : Raise) = ((msg) -> { unwind(i32(-1)); });
result := check(i32(15), i32(10));
```

如果你需要处理器携带状态，将该状态编码为显式函数参数或存储在处理器外部分配的 `Box` 中。

### 测试

参见 `tests/algebraic_effects.test.yo`（57 个测试）了解全面的同步示例：

| 类别                               | 测试数 |
| ---------------------------------- | ------ |
| 基本 fn-type 效应（unwind/resume） | 4      |
| 直接处理器调用（无 `using`）       | 2      |
| 嵌套处理器                         | 2      |
| while 循环 + 效应                  | 6      |
| 多个 fn-type 效应                  | 1      |
| 效应传播（1 级、2 级、3 级）       | 5      |
| 处理器遮蔽                         | 2      |
| 效应多态性（forall spread）        | 2      |
| Struct 效应记录                    | 6      |
| 多个效应行展开                     | 2      |
| 带效应的闭包                       | 2      |
| 效应行多态性                       | 2      |
| 混合 unwind+return 处理器          | 1      |
| 传递 SM（break/continue/return）   | 5      |
| Struct 记录 forall 处理器          | 5      |
| Option match + 效应                | 3      |
| Struct 记录 non-unit unwind value  | 1      |
| Multi-member struct effect records | 1      |
| Multiple struct records in scope   | 1      |
| Conditional resume/unwind          | 1      |
| Recursive functions + effects      | 2      |
| Effect with enum return type       | 1      |
| Struct record effect polymorphism  | 1      |
| Transitive SM + struct records     | 1      |

参见 `tests/async_await.test.yo`（9 个 async+effects 测试）了解异步集成：

| 场景                                           | 测试数 |
| ---------------------------------------------- | ------ |
| Effect resume inside async closure             | 1      |
| Effect resume across multiple yields           | 1      |
| Two effects injected via `io.await`            | 1      |
| Two effects injected via `io.spawn`            | 1      |
| Effect resume in async while loop              | 1      |
| Effect resume in async while loop with break   | 1      |
| Escape via injected effect aborts future       | 1      |
| JoinHandle unwind via spawn-injected effect    | 1      |
| Given handler inside async closure with yields | 1      |

---

## 与 Async/Await 的关系

| 方面         | Async/Await                    | Algebraic Effects                          |
| ------------ | ------------------------------ | ------------------------------------------ |
| 挂起点       | `io.await(expr)`               | `effect_op(args)`（fn ptr 调用）           |
| 谁 resume    | Event loop（IO completion）    | Handler（calling `return`）                |
| 代码生成     | State machine（always）        | Evidence passing（always）                 |
| Continuation | Implicit（event loop manages） | Explicit（`return` / `unwind` in handler） |
| Thread model | Single-threaded event loop     | Synchronous（same thread）                 |
| Use cases    | IO concurrency                 | Control flow abstraction, error handling   |

Async/await 使用状态机基础设施（`src/codegen/shared/suspension-analysis.ts`、`src/codegen/shared/suspension-codegen.ts`）。代数效应不使用状态机——它们仅使用证据传递。详见 [ASYNC_AWAIT.md](./ASYNC_AWAIT.md) 了解 async/await 文档。

---

## 代码生成：证据传递（Evidence Passing）

编译器使用**证据传递**为效应处理器生成 C 代码——效应处理器函数指针作为额外的 C 参数传递。

**何时**：所有效应类型——基于结构体的效应记录、裸函数类型效应、效应行展开（`...(E)`）和 forall 效应（通过 `void*` 参数转换）。

**如何**：效应处理器函数指针作为额外的 C 参数传递。有效应的函数直接通过 fn ptr 调用处理器，并在此之后检查 `__yo_effect_escaped` 标志。基于 [Generalized Evidence Passing for Effect Handlers (Xie et al., 2021)](https://xnning.github.io/papers/multip.pdf)。

---

## 证据传递（策略 1）——详细

证据传递将效应处理器编译为**普通的 C 函数指针参数**。这完全消除了有效应函数的状态机——它变成一个带有额外参数的普通 C 函数。

### 关键原则：效应 ≡ 函数指针

在运行时，所有效应都简化为函数指针。结构体效应记录是证据记录——在 C 级别，每个函数字段变成单独的 fn ptr 参数：

- `using(exn : Exception)` where `Exception :: struct(throw : fn(...))` → 传递 `throw` 函数指针
- `using(raise : Raise)` where `Raise :: struct(raise : fn(msg : String) -> i32)` → 传递 `raise` 函数指针
- `using(raise : (fn(msg : String) -> i32))` → 直接将 `raise` 作为 fn ptr 参数传递
- `using(...(E))` effect row spread → 在特化时展开为具体的 fn ptr 参数

### 生成的 C

对于带有结构体效应记录的函数：

```rust
safe_divide :: (fn(x : i32, y : i32, using(exn : Exception)) -> i32)(
  cond((y == 0) => exn.throw(Error.new(`div by zero`)), true => (x / y))
);
```

编译器生成：

```c
// Evidence parameter: throw fn ptr passed as void* (forall func)
// or typed fn ptr (non-forall func)
int32_t safe_divide(int32_t x, int32_t y, void* exn__throw) {
  if (y == 0) {
    __yo_effect_escaped = 0;
    int32_t result = ((int32_t(*)(AnyError*))exn__throw)(error_obj);
    if (__yo_effect_escaped) {
      return 0;  // dummy — caller propagates unwind
    }
    return result;  // handler resumed with this value
  }
  return x / y;
}
```

### Evidence argument resolution

在每个调用点，编译器按此顺序解析证据参数：

1. **传递转发**——如果调用者有匹配的证据参数，直接转发它们
2. **从效应分析**——如果调用点有处理器（带有 handler info 的 `given` 绑定），使用处理器的 C 函数地址
3. **从 `given` 绑定**——在调用环境中查找结构体证据值，提取函数字段，并使用其 C 名称
4. **从异步 SM 捕获**——如果在异步状态机内，从 `sm->__capture.fieldName` 解析

### Escape handling

当处理器调用 `unwind`：

1. 处理器函数设置 `__yo_effect_escaped = 1` 并返回 dummy 值
2. 调用者在 fn ptr 调用后检查 `if (__yo_effect_escaped)`
3. 如果设置：丢弃 RC-typed 参数，然后要么：
   - **在同步上下文**：用零值从 enclosing 函数返回
   - **在异步 SM 上下文**：设置 `sm->state = -2`（aborted），通过 `memset`+dispose 丢弃 SM 局部变量，如果存在则启动 continuation，并返回

### Resume handling

当处理器调用 `return(value)`：

1. 处理器函数正常返回 `value`（不设置 `__yo_effect_escaped`）
2. 调用者从 fn ptr 调用接收返回值
3. `if (__yo_effect_escaped)` 检查通过（标志为 0）
4. 调用者将返回值用作效应调用的结果

这是最简单的路径——没有状态机，没有 yield/resume 协议。处理器只是一个函数调用。

### Mixed unwind+return handlers

一个处理器可以在一个分支中 `return`，在另一个分支中 `unwind`：

```rust
given(raise_mod) := Raise(
  raise : (msg) -> cond(
    (msg == `recoverable`) => return(i32(0)), // resume with 0
    true => unwind(i32(-1))                   // unwind with -1
  )
);
```

两条路径都正确工作：

- **Return path**：fn ptr 正常返回；`__yo_effect_escaped` 保持 0；调用者使用 resume 值
- **Escape path**：fn ptr 设置 `__yo_effect_escaped = 1` 并返回 dummy；调用者检查并传播

### Forall evidence specialization

当效应操作有 `forall` 参数（例如，`throw :: (fn(forall(T : Type), msg : str, resume_val : T) -> T)`），C 不能直接表示函数指针，因为 C 没有参数多态性。证据传递通过**`void*` 转换**处理这个：

1. **Evidence parameter type**：forall 函数的证据参数是 `void*`（不透明指针）
2. **Handler passed as `void*`**：在处理器安装站点，特化的处理器转换为 `void*`：`(void*)handler_specialized_cname`
3. **Cast at call site**：每个调用点将 `void*` 转换回需要的具体函数指针类型：`((int32_t(*)(char*, int32_t))evidence_ptr)(msg, resume_val)`
4. **Specialization**：评估器通过 `evaluateCtlFunctionBodyInline` 创建特化的处理器版本，它产生特化的函数体和带有 forall 参数替换的 `specializedType`
5. **Collection**：特化的处理器版本（存储在 `specializedFunctionCaches`）与原始处理器一起在 `collection.ts` 中收集

**示例——带 resume 的 forall 效应：**

```rust
Throw :: (fn(forall(T : Type), msg : str, resume_val : T) -> T);

safe_divide :: (fn(x : i32, y : i32, using(throw : Throw)) -> i32)(
  cond((y == 0) => throw(`div by zero`, 0), true => (x / y))
);
```

生成的 C：

```c
// Evidence param is void* (forall fn ptr)
int32_t safe_divide(int32_t x, int32_t y, void* throw) {
  if (y == 0) {
    __yo_effect_escaped = 0;
    // Cast void* to concrete fn ptr type at call site
    int32_t result = ((int32_t(*)(__yo_string, int32_t))throw)(msg, 0);
    if (__yo_effect_escaped) return 0;
    return result;
  }
  return x / y;
}
```

**Forall-only fallback condition**：当函数有剥离隐式参数的 `specializedType` 时，编译器仅在它们包含 forall 函数类型（`ep.fieldFunctionType.forallParameters.length > 0`）时回退到原始类型的证据参数。非-forall `using` 参数（上下文参数）在特化时解析，不需要证据传递。

**Additional behaviors：**

- **Handler doesn't use the forall type**（例如，`unwind()`）：生成未特化的函数并直接传递
- **Transitive forwarding**：`void*` 证据在调用者和被调用者之间原样转发

### Escape value propagation

Escape values（包括非-unit 值）通过线程本地 `__yo_escape_value` 机制传播。当在处理器内调用 `unwind(expr)` 时，unwind 值存储在线程本地，并可以在处理器安装站点（`given`）检索。

---

## Overhead Analysis

### Per-Call-Site Overhead (Happy Path — No Escape)

每个效应调用点恰好添加三个操作：

| Operation                          | Cost    | Notes                                                       |
| ---------------------------------- | ------- | ----------------------------------------------------------- |
| `__yo_effect_escaped = 0` (reset)  | ~1-2 ns | Thread-local store                                          |
| Indirect call via fn ptr           | ~2-5 ns | vs ~1 ns for direct call; well-predicted after warm-up      |
| `if (__yo_effect_escaped)` (check) | ~1-2 ns | Thread-local load + branch (always not-taken on happy path) |

**Total happy-path overhead: ~4-9 ns per effect call site.**

Escape 分支在 happy path 上从未被采用，所以 CPU 分支预测器很快学会这个，检查摊销到接近零。

### Per-Call-Site Overhead (Escape Path)

当 unwind 发生时：

| Step                                              | Cost               |
| ------------------------------------------------- | ------------------ |
| Handler sets `__yo_effect_escaped = 1`            | ~1 ns              |
| Handler stores value via `memcpy` (≤64 bytes)     | ~5-20 ns           |
| Each transitive caller checks flag + drops locals | ~5-10 ns per level |
| Installation site extracts value via `memcpy`     | ~5-20 ns           |

**Total: ~15-50 ns + ~5-10 ns per transitive call level.**

Escape 是异常路径，替换了否则会是 `longjmp`、`throw` 或等效机制的东西。

### Extra C Parameters

函数签名中的每个 `using(name : EffectType)` 添加：

- **Function-type effect**：1 个指针参数（x86-64/ARM64 上 8 字节）
- **结构体记录效应**：每个效应记录成员函数 1 个指针
- **Nested struct effect record**：展平——每个叶函数 1 个指针

参数在寄存器中传递（x86-64 SysV 最多 6 个，ARM64 上 8 个），所以大多数单效应函数支付零栈开销。

### Thread-Local Storage

两个线程本地变量全局使用：

```c
static _Thread_local int __yo_effect_escaped = 0;                     // 4 bytes
static _Thread_local _Alignas(16) char __yo_unwind_value[64];  // 64 bytes
```

TLS access latency by platform:

- **Linux (ELF)**: `%fs`-relative — 1 instruction, ~1 ns
- **macOS (Mach-O)**: `__thread` — ~2-3 ns
- **Windows**: `__declspec(thread)` — ~1-2 ns

不需要锁或原子操作——效应是单线程的（在事件循环任务内）。

### Code Size per Call Site

| Component                        | Size             |
| -------------------------------- | ---------------- |
| Flag reset instruction           | ~4-8 bytes       |
| Flag check + conditional branch  | ~8-12 bytes      |
| Escape cleanup block (cold path) | ~20-50 bytes     |
| **Total per call site**          | **~30-70 bytes** |

### Comparison with Alternatives

| Approach                  | Happy-path overhead          | Escape/throw overhead | Code size         | Async-safe |
| ------------------------- | ---------------------------- | --------------------- | ----------------- | ---------- |
| **Evidence passing (Yo)** | ~4-9 ns per call site        | ~15-50 ns             | +30-70 B/site     | ✅ Yes     |
| `setjmp`/`longjmp`        | ~5-15 ns at handler install¹ | ~5-15 ns (longjmp)    | +20-40 B/site     | ❌ No      |
| C++ zero-cost exceptions  | ~0 ns                        | ~1000-5000 ns         | Large `.eh_frame` | ❌ No      |
| Koka evidence vectors     | ~3-5 ns per call site        | ~10-30 ns             | Similar           | ✅ Yes     |
| OCaml 5 fibers            | ~0 ns (native)               | ~50-200 ns            | Runtime overhead  | ✅ Yes     |

¹ `setjmp` always pays its setup cost (~5-15 ns) at the handler installation point even when no unwind ever occurs.

**Happy path** —— Evidence passing wins: it pays ~4-9 ns only at actual effect call sites, with zero cost at handler installation. `setjmp` always pays ~5-15 ns at installation regardless of whether effects fire.

**Escape path** — `longjmp` (~5-15 ns) is faster than evidence passing (~15-50 ns) for a single unwind. The tradeoff: evidence passing supports async-safe composability and doesn't prevent compiler optimizations around the protected region, while `setjmp`/`longjmp` disables many optimizations.

**Amortized** — When effects are called N times per `given` installation, evidence passing total cost is `N × 4-9 ns`, vs `setjmp` total is `5-15 ns + escape_count × 5-15 ns`. For N > ~2 effect calls with no escapes, evidence passing is cheaper overall.

---

## Reference

- [Generalized Evidence Passing for Effect Handlers](https://xnning.github.io/papers/multip.pdf)
