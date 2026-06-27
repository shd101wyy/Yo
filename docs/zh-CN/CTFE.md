# 编译期函数求值（CTFE）

Yo 会尽可能地执行**编译期函数求值**（Compile-Time Function Evaluation，CTFE），以提升运行时性能。本文档介绍 Yo 的 CTFE 能力，以及与其他语言的对比。

## 概述

CTFE 允许编译器在所有输入在编译期已知的情况下，于编译期执行函数。其结果会直接嵌入到生成的代码中，从而消除运行时计算开销。

```rust
// 这个函数可以在编译期求值
factorial :: (fn(n : i32) -> i32) {
  result := i32(1);
  i := i32(1);
  while i <= n, {
    result = (result * i);
    i = (i + 1);
  };
  return result;
};

// 编译器在编译期求值 factorial(10)
// 生成的代码中直接包含常量 3628800
value :: factorial(10);
```

## 主要特性

### 1. 自动 CTFE 分析

Yo 会自动分析函数，判断其是否可以在编译期求值。当一个函数的所有参数都在编译期已知时，Yo 会尝试在编译过程中执行它。

```rust
// 无需特殊标注 — Yo 自动检测到
// 这个函数可以在编译期求值
sum_squares :: (fn(n : i32) -> i32) {
  result := i32(0);
  i := i32(1);
  while i <= n, {
    result = (result + (i * i));
    i = (i + 1);
  };
  return result;
};

// 编译期求值: 1 + 4 + 9 + 16 + 25 = 55
total :: sum_squares(5);
```

### 2. 完整的控制流支持

Yo 的 CTFE 支持所有控制流结构：

- **`while` 循环**（支持可变循环变量）
- **`continue`**（跳过本次迭代）
- **`break`**（提前退出循环）
- **`return`**（提前返回函数）
- **`cond`**（条件表达式）
- **`match`**（模式匹配）

```rust
// 示例: 使用 continue 只对奇数求和
sum_odd :: (fn(max : i32) -> i32) {
  result := i32(0);
  i := i32(0);
  while i < max, {
    i = (i + 1);
    cond(
      ((i % 2) == 0) => continue,  // 跳过偶数
      true => {
        result = (result + i);
      }
    );
  };
  return result;
};

// 编译期求值: 1 + 3 + 5 + 7 + 9 = 25
odd_sum :: sum_odd(10);
```

### 3. 一等类型

在 Yo 中类型就是值，这使得强大的编译期类型操作成为可能：

```rust
// 在编译期创建一个泛型容器类型
Container :: (fn(comptime(T) : Type) -> comptime(Type))
  ref(struct(
    value : T
  ))
;

// 类型在编译期计算
IntContainer :: Container(i32);
StringContainer :: Container(String);
```

### 4. 编译期断言

使用 `comptime_assert` 在编译期验证条件：

```rust
fib :: (fn(n : i32) -> i32) {
  cond(
    (n <= 1) => n,
    true => (fib((n - 1)) + fib((n - 2)))
  )
};

// 这些断言在编译期进行检查
comptime_assert(fib(0) == 0);
comptime_assert(fib(1) == 1);
comptime_assert(fib(10) == 55);
```

### 5. 编译期参数

使用 `comptime` 要求参数在编译期已知：

```rust
// T 必须在编译期已知，以便单态化
Array :: (fn(comptime(T) : Type, comptime(N) : usize) -> comptime(Type))
  struct(
    data : [T; N]
  )
;

// 创建一个固定大小的数组类型
IntArray5 :: Array(i32, 5);
```

## 与 Rust 的对比

Yo 的 CTFE 在多个方面比 Rust 的 `const fn` 更灵活：

| 特性                         | Yo                          | Rust                         |
| ---------------------------- | --------------------------- | ---------------------------- |
| 循环中的可变变量             | ✅ 支持                     | ✅ 支持（自 1.46 起）        |
| `while` 循环                 | ✅ 支持                     | ✅ 支持（自 1.46 起）        |
| CTFE 中的 `continue`/`break` | ✅ 支持                     | ✅ 支持（自 1.46 起）        |
| 自动 CTFE 推断               | ✅ 支持                     | ❌ 需要 `const fn` 标注      |
| 一等类型                     | ✅ 支持                     | ❌ 不支持（使用泛型/宏替代） |
| 运行时回退                   | ✅ 同一份代码可在运行时执行 | ⚠️ 需要为运行时另写一份      |
| const 中的 trait 方法        | ✅ 不适用（使用不同模型）   | ⚠️ 有限支持（`const impl`）  |

### 核心优势

1. **无需标注**：在 Yo 中，无需将函数标记为 `const fn`。编译器会根据输入自动判断函数是否可以在编译期求值。

2. **代码统一**：同一个函数无需修改即可同时在编译期和运行时工作。在 Rust 中，往往需要分别维护 `const fn` 和非 const 版本。

3. **一等类型**：在 Yo 中类型就是值，因此类型级别的计算就是普通的函数求值，而非独立的类型系统特性。

4. **无缝回退**：如果编译期求值不可行（例如输入为运行时值），同一份代码将在运行时执行。

## 工作原理

### CTFE 上下文

在 CTFE 期间，Yo 设置一个特殊的上下文标志（`forceCompileTimeBindings`），该标志会：

1. 使 `:=` 绑定存储编译期值（行为等同于 `::`）
2. 保留函数参数值用于编译期求值
3. 将参数标记为仅编译期使用

### 环境传播

当对控制流（如 `cond` 或 `match`）进行求值且条件在编译期已知时，Yo 会：

1. 仅对实际会执行的分支进行求值
2. 从该分支传播环境（包括更新后的变量值）
3. 跳过在编译期已知不可达的分支

这使得可变变量能够在包含 `continue` 和其他控制流的循环中被正确追踪。

## 限制

以下情况无法使用 CTFE：

- 输入仅在运行时才能确定
- 函数执行了 I/O 操作
- 函数使用了 async/await
- 函数调用了外部 C 函数
- 函数访问了可变全局状态

## 最佳实践

1. **纯函数**：编写纯函数（无副作用）以获得最佳 CTFE 效果。

2. **使用 `comptime_assert`**：通过 `comptime_assert` 验证编译期假设。

3. **善用类型参数**：为需要单态化的泛型函数使用 `comptime(T) : Type`。

4. **信任编译器**：不要过度标注。让 Yo 的自动 CTFE 分析完成其工作。

```rust
// 良好实践: 简洁清晰的代码，Yo 可以自动分析
is_prime :: (fn(n : i32) -> bool) {
  cond(
    (n < 2) => false,
    true => {
      i := i32(2);
      result := true;
      while ((i * i) <= n), {
        cond(
          ((n % i) == 0) => {
            result = false;
            break;
          },
          true => ()
        );
        i = (i + 1);
      };
      result
    }
  )
};

// 全部在编译期求值
comptime_assert(is_prime(2) == true);
comptime_assert(is_prime(17) == true);
comptime_assert(is_prime(18) == false);
```
