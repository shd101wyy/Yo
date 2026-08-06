# 内存安全

Yo **默认是内存安全的**。作为普通用户编写的代码无法解引用悬空指针、越界访问数组、双重释放或以其他方式触发未定义行为。你不需要学习借用检查器、管理生命周期或为引用添加注解就能获得这个保证 —— 安全性的论证是结构性的：导致 C 语言出现内存不安全的构造（原始指针、取地址、指针算术、FFI、内联汇编）在安全代码中根本不可用。在静态分析到达极限的地方，一个轻量级运行时借用标志（零额外内存，~0% 开销）将唯一残留的内部引用形态转为确定性 panic，而非静默内存破坏。

标准库内部使用原始指针来构建你调用的安全抽象。那部分代码通过 `pragma(Pragma.AllowUnsafe);` 在文件级别选择进入 unsafe-capable 模式，并作为可信基础进行审计。你的代码保持干净。

本页从用户视角描述安全模型：你可以写什么、不可以写什么、标准库如何在不暴露原始指针的情况下提供原地修改、以及如何在确实需要的情况下（绑定 C 库、编写你自己的分配器）选择进入 unsafe-capable 模式。

## 契约

```
安全的 Yo 代码无法表达未定义行为。
```

这就是规则。它通过把可能触发 UB 的构造从用户的词汇表中移除来强制，而不是通过证明这些构造不存在。这个模型与 Swift、Go、Java 一致：用户面向的安全表面 + 一个允许使用原始内存的小型可信基础（标准库）。

## 安全代码能做什么

任何你期望一个现代通用语言提供的能力：

- **值类型。** `i32`、`bool`、`str`（指向**静态**字符串字节的视图 —— 背后存储永生）、struct、enum、tuple、`Array(T, N)`。
- **堆管理的集合。** `ArrayList(T)`、`HashMap(K, V)`、`HashSet(T)`、`Deque(T)`、`LinkedList(T)`、`String`，以及 `std/imm/*` 中的不可变版本。
- **共享所有权。** 引用语义类型（`ref(struct(...))`/`ref(enum(...))`，单线程 Rc）、`Arc(T)`（跨线程共享的原子 Rc）、`Iso(T)`（所有权转移）。
- **和类型 / Option / Result 类型。** `Option(T)`、`Result(T, E)`，以及你自定义的 `enum`。
- **闭包和高阶函数** —— 在安全类型上。
- **泛型、trait、GADT。** Yo 的全部类型系统特性。
- **代数效应、async/await、comptime。** 完全可用。
- **原地修改。** 通过 `inout(name) : T` 参数 —— 下面会讲。

这是默认的用户体验。不需要 pragma、不需要 `&()` 注解、不需要 `*(T)` 类型、不需要 `unsafe(...)` 包装：

```rust
{ ArrayList } :: import("std/collections/array_list");

main :: (fn() -> unit)({
  list := ArrayList(i32).new();
  list.push(i32(1));
  list.push(i32(2));
  list.push(i32(3));

  total := i32(0);
  for(list, (item) => {
    total = (total + item);
  });
  println("total = ${total}");
});
```

`for` 宏按值迭代（`(item) => …` 底层调用 `.into_iter()`）。引用语义类型（`ref(struct(...))`）元素是句柄，在循环体内变异 `item` 即就地变异元素；struct/标量元素用索引赋值写回（`coll(i) = v`）。旧的借用形式 `for(coll, inout(item) => …)` 已移除，使用时会产生带上述迁移指引的编译错误。

## 安全代码不能做什么

在没有 `pragma(Pragma.AllowUnsafe);` 的文件中，下列每一项都是编译错误。每个错误都附带"请改用"提示。

| 构造                                                | 诊断（简短）                                                                     | 安全替代方案                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 参数、字段或返回值中的 `*(T)` 类型                  | "raw pointer types are not available in safe code"                               | 自有集合（`ArrayList`/`String`）、`inout(name) : T`、引用语义类型（`ref(struct(...))`/`ref(enum(...))`），或标准库包装 |
| `&(expr)` 取地址                                    | "this expression has type `*(T)`, which is not available in safe code"           | `inout(name) : T` 参数，或直接传自有集合                                                                               |
| `unsafe(...)` 调用                                  | "`unsafe(...)` is not available in safe code"                                    | 使用标准库的安全 API，或在确实需要原始操作时加 `pragma(Pragma.AllowUnsafe);`                                           |
| `asm(...)` 块                                       | "inline assembly is not available in safe code"                                  | 同上                                                                                                                   |
| `extern(...)` / `c_include(...)` 声明               | "extern FFI declarations are not available in safe code"                         | 调用标准库包装（如 `std/sys`、`std/fs`）                                                                               |
| 指针算术（`.add(n)`、`.sub(n)`、`.offset_from(q)`） | "pointer arithmetic requires raw pointers, which are not available in safe code" | 在 `ArrayList(T)` / `Array(T, N)` 上使用索引                                                                           |
| 在指针上 `consume(p.* = v)`                         | "`consume` on a pointer deref requires raw pointers"                             | 对安全类型使用 `:=` 进行所有权转移                                                                                     |

原则：**任何可能让用户写出 UB 的构造都被门控。** 用户既然无法构造原始指针，就无法解引用 —— 就这样。

## 原地修改：`inout(name) : T`

C / Rust 用 `&mut T` 解决的模式，在安全 Yo 中由一个参数修饰符解决：

```rust
swap :: (fn(inout(a) : i32, inout(b) : i32) -> unit)({
  tmp := a;
  a = b;
  b = tmp;
});

main :: (fn() -> unit)({
  x := i32(1);
  y := i32(2);
  swap(x, y);              // 调用处不需要 &() —— `inout` 性质在参数定义中
  assert((x == i32(2)), "swapped");
});
```

`inout` 是**二等的**，且只存在于参数位置（`inout(name) : T`）。函数不能返回 `inout`，没有局部 inout 绑定（`inout(r) := …` 会被拒绝 —— 字段本来就能就地读写），不存在一等的"`inout` 类型"，借用也无法泄漏到 struct 字段或闭包捕获中。inout 实参是一个简单的左值位置（变量，或以局部/参数为根的 `var.field`），因此被借用的存储按构造在整个调用期间存活。见 [FLOWABILITY.md](./FLOWABILITY.md)。

使用场景：

- 标准库中带变异的 trait 方法（`Hash.hash`、`Clone.clone`、`Iterator.next`）都接收 `inout(self) : Self`。你写 `value.hash()`、`it.next()` —— 不需要 `&()`。
- 你自己的变异辅助函数（`swap`、`increment`、`clear` 等）使用 `inout(name) : T`。
- 在一个作用域内出借值的回调 API：`Mutex.with_lock(body : Impl(Fn(inout(v) : T) -> R))`。

## 标准库集合保持安全

`ArrayList(T)`、`HashMap(K, V)`、`String` 等在它们的内部表示中都携带了原始指针。它们能安全使用是因为实现把指针藏起来了：

1. **没有公共方法的签名中包含 `*(T)`。** 方法的入参和返回值都是安全类型。
2. **所有索引都经过边界检查。** `str` 上的 `s(i)`、`arr.get(i)`、`list(usize(0))` 在越界时要么 trap 要么返回 `Option(T)`。背后的指针算术位于 `unsafe(...)` 块中，并伴随已验证的边界不变式。
3. **没有原始构造。** 你无法用任意指针构造 `ArrayList(T)`；构造器是安全的。

语言层面还从构造上关闭了**悬空视图漏洞** —— 即其他使用原始指针抽象的语言需要手动管理的那种：

- `str` 是唯一的内建视图类型，且只能指向**静态**字符串数据（字面量、`comptime_str`）—— 它永远不会指向可能被释放的堆缓冲区。
- **集合上的区间操作是拷贝。** `list(usize(1)..usize(3))` 与 `String` 的区间产生一个独立持有的值，而不是源缓冲区上的窗口 —— 不存在可悬空的堆切片类型。
- **元素访问只交出值，从不交出内部指针。** `xs.get(i)` 返回元素 —— object 元素返回指向元素*对象*的句柄（就地变异、且在容器增长/realloc 之后依然有效）；struct 元素返回拷贝，用 `xs(i) = v` 写回。安全表达式无法产生指向容器缓冲区内部的指针，因此增长失效根本无法表达。

这些规则的讲解见 [FLOWABILITY.md](./FLOWABILITY.md)；编写安全代码不需要了解它们 —— 危险的形态会被编译器直接拒绝。

## 逃逸口：`pragma(Pragma.AllowUnsafe);`

当你确实需要原始指针时 —— 绑定 C 库、编写自定义分配器、实现新集合 —— 在文件顶部加一行声明，进入 unsafe-capable 模式：

```rust
pragma(Pragma.AllowUnsafe);

// 在这个文件里现在可以使用 *(T)、&(x)、unsafe(...)、asm(...)、
// extern(...)、c_include(...) 和指针算术。
```

选择进入是**按文件**的，而不是按函数或按块。这种粒度是有意的：带 `pragma(...)` 的文件接受文件内所有内容的审计责任；你不在原本安全的代码中点缀 unsafe。如果你发现自己只想要一个小的 unsafe 区域，那个区域通常应该单独占一个文件（往往是一个薄的标准库风格的包装）。

在特权文件内你仍然需要显式写明操作：

```rust
pragma(Pragma.AllowUnsafe);
{ memcpy } :: import("std/libc/string");

copy_bytes :: (fn(dst : *(u8), src : *(u8), n : usize) -> unit)({
  // extern 调用必须包在 unsafe(...) 里 —— 见下面的"逐调用审计标记"。
  _ := unsafe(memcpy((*(void))(dst), (*(void))(src), n));
});
```

## `unsafe(...)`：逐操作审计标记

在特权文件内，每一个可能触发 UB 的操作都必须出现在 `unsafe(...)` 调用中：

| 操作                | 示例                                                               |
| ------------------- | ------------------------------------------------------------------ |
| 指针解引用（读）    | `unsafe(p.*)`                                                      |
| 指针解引用（写）    | `unsafe(p.* = v)`                                                  |
| `consume(p.* = v)`  | `unsafe(consume(p.* = v))`                                         |
| 指针算术            | `unsafe(p.add(n))`、`unsafe(p.sub(n))`、`unsafe(p.offset_from(q))` |
| extern "c" 函数调用 | `unsafe(strlen(cstr))`、`unsafe(memcpy(dst, src, n))`              |

这个包装是**纯编译时标记** —— 代码生成时会还原为内部表达式，所以没有运行时开销。它存在的目的是审计精度：`yo unsafe-report` 可以精确地指出发生 unsafe 操作的行号，而不只是列出文件。审计者 grep `unsafe(` 就能看到每一个可能触发 UB 的位置。

不需要门控的操作（地址只是数据，传递地址不会触发 UB）：

- `&(x)` —— 取地址
- 把 `*(T)` 传给函数
- 把 `*(T)` 存进 struct 字段
- 返回 `*(T)`
- 指针比较：`p == q`、`p < q` 等
- 指针类型转换：`*(u8)(p)`
- `asm(...)` 块（`asm` 关键字本身就是标记）
- `extern(...)` / `c_include(...)` _声明_（只有*调用处*需要包装）

## `// SAFETY:` 注释

当你写 `unsafe(...)` 时，你是在声明某个具体契约成立。把它写下来：

```rust
match(
  self._ptr,
  // SAFETY: idx has been bounds-checked above (idx < self._length);
  // _ptr points at the Rc-managed heap buffer, alive while self
  // holds the Rc.
  .Some(_ptr) => (_ptr.add(idx)),
  .None => panic("ArrayList: index on empty list")
)
```

`yo unsafe-report` 会捕获 `unsafe(...)` 站点前约 8 行内的 `// SAFETY:` 注释并在报告中显示。这是标准库的约定：每一个不显然的 unsafe 站点都有注释解释契约为什么成立。

## 审计工具

### `yo unsafe-report [path]`

列出某路径下所有 unsafe 相关的构造：

```
$ yo unsafe-report ./std
Unsafe surface report
=====================

Scanned 148 .yo file(s); 99 declare pragma(Pragma.AllowUnsafe);.
  unsafe(...) sites: 78
    extern-call: 64
    deref:       4
    arith:       2
    addr-of:     7
    other:       1
  asm(...) sites:    0
  extern(...) sites: 20

Top extern callees (by unsafe-wrapped call-site count):
    26  snprintf
    12  memcpy
     8  fwrite
     7  memcmp
     2  memset
     ...

Findings (file:line:col):
  std/collections/array_list.yo:521:24: unsafe(arith) — .Some(_ptr) => unsafe(_ptr.add(pos)),
    SAFETY: assert above bounds `pos < self._length` and the
  ...
```

分类（extern-call / deref / arith / addr-of / other）和 top-callees 摘要让报告变成审计清单：一名审计者扫描一个发布版本时，能看到调用量最高的 C 函数有哪些、哪些 `unsafe(...)` 是指针操作而哪些是 FFI、以及哪些站点有明确的 SAFETY: 说明。

有用的选项：

- `--json` —— 机器可读的输出（适合 CI 脚本或仪表盘）。

### 其他 lint

- `yo public-safe-report [path]` —— 标记签名中泄漏 `*(T)` 的公共标准库 API。在标准库演化时用来保持安全表面的清洁。

## FFI

用户代码不能声明 `extern(...)` 或 `c_include(...)`。要调用 C 函数：

1. **首选：** 调用已有的标准库包装（`std/sys/*`、`std/fs`、`std/libc/*`、`std/net` 等）。
2. **如果没有包装：** 新建一个带 `pragma(Pragma.AllowUnsafe);` 的文件，在其中声明 extern，在每个调用处包 `unsafe(...)`，并把这个文件视为项目可信基础的一部分。

```rust
// my_ffi.yo
pragma(Pragma.AllowUnsafe);

c_include(
  "<mylib.h>",
  mylib_init : (fn() -> int),
  mylib_compute : (fn(input : i32) -> i32)
);

init :: (fn() -> Result(unit, int))({
  // SAFETY: mylib_init has no preconditions; non-zero return signals
  // initialization failure.
  rc := unsafe(mylib_init());
  cond(
    (rc == int(0)) => .Ok(()),
    true => .Err(rc)
  )
});

compute :: (fn(input : i32) -> i32)(unsafe(mylib_compute(input)));
```

然后在安全的调用方文件中：

```rust
// main.yo  （无 pragma）
{ init, compute } :: import("./my_ffi");

main :: (fn() -> unit)({
  match(
    init(),
    .Ok(_) => println("result: ${compute(i32(42))}"),
    .Err(e) => println("init failed: ${e}")
  );
});
```

工作流程与 Swift 或 Go 中编写 FFI 绑定相同。

## 整数溢出

Yo 把 `i32(...)`、`i64(...)` 等编译成 C 的有符号整型。默认情况下 Yo 给 C 编译器传 `-fwrapv`，把有符号整数溢出定义为**二补码回卷** —— 不是未定义行为。

```rust
x := i32(2147483647);   // i32 最大值
y := (x + i32(1));      // y == i32(-2147483648) —— 定义的回卷，不是 UB
```

大多数用户代码不会撞到上限，因为 Yo 提供了 `i64` / `u64` 来处理可能溢出的场景。`-fwrapv` 默认意味着如果你的代码*真的*溢出了，行为是可预测的而不是一次静默的错误编译。

如果你测出某个数值密集的循环有性能回归并想退回到严格溢出优化，用 `--cflags='-fno-wrapv'` 构建。实际上，在真实循环上性能差异 < 0.5%；这个选项是为了完整性而存在，而不是因为你通常会需要它。

## 这个模型不保证什么

安全模型对它的范围保持诚实：

- **它防止 UB。** 它不防止逻辑错误、panic、死循环或资源耗尽。`panic("...")` 仍然会终止程序；无界的 `while(true, ...)` 仍然会挂起。
- **它作用于你的代码。** 标准库的 bug 仍然可能导致 UB，因为标准库内部使用原始指针。缓解措施是审计、模糊测试和 `yo unsafe-report` 清单 —— 与 Swift、Go、Java 处理它们 unsafe 内部的方法相同。
- **FFI 是调用方的问题。** 用错误的参数类型调用 C 函数或违反它的前置契约是 C 层面的 UB。包在 extern 调用外的 `unsafe(...)` 是逐站点的审查标记；它并不验证契约。
- **跨线程的数据竞争**由 `Send` / `Iso(T)` / `Arc(T)` 处理，不在这个模型中。它们是正交的。
- **在 `pragma(Pragma.AllowUnsafe);` 文件内部**，所有保证都失效 —— 这正是 opt-in 的意义。你接受文件内所有内容的审计责任。

定调：**安全的 Yo 代码无法违反内存安全。Unsafe 表面被限定在显式通过 pragma opt-in 的文件中 —— 主要是标准库 —— 它规模小、按发布版审计、有模糊测试覆盖。**

## 延伸阅读

- `plans/MEMORY_SAFETY.md` —— 安全模型的设计文档。覆盖完整的理由、阶段化推进和考虑过的替代方案。
- [FLOWABILITY.md](./FLOWABILITY.md) —— 面向用户的 `ref`/借用规则（流动性 + 借用失效）。
- `plans/archive/SLICE_REWORK.md` —— 移除堆切片的设计（内建 `str`、拷贝式区间）。
- `plans/archive/EXTERN_UNSAFE_WRAP.md` —— 对 extern "c" 函数调用要求逐调用包装的设计。
- `plans/archive/ITERATOR_REDESIGN.md` —— 安全模型下迭代如何工作。
- `docs/zh-CN/DESIGN.md` —— 更广的语言设计；指针 / unsafe 部分与本页交叉引用。
