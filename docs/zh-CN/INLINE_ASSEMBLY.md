# 内联汇编（`asm`）设计

## 1. 动机

Yo 目前没有发出内联汇编的机制。底层操作（系统调用、SIMD、硬件内置指令、性能关键的内部循环、CPU 特性检测）必须以 C 外部函数的形式实现，这迫使开发者维护单独的 C 源文件，并通过 FFI 手动接入。

`asm` 内建函数使开发者能够直接在 Yo 源码中编写特定架构的汇编，提供以下能力：

- **类型安全的操作数** — 输入/输出根据 Yo 的类型系统进行检查
- **编译期验证** — 在求值阶段校验模板和约束
- **无缝的 C 代码生成** — 输出为 GCC/Clang 扩展内联汇编
- **零抽象成本** — 无函数调用开销，寄存器分配由 C 编译器完成

### 使用场景

| 使用场景     | 示例                                       |
| ------------ | ------------------------------------------ |
| **系统调用** | 直接使用 `syscall` 指令（Linux）           |
| **SIMD**     | 通过 asm 使用 SSE/AVX/NEON 内置指令        |
| **原子操作** | 超出标准库范围的自定义原子操作             |
| **CPU 特性** | `cpuid`、`rdtsc` 用于特性检测和计时        |
| **密码学**   | AES-NI、SHA 扩展指令                       |
| **自旋循环** | `pause`（x86）、`yield`（ARM）用于自旋等待 |
| **内存屏障** | 内存栅栏、编译器屏障                       |
| **位操作**   | `popcnt`、`bswap`、`clz`、`ctz`            |

---

## 2. 语法概述

`asm` 是一个**内建函数**（而非宏），与 Yo "一切皆函数调用"的设计哲学保持一致。

```
asm(template, operands..., options...)
```

- **template** — `comptime_str`：包含 `{name}` 或 `{N}` 占位符的汇编模板
- **operands** — `in(...)`、`out(...)`、`inout(...)`、`lateout(...)`、`inlateout(...)`：带类型的操作数声明
- **options** — `clobber(...)`、`clobber_abi(...)`、`asm_options(...)`：副作用和优化提示

### 快速示例

```rust
// 空操作 — 无操作数，无返回值
asm("nop");

// 读取时间戳计数器 — 单个输出
tsc := asm("rdtsc",
  out("eax", u32),
  out("edx", u32)
);
// tsc : tuple(u32, u32) — 通过以下方式解构：(lo, hi) := ...

// 带 clobber 的加法
result := asm(
  "add {dst}, {src}",
  inout("dst", reg, x),
  in("src", reg, y),
  clobber("cc")
);

// 编译器内存屏障 — 仅 clobber
asm("", clobber("memory"));
```

---

## 3. 模板字符串

模板是一个 **`comptime_str`**（双引号字符串字面量），在编译期进行验证。

### 占位符语法

| 语法         | 含义                                        |
| ------------ | ------------------------------------------- |
| `{name}`     | 命名操作数引用                              |
| `{N}`        | 位置操作数引用（从 0 开始，按出现顺序编号） |
| `{name:mod}` | 带寄存器修饰符的命名操作数                  |
| `{N:mod}`    | 带寄存器修饰符的位置操作数                  |
| `{{`         | 字面量 `{`                                  |
| `}}`         | 字面量 `}`                                  |

命名操作数和位置操作数**可以混合使用**，但每个操作数必须以一致的方式引用（不要对同一个操作数同时使用名称和索引）。

### 寄存器模板修饰符

修饰符控制占位符输出**哪个子寄存器名称**。这在 x86 上至关重要，因为同一个物理寄存器根据位宽有多个名称。

**x86_64 修饰符：**

| 修饰符 | 位宽       | 示例（分配到 RAX 时） |
| ------ | ---------- | --------------------- |
| （无） | 64 位      | `rax`                 |
| `:e`   | 32 位      | `eax`                 |
| `:x`   | 16 位      | `ax`                  |
| `:l`   | 8 位低字节 | `al`                  |
| `:h`   | 8 位高字节 | `ah`（仅限 a/b/c/d）  |

**aarch64 修饰符：**

| 修饰符 | 位宽  | 示例（分配到 X0 时） |
| ------ | ----- | -------------------- |
| （无） | 64 位 | `x0`                 |
| `:w`   | 32 位 | `w0`                 |

**示例：**

```rust
result := asm(
  "movzx {out}, {in:l}",    // 使用 {in} 的 8 位低字节名称
  out("out", reg, u32),
  in("in", reg, byte_val)
);
```

**C 代码生成：** 修饰符映射为 GCC 模板修饰符字符：

- `{name:l}` → `%b[name]`（GCC 8 位低字节）
- `{name:e}` → `%k[name]`（GCC 32 位）
- 等等。

### 模板字符串规则

1. 模板必须是 `comptime_str` 字面量 — 不支持运行时字符串。
2. 所有占位符必须引用已声明的操作数。
3. 允许存在未使用的操作数（C 编译器可能会优化它们）。
4. 支持多行模板（Yo 双引号字符串可包含 `\n`）。

### 多指令模板

使用 `\n` 或 `;` 在单个模板中分隔指令：

```rust
asm("push {val}\npop {out}",
  in("val", reg, x),
  out("out", reg, u64)
);
```

---

## 4. 操作数类型

操作数声明每个汇编操作数的**方向**（读/写）、**约束**（值存放位置）以及**类型/值**。

### 4.1. `in` — 输入操作数

将 Yo 值作为只读操作数**传入**汇编。

```
in(name?, constraint, value)
```

| 参数         | 类型                         | 描述                              |
| ------------ | ---------------------------- | --------------------------------- |
| `name`       | `comptime_str`（可选）    | `{name}` 在模板中引用的操作数名称 |
| `constraint` | 寄存器类或 `comptime_str` | 值的存放位置                      |
| `value`      | 表达式                       | 提供输入的 Yo 表达式              |

```rust
// 命名输入
asm("int {vec}", in("vec", imm, u8(0x80)));

// 位置输入
asm("int {0}", in(imm, u8(0x80)));

// 指定寄存器
asm("syscall", in("rax", u64(60)), in("rdi", u64(0)));
```

### 4.2. `out` — 输出操作数

声明一个汇编输出，**写入**寄存器/内存，产生一个 Yo 值。

```
out(name?, constraint, Type)
```

| 参数         | 类型                         | 描述                              |
| ------------ | ---------------------------- | --------------------------------- |
| `name`       | `comptime_str`（可选）    | `{name}` 在模板中引用的操作数名称 |
| `constraint` | 寄存器类或 `comptime_str` | 结果存放位置                      |
| `Type`       | 类型                         | 输出值的 Yo 类型                  |

`Type` 是 Yo 类型（而非值）— `asm` 返回此类型。

```rust
// 单个输出
count := asm("popcnt {out}, {in}",
  out("out", reg, u64),
  in("in", reg, value)
);
// count : u64

// 指定寄存器输出
result := asm("rdtsc",
  out("eax", u32),
  out("edx", u32)
);
// result : tuple(u32, u32)
```

### 4.3. `inout` — 输入/输出操作数

操作数**先读后写**。汇编使用输入值并将其覆盖为新值。

```
inout(name?, constraint, value)
```

输出类型从输入表达式的类型推断。

```rust
x : i32 = 42;
result := asm("add {val}, {addend}",
  inout("val", reg, x),
  in("addend", reg, i32(10))
);
// result : i32（与 x 类型相同）
```

### 4.4. `lateout` — 延迟输出操作数

类似 `out`，但编译器可以将输出寄存器**复用**为输入操作数。适用于输出在所有输入被消费**之后**才写入的情况。

```
lateout(name?, constraint, Type)
```

```rust
result := asm("compute {out}, {a}, {b}",
  lateout("out", reg, u64),
  in("a", reg, x),
  in("b", reg, y)
);
```

### 4.5. `inlateout` — 输入 + 延迟输出操作数

`in` 和 `lateout` 的组合。输入提前消费，输出延迟产生。

```
inlateout(name?, constraint, value)
```

### 4.6. `const_val` — 编译期常量操作数

将**编译期常量**直接替换到汇编模板文本中。该值作为字面量内联 — 不分配寄存器。

```
const_val(name?, value)
```

| 参数    | 类型                      | 描述                              |
| ------- | ------------------------- | --------------------------------- |
| `name`  | `comptime_str`（可选） | `{name}` 在模板中引用的操作数名称 |
| `value` | 编译期表达式              | 必须求值为编译期整数或字符串      |

```rust
// 将系统调用号作为立即数内联
asm("mov rax, {num}\nsyscall",
  const_val("num", u64(60)),
  in("rdi", u64(0)),
  clobber("rcx", "r11", "memory")
);

// 内联计算得到的常量
BUFFER_SIZE :: 4096;
asm("sub rsp, {size}",
  const_val("size", BUFFER_SIZE)
);
```

**C 代码生成：** 常量直接在模板字符串中渲染为字面量 — 不出现在 GCC 操作数列表中：

```c
// const_val("num", 60) → 模板替换
__asm__ __volatile__ ("mov rax, $60\nsyscall" : : "D" (0) : "rcx", "r11", "memory");
```

> **注意：** `const` 是 Yo 的关键字，因此该操作数命名为 `const_val` 以避免歧义。

### 4.7. `sym` — 符号操作数

在汇编模板中引用**符号的地址**（外部函数或全局变量）。不分配寄存器 — 由链接器解析符号。

```
sym(name?, symbol)
```

| 参数     | 类型                      | 描述                              |
| -------- | ------------------------- | --------------------------------- |
| `name`   | `comptime_str`（可选） | `{name}` 在模板中引用的操作数名称 |
| `symbol` | 外部函数或全局变量        | 要引用地址的符号                  |

```rust
extern "C",
  memcpy : (fn(dest: *(u8), src: *(u8), n: usize) -> *(u8));

// 在内联汇编中调用外部函数
asm("call {func}",
  sym("func", memcpy),
  in("rdi", dest),
  in("rsi", src),
  in("rdx", len),
  clobber_abi("C")
);
```

**C 代码生成：** 使用 GCC 的符号操作数：

```c
__asm__ __volatile__ ("call %[func]" :: [func] "i" (memcpy), ... : /* clobbers */);
```

### 4.8. 丢弃输出（`_`）

使用 `_` 作为输出目标来**标记特定寄存器为被破坏**而不绑定结果。当指令写入一个你不需要的寄存器时，这是必不可少的：

```rust
// CPUID：我们只需要 eax 和 ecx，丢弃 ebx 和 edx
(out_eax, out_ecx) := asm("cpuid",
  inout("eax", leaf),
  out("ebx", _),          // 被破坏，值丢弃
  inout("ecx", subleaf),
  out("edx", _)           // 被破坏，值丢弃
);
```

丢弃的输出**不计入**返回类型。它们仅用于告知 C 编译器该寄存器被修改了。

**C 代码生成：**

```c
int32_t __asm_inout_0 = leaf;
int32_t __asm_inout_1 = subleaf;
int32_t __asm_discard_0;  // 临时变量，不会被读取
int32_t __asm_discard_1;
__asm__ __volatile__ (
    "cpuid"
    : [eax] "+a" (__asm_inout_0), [ebx] "=b" (__asm_discard_0),
      [ecx] "+c" (__asm_inout_1), [edx] "=d" (__asm_discard_1)
    :
    :
);
```

### 操作数汇总表

| 操作数      | 方向        | 输入 | 输出 | GCC 约束前缀     | 备注                 |
| ----------- | ----------- | ---- | ---- | ---------------- | -------------------- |
| `in`        | 读          | ✅   | ❌   | （无）           |                      |
| `out`       | 写          | ❌   | ✅   | `=`              | `out(_, _)` = 丢弃   |
| `inout`     | 读+写       | ✅   | ✅   | `+`              |                      |
| `lateout`   | 延迟写      | ❌   | ✅   | `=&`             |                      |
| `inlateout` | 读 + 延迟写 | ✅   | ✅   | `+&`             |                      |
| `const_val` | 编译期      | ✅   | ❌   | （内联到模板中） | 值被直接替换为字面量 |
| `sym`       | 符号地址    | ✅   | ❌   | `"i"`（符号）    | 由链接器解析         |

---

## 5. 寄存器约束

寄存器约束告诉 C 编译器每个操作数应**放置在何处**。

### 5.1. 抽象寄存器类

这些是架构无关的名称，Yo 将其映射为正确的 GCC 约束：

| Yo 约束    | GCC（x86_64） | GCC（aarch64） | 描述                                    |
| ---------- | ------------- | -------------- | --------------------------------------- |
| `reg`      | `"r"`         | `"r"`          | 任意通用寄存器                          |
| `reg_byte` | `"q"`         | —              | 可用于 8 位的寄存器（x86：al/bl/cl/dl） |
| `reg_abcd` | `"Q"`         | —              | 仅限 eax/ebx/ecx/edx（x86）             |
| `xmm_reg`  | `"x"`         | `"w"`          | 128 位 SIMD 寄存器                      |
| `ymm_reg`  | `"x"`         | —              | 256 位 SIMD 寄存器（AVX）               |
| `imm`      | `"i"`         | `"i"`          | 立即数整数常量                          |
| `mem`      | `"m"`         | `"m"`          | 内存操作数                              |
| `const`    | `"n"`         | `"n"`          | 编译期数值常量                          |

### 5.2. 显式寄存器名

通过将寄存器名作为 `comptime_str` 传入来使用特定寄存器：

```rust
// x86_64 特定寄存器
asm("syscall",
  in("rax", u64(1)),     // 系统调用号
  in("rdi", u64(1)),     // fd = stdout
  in("rsi", buf_ptr),    // 缓冲区
  in("rdx", u64(13))     // 长度
);

// aarch64 特定寄存器
asm("svc #0",
  in("x8", u64(64)),    // 系统调用号（write）
  in("x0", u64(1)),     // fd
  in("x1", buf_ptr),    // 缓冲区
  in("x2", u64(13))     // 长度
);
```

各架构支持的显式寄存器名：

| 架构        | 通用寄存器                                              | SIMD                                  | 特殊寄存器 |
| ----------- | ------------------------------------------------------- | ------------------------------------- | ---------- |
| **x86_64**  | `rax`..`r15`、`eax`..`r15d`、`ax`..`r15w`、`al`..`r15b` | `xmm0`..`xmm15`、`ymm0`..`ymm15`      | `flags`    |
| **aarch64** | `x0`..`x30`、`w0`..`w30`                                | `v0`..`v31`、`d0`..`d31`、`s0`..`s31` | `nzcv`     |
| **x86**     | `eax`、`ebx`、`ecx`、`edx`、`esi`、`edi`、`ebp`、`esp`  | `xmm0`..`xmm7`                        | `flags`    |
| **arm**     | `r0`..`r15`                                             | `d0`..`d31`、`s0`..`s31`              | `cpsr`     |

### 5.3. 原始 GCC 约束字符串

对于高级用法，可以传入原始 GCC 约束字符串（输出操作数会自动添加 `=` 或 `+` 前缀）：

```rust
asm("divq {divisor}",
  inout(raw("a"), lo),       // rax：商 + 低位输入
  lateout(raw("d"), u64),    // rdx：余数
  in("divisor", reg, divisor),
  clobber("cc")
);
```

`raw(constraint_string)` 包装器将字符串直接传递给 GCC，不做任何转换。

---

## 6. Clobber 与选项

### 6.1. `clobber` — 寄存器/内存 Clobber

声明汇编**修改**了某个寄存器或内存，但该寄存器或内存不是显式操作数。

```
clobber(register_or_special...)
```

特殊 clobber 值：

| 值         | 含义                             |
| ---------- | -------------------------------- |
| `"memory"` | 汇编读写了未在操作数中指定的内存 |
| `"cc"`     | 汇编修改了条件/状态标志位        |

```rust
asm("lock; xadd {old}, ({ptr})",
  out("old", reg, i32),
  in("ptr", reg, &counter),
  clobber("memory", "cc")
);
```

多个 clobber 可以作为单独的参数传递，也可以在一次调用中传递：

```rust
clobber("memory", "cc")       // 一次调用中传递多个
clobber("memory"), clobber("cc")  // 分开调用 — 效果等同
```

### 6.2. `clobber_abi` — ABI 寄存器 Clobber

声明**所有**给定调用约定不保证保留的寄存器为被破坏。

```
clobber_abi("C")
```

这等同于列出平台 C ABI 中所有调用者保存的寄存器。

| ABI   | x86_64 Clobber                                     | aarch64 Clobber           |
| ----- | -------------------------------------------------- | ------------------------- |
| `"C"` | rax, rcx, rdx, rsi, rdi, r8-r11, xmm0-xmm15, flags | x0-x18, x30, v0-v31, nzcv |

### 6.3. `asm_options` — 汇编块选项

对汇编块行为进行细粒度控制：

```
asm_options(option1, option2, ...)
```

| 选项              | 含义                           | GCC 等价形式                  |
| ----------------- | ------------------------------ | ----------------------------- |
| `pure`            | 除输出外无副作用               | 移除 `volatile`               |
| `nomem`           | 不访问内存                     | 无需添加 `"memory"`           |
| `readonly`        | 只读内存（不写入）             | 信息性                        |
| `nostack`         | 不使用或修改栈                 | 信息性                        |
| `preserves_flags` | 不修改状态标志位               | 省略 `"cc"` clobber           |
| `att_syntax`      | 模板使用 AT&T 语法（GCC 默认） | —                             |
| `intel_syntax`    | 模板使用 Intel 语法            | `.intel_syntax noprefix` 前缀 |
| `volatile`        | 始终输出，不可优化消除（默认） | `__volatile__`                |
| `noreturn`        | 汇编块永不返回                 | 将后续代码标记为不可达        |

```rust
// 纯计算 — 优化器可移动/消除
tsc := asm("rdtsc",
  out("eax", u32),
  out("edx", u32),
  asm_options(pure, nomem, nostack)
);
```

**`asm` 默认为 `volatile`** — 汇编始终会被输出，且不会被重排或消除。添加 `pure` 可以让优化器将其视为普通计算。

### 6.4. `noreturn` — 非返回汇编

当指定 `noreturn` 时，汇编块**永不返回**到后续代码。编译器将后续代码视为不可达。`noreturn` 不允许与输出操作数同时使用。

```rust
// 自定义停机/陷阱
asm("ud2", asm_options(noreturn));

// 内核入口点 — 跳转后永不返回
asm("jmp {entry}",
  sym("entry", kernel_main),
  asm_options(noreturn)
);
```

**C 代码生成：**

```c
__asm__ __volatile__ ("ud2" :::);
__builtin_unreachable();  // 告知优化器此处不可达
```

带有 `noreturn` 的 `asm` 返回类型为 `noreturn`（Yo 的底类型），类似于 `panic`。

### 6.5. 多字符串模板

为了提高可读性，`asm` 开头的多个 `comptime_str` 参数会被**用 `\n` 连接**。这避免了在长模板中手动添加 `\n`：

```rust
// 多个字符串 — 每个变成一行指令
asm(
  "push {val}",
  "shl {val}, 2",
  "pop {out}",
  in("val", reg, x),
  out("out", reg, u64)
);

// 等价的单字符串形式：
asm("push {val}\nshl {val}, 2\npop {out}",
  in("val", reg, x),
  out("out", reg, u64)
);
```

解析器收集连续的 `comptime_str` 参数，直到遇到非字符串参数（操作数或选项）。

---

## 7. 输出模式

`asm` 支持两种输出模式：**返回值输出**和**变量目标输出**。两者可以在单个 `asm` 调用中混合使用。

### 7.1. 返回值输出（类型参数）

当 `out` / `lateout` 的最后一个参数是**类型**时，输出成为 `asm` 返回值的一部分：

```rust
// 单个返回值输出
result := asm("rdtsc", out("eax", u32));
// result : u32

// 多个返回值输出 → 元组
(lo, hi) := asm("rdtsc",
  out("eax", u32),   // 元组第 0 个字段
  out("edx", u32)    // 元组第 1 个字段
);
// (lo, hi) : tuple(u32, u32)
```

**返回类型推断：**

| 返回值输出数量     | 返回类型             |
| ------------------ | -------------------- |
| 无                 | `unit`               |
| 一个 `out(_, T)`   | `T`                  |
| 一个 `inout(_, v)` | `typeof(v)`          |
| 多个               | `tuple(T1, T2, ...)` |

`inout` 和 `inlateout` 始终算作返回值输出。

### 7.2. 变量目标输出（变量参数）

当 `out` / `lateout` 的最后一个参数是**变量**时，汇编直接写入该变量。这对于初始化未初始化变量至关重要：

```rust
// 声明未初始化变量
(lo : u32);
(hi : u32);

// asm 写入它们 — 标记为已初始化
asm("rdtsc",
  out("eax", lo),    // 写入 lo
  out("edx", hi)     // 写入 hi
);

// lo 和 hi 现在已初始化，可以使用
total := ((u64(hi) << u64(32)) | u64(lo));
```

**求值器如何区分两种模式：**

- 如果操作数参数求值为**类型**（例如 `u32`、`i64`、`*(u8)`）→ 返回值输出
- 如果操作数参数求值为**变量引用**（例如 `lo`、`my_var`）→ 变量目标输出

由于 Yo 不允许变量遮蔽，类型名和变量名之间不存在歧义。

**初始化追踪：**

求值器在 `asm` 表达式之后将变量目标输出标记为**已初始化**。在 `asm` 之前使用该变量是编译期错误：

```rust
(x : i32);
// print(x);  // 错误：变量 'x' 未初始化

asm("mov {0}, $42", out(reg, x));

print(x);  // 正常：x 已被 asm 初始化
```

**变量目标输出不计入返回类型。** 只有返回值输出和 `inout` 操作数决定返回类型。

### 7.3. 混合模式示例

变量目标输出和返回值输出可以共存：

```rust
(remainder : u64);

quotient := asm("divq {divisor}",
  inout("eax", lo),               // 返回值（inout 始终返回）
  out("edx", remainder),          // 变量目标（写入 remainder）
  in("divisor", reg, divisor),
  clobber("cc")
);
// quotient : u64（来自 inout）
// remainder 现在已初始化
```

### 7.4. 变量目标输出的 C 代码生成

**Yo 源码：**

```rust
(lo : u32);
(hi : u32);
asm("rdtsc", out("eax", lo), out("edx", hi));
```

**生成的 C 代码：**

```c
uint32_t lo;  // 未初始化 — 来自 (lo : u32)
uint32_t hi;
__asm__ __volatile__ (
    "rdtsc"
    : [eax] "=a" (lo), [edx] "=d" (hi)
    :
    :
);
// lo 和 hi 现在已被 asm 块赋值
```

这比返回值方式更高效，因为无需临时变量 — C 编译器直接赋值到目标变量。

---

## 8. C 代码生成

### 8.1. 映射到 GCC 扩展汇编

`asm(...)` 编译为 GCC 扩展内联汇编：

```c
__asm__ __volatile__ (
    "template"
    : /* 输出 */   [name] "constraint" (var), ...
    : /* 输入 */   [name] "constraint" (expr), ...
    : /* clobber */ "reg", "memory", ...
);
```

### 8.2. 模板转换

Yo 模板占位符被转换为 GCC 操作数引用：

| Yo 模板  | GCC 模板  |
| -------- | --------- |
| `{name}` | `%[name]` |
| `{0}`    | `%0`      |
| `{{`     | `{`       |
| `}}`     | `}`       |

### 8.3. 完整示例 — Yo 到 C

**Yo 源码：**

```rust
(lo, hi) := asm("rdtsc",
  out("lo", "eax", u32),
  out("hi", "edx", u32)
);
```

**生成的 C 代码：**

```c
uint32_t __asm_out_0;
uint32_t __asm_out_1;
__asm__ __volatile__ (
    "rdtsc"
    : [lo] "=a" (__asm_out_0), [hi] "=d" (__asm_out_1)
    :
    :
);
// __asm_out_0 和 __asm_out_1 在引用 lo/hi 的地方被使用
```

### 8.4. `inout` 代码生成

**Yo 源码：**

```rust
result := asm("add {val}, {addend}",
  inout("val", reg, x),
  in("addend", reg, y),
  clobber("cc")
);
```

**生成的 C 代码：**

```c
int32_t __asm_inout_0 = x;
__asm__ __volatile__ (
    "add %[val], %[addend]"
    : [val] "+r" (__asm_inout_0)
    : [addend] "r" (y)
    : "cc"
);
// result = __asm_inout_0
```

### 8.5. Unit 返回值（无输出）

**Yo 源码：**

```rust
asm("mfence", clobber("memory"));
```

**生成的 C 代码：**

```c
__asm__ __volatile__ ("mfence" ::: "memory");
```

### 8.6. Intel 语法

**Yo 源码：**

```rust
result := asm("mov {out}, {in}",
  out("out", reg, u64),
  in("in", reg, value),
  asm_options(intel_syntax)
);
```

**生成的 C 代码：**

```c
uint64_t __asm_out_0;
__asm__ __volatile__ (
    ".intel_syntax noprefix\n"
    "mov %[out], %[in]\n"
    ".att_syntax prefix"
    : [out] "=r" (__asm_out_0)
    : [in] "r" (value)
    :
);
```

---

## 9. `global_asm` — 模块级汇编

对于存在于**函数之外**的汇编（数据段、函数前导代码、链接器指令），使用 `global_asm`：

```rust
global_asm(".section .note.GNU-stack,\"\",@progbits");

global_asm(
  ".global my_asm_func\n"
  "my_asm_func:\n"
  "  ret"
);
```

### 语法

```
global_asm(template)
```

- `template` — `comptime_str`：在文件作用域输出的原始汇编
- 无操作数，无返回值
- 必须出现在模块顶层（不在函数内部）

### C 代码生成

```c
__asm__ (".section .note.GNU-stack,\"\",@progbits");
```

---

## 10. 平台与编译器注意事项

### 10.1. 编译器支持矩阵

| 编译器         | 内联汇编      | `global_asm` | 备注               |
| -------------- | ------------- | ------------ | ------------------ |
| **GCC**        | ✅ `__asm__`  | ✅ `__asm__` | 完整支持           |
| **Clang**      | ✅ `__asm__`  | ✅ `__asm__` | 兼容 GCC           |
| **Zig cc**     | ✅ `__asm__`  | ✅ `__asm__` | Clang 后端         |
| **MSVC (x64)** | ❌            | ❌           | x64 不支持内联汇编 |
| **MSVC (x86)** | ⚠️ `__asm {}` | ❌           | 语法不同，功能有限 |

### 10.2. MSVC 策略

MSVC x64 **不支持**内联汇编。当目标为 MSVC 时：

1. **编译期错误**：`asm(...)` 产生错误：`"Inline assembly is not supported with MSVC x64. Use compiler intrinsics or a separate .asm file."`
2. **内置函数替代方案**：提供带编译器内置函数包装器的 `std/arch` 模块（未来工作）。
3. **外部 ASM**：用户可以编写 `.asm` 文件并通过构建系统链接。

对于 MSVC x86，`__asm {}` 语法差异过大，我们不尝试自动转换。同样适用编译期错误。

### 10.3. 架构门控

使用 Yo 的编译期平台/架构检测来对特定架构的汇编进行条件选择：

```rust
platform :: __yo_process_platform();
arch :: __yo_process_arch();

rdtsc :: (fn() -> u64)(
  cond(
    (arch == Arch.X86_64) => {
      (lo, hi) := asm("rdtsc",
        out("eax", u32),
        out("edx", u32),
        asm_options(pure, nomem, nostack)
      );
      (u64(hi) << u64(32)) | u64(lo);
    },
    (arch == Arch.Aarch64) => {
      asm("mrs {0}, cntvct_el0",
        out(reg, u64),
        asm_options(pure, nomem, nostack)
      );
    },
    true => comptime_assert(false, "rdtsc: unsupported architecture")
  )
);
```

死代码消除确保在 C 输出中只发出目标架构的汇编。

### 10.4. WebAssembly

WebAssembly 不支持内联汇编。当目标为 `wasm32` 时，`asm(...)` 会产生编译期错误。

---

## 11. 安全性与验证

### 11.1. 编译期验证（求值器）

求值器执行以下检查：

| 检查项                                  | 错误信息                                               |
| --------------------------------------- | ------------------------------------------------------ |
| 模板为 `comptime_str`                | `"asm template must be a compile-time string literal"` |
| 约束为 `comptime_str` 或有效寄存器类 | `"Invalid register constraint: {c}"`                   |
| 输出类型为具体的原始/指针类型           | `"asm output type must be a concrete type (got {T})"`  |
| 所有模板占位符引用已存在的操作数        | `"asm template references undefined operand '{name}'"` |
| 无重复操作数名称                        | `"Duplicate asm operand name: '{name}'"`               |
| 架构特定寄存器与目标匹配                | `"Register '{r}' is not available on {arch}"`          |
| 目标不是 MSVC x64 或 wasm32             | `"Inline assembly not supported on {target}"`          |

### 11.2. 允许的类型

只有以下 Yo 类型可以用作 `asm` 操作数：

| 类别       | 类型                                                                   |
| ---------- | ---------------------------------------------------------------------- |
| **整数**   | `i8`、`i16`、`i32`、`i64`、`u8`、`u16`、`u32`、`u64`、`usize`、`isize` |
| **浮点数** | `f32`、`f64`                                                           |
| **指针**   | `*(T)`（任意 `T`）                                                     |
| **布尔**   | `bool`（在汇编上下文中视为 `i8`）                                      |

引用计数类型（`ref(struct(...))`、`String` 等）**不允许使用** — 汇编仅操作原始值。

### 11.3. CTFE 阻断

`asm(...)` **阻断编译期函数求值**。包含 `asm` 的函数不能在编译期求值（类似于 `panic`）。这在 CTFE 分析阶段强制执行。

### 11.4. 无安全包装

Yo 没有 `unsafe` 块。内联汇编天生是不安全的 — 它可以破坏栈、违反别名规则并导致未定义行为。这与 Yo 信任开发者进行底层操作的设计哲学一致（类似于原始指针操作同样不做检查）。

编译期验证会捕获结构性错误（模板格式错误、类型错误、未知寄存器），但无法验证汇编本身的正确性。

---

## 12. 综合示例

### 12.1. x86_64 系统调用（Linux write）

```rust
sys_write :: (fn(fd: u64, buf: *(u8), len: u64) -> i64)(
  asm("syscall",
    in("rax", u64(1)),     // SYS_write
    in("rdi", fd),
    in("rsi", buf),
    in("rdx", len),
    out("rax", i64),       // 返回值
    clobber("rcx", "r11", "memory")
  )
);
```

### 12.2. 原子比较并交换（x86_64）

```rust
cas :: (fn(ptr: *(i32), expected: i32, desired: i32) -> tuple(i32, bool))(
  {
    prev := asm(
      "lock cmpxchg {ptr_mem}, {desired}",
      inout("eax", expected),
      in("desired", reg, desired),
      in("ptr_mem", mem, ptr),
      clobber("cc", "memory")
    );
    (old, success) := (prev, (prev == expected));
    (old, success);
  }
);
```

### 12.3. ARM64 内存屏障

```rust
dmb_ish :: (fn() -> unit)(
  asm("dmb ish", clobber("memory"))
);
```

### 12.4. CPUID（x86_64）

```rust
CpuidResult :: struct(eax: u32, ebx: u32, ecx: u32, edx: u32);

cpuid :: (fn(leaf: u32, subleaf: u32) -> CpuidResult)(
  {
    (out_eax, out_ebx, out_ecx, out_edx) := asm("cpuid",
      inout("eax", leaf),
      out("ebx", u32),
      inout("ecx", subleaf),
      out("edx", u32)
    );
    CpuidResult(out_eax, out_ebx, out_ecx, out_edx);
  }
);
```

### 12.5. 自旋等待提示

```rust
spin_hint :: (fn() -> unit)(
  cond(
    (arch == Arch.X86_64) => asm("pause"),
    (arch == Arch.Aarch64) => asm("yield"),
    true => ()  // 其他架构上为空操作
  )
);
```

### 12.6. 读取性能计数器（跨平台）

```rust
perf_counter :: (fn() -> u64)(
  cond(
    (arch == Arch.X86_64) => {
      (lo, hi) := asm("rdtsc",
        out("eax", u32),
        out("edx", u32),
        asm_options(pure, nomem, nostack)
      );
      ((u64(hi) << u64(32)) | u64(lo));
    },
    (arch == Arch.Aarch64) =>
      asm("mrs {0}, cntvct_el0",
        out(reg, u64),
        asm_options(pure, nomem, nostack)
      ),
    true => u64(0)
  )
);
```

### 12.7. 字节交换

```rust
bswap32 :: (fn(value: u32) -> u32)(
  cond(
    (arch == Arch.X86_64) =>
      asm("bswap {0}",
        inout(reg, value),
        asm_options(pure, nomem, nostack)
      ),
    (arch == Arch.Aarch64) =>
      asm("rev {0}, {1}",
        out(reg, u32),
        in(reg, value),
        asm_options(pure, nomem, nostack)
      ),
    true => {
      // 回退方案：手动字节交换
      (((value >> u32(24)) & u32(0xFF)) |
       (((value >> u32(16)) & u32(0xFF)) << u32(8)) |
       (((value >> u32(8)) & u32(0xFF)) << u32(16)) |
       ((value & u32(0xFF)) << u32(24)));
    }
  )
);
```

---

## 13. 未来工作

### 13.1. `std/arch` 模块

提供常见内置指令可移植包装器的标准库模块：

```rust
// std/arch/x86_64.yo
open import "std/arch/x86_64";

result := _mm_add_ps(a, b);  // SSE 加法
tsc := rdtsc();               // 包装 asm("rdtsc", ...)
```

### 13.2. MSVC 内置函数映射

自动将常见 `asm` 模式映射为 MSVC `__intrin.h` 内置函数：

```rust
// 在 GCC/Clang 上：输出内联汇编
// 在 MSVC 上：输出 __rdtsc() 内置函数调用
tsc := rdtsc();
```

### 13.3. 命名汇编函数

允许完整地用汇编定义函数（超越 `global_asm`）：

```rust
// 可能的未来语法
naked_fn :: asm_fn(fn(a: u64, b: u64) -> u64,
  "add rax, rdi, rsi\n"
  "ret"
);
```

---

## 14. 设计决策总结

| 决策                          | 选择                     | 理由                                                  |
| ----------------------------- | ------------------------ | ----------------------------------------------------- |
| 内建函数，非宏                | `asm(...)`               | Yo 没有宏系统；内建函数是扩展机制                     |
| 通过字符串命名操作数          | `in("name", ...)`        | 适用于现有解析器；无需新语法                          |
| 通过返回类型输出              | `x := asm(...)`          | 函数式风格，无可变输出参数                            |
| 变量目标输出                  | `out(reg, var)`          | 支持未初始化变量；初始化追踪                          |
| 默认 volatile                 | 显式 `pure` 可选         | 大多数汇编有副作用；安全的默认行为                    |
| 无 `unsafe` 包装              | 裸 `asm(...)`            | Yo 没有 unsafe 概念；信任开发者                       |
| MSVC：编译期错误              | 不做转译                 | MSVC x64 不支持内联汇编；内置函数是独立的功能         |
| 使用 GCC `__asm__` 而非 `asm` | 可移植 C 关键字          | `__asm__` 在所有 C 标准模式下均可使用（严格 C11）     |
| 抽象寄存器类                  | `reg`、`imm`、`mem`      | 跨架构可移植；高级用法有原始字符串回退                |
| 使用 `const_val` 而非 `const` | 避免关键字冲突           | `const` 是 Yo 关键字；`const_val` 无歧义              |
| 操作数子调用非内建函数        | `out`、`in` 等为原子操作 | 仅在 `asm()` 求值器内部按名称识别；不污染全局命名空间 |
| `const_val` 裸替换            | 不添加 `$` 或 `#` 前缀   | 用户在模板中为目标架构提供正确的语法前缀              |
| Clobber 裸原子                | `memory`、`cc` 作为原子  | 直接识别，无需求值，更符合人体工程学                  |

---

## 15. 与 Rust `asm!` 的功能对比

与 Rust 内联汇编的全面对比：

| Rust 功能                  | Yo 等价形式                                     | 状态                                   |
| -------------------------- | ----------------------------------------------- | -------------------------------------- |
| `asm!("template", ...)`    | `asm("template", ...)`                          | ✅ 支持                                |
| `in(reg) expr`             | `in(reg, expr)` 或 `in("name", reg, expr)`      | ✅ 支持                                |
| `out(reg) var`             | `out(reg, var)`（变量目标）                     | ✅ 支持                                |
| `out(reg) Type`            | `out(reg, Type)`（返回值）                      | ✅ 支持                                |
| `inout(reg) var`           | `inout(reg, expr)` / `inout("name", reg, expr)` | ✅ 支持                                |
| `lateout(reg) var`         | `lateout(...)`                                  | ✅ 支持                                |
| `inlateout(reg) var`       | `inlateout(...)`                                | ✅ 支持                                |
| `out(reg) _`（丢弃）       | `out(reg, _)`                                   | ✅ 支持                                |
| `const expr`               | `const_val(expr)` / `const_val("name", expr)`   | ✅ 支持                                |
| `sym path`                 | `sym(symbol)` / `sym("name", symbol)`           | ✅ 支持                                |
| 命名操作数 `x = in(reg) v` | `in("x", reg, v)`                               | ✅ 语法不同，能力相同                  |
| 位置引用 `{0}`、`{1}`      | `{0}`、`{1}`                                    | ✅ 支持                                |
| 寄存器修饰符 `{x:e}`       | `{x:e}`                                         | ✅ 支持                                |
| `options(pure)`            | `asm_options(pure)`                             | ✅ 支持                                |
| `options(nomem)`           | `asm_options(nomem)`                            | ✅ 支持                                |
| `options(readonly)`        | `asm_options(readonly)`                         | ✅ 支持                                |
| `options(nostack)`         | `asm_options(nostack)`                          | ✅ 支持                                |
| `options(preserves_flags)` | `asm_options(preserves_flags)`                  | ✅ 支持                                |
| `options(att_syntax)`      | `asm_options(att_syntax)`                       | ✅ 支持                                |
| `options(noreturn)`        | `asm_options(noreturn)`                         | ✅ 支持                                |
| `clobber_abi("C")`         | `clobber_abi("C")`                              | ✅ 支持                                |
| 多字符串模板               | 多个字符串参数自动连接                          | ✅ 支持                                |
| `global_asm!`              | `global_asm(...)`                               | ✅ 支持                                |
| `unsafe { asm!(...) }`     | `asm(...)`（Yo 无 unsafe）                      | ✅ 不同的设计理念                      |
| `naked_asm!`               | —                                               | 🔮 未来工作（§13.3）                   |
| `label` 操作数             | —                                               | 🔮 未来工作（Rust 中也仍属实验性功能） |

与稳定版 Rust `asm!` **完全对等**。两个延后的功能（`naked_asm`、`label`）要么使用场景有限，要么在 Rust 中仍属实验性功能。
