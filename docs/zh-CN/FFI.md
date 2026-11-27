# FFI：`c_include` 与 `extern`

Yo 通过两种声明形式访问 C。两者都是特权操作——文件需要
`pragma(Pragma.AllowUnsafe);`——并且每一次 `extern "c"` 函数调用都要在调用处包上
`unsafe(...)`（见 [MEMORY_SAFETY.md](MEMORY_SAFETY.md)）。

- `c_include("<header.h>", name : Type, ...)` 声明某个 C 头文件提供的符号。代码生成会在用到
  它们的地方 `#include` 该头文件。
- `extern("c", name : Type, ...)` 声明没有头文件的 C 符号（由你自行链接）。
  `extern("Yo", ...)` 声明 Yo 自身 C 运行时的符号。

## 两种形式都求值为模块值

`c_include(...)` 或 `extern(...)` 调用是一个表达式，其值是一个**模块**——与
`import("...")` 产生的值同类。它的成员不会自动进入作用域；你要像对待 import 一样，
绑定这个模块，或者解构它：

```yo
pragma(Pragma.AllowUnsafe);

// 绑定模块，逐个限定访问。
c :: c_include(
  "<stdio.h>",
  FILE : Type,
  stdout : *FILE,
  fputs : (fn(s : *char, stream : *FILE) -> int)
);
unsafe(c.fputs((*char)("hello\n"), c.stdout));

// 只挑选需要的成员——并可以重命名。
{ strlen : c_strlen } :: c_include("<string.h>", strlen : (fn(s : *char) -> usize));
n := unsafe(c_strlen((*char)("hello")));

// 全部按原名引入（glob）。
{ ... } :: c_include("<stdlib.h>", abs : (fn(x : int) -> int));
```

重命名就是普通的解构重命名 `{ c_name : yo_name }`。它对函数、全局量（`{ M_PI : pi }`）
和不透明类型（`{ FILE : CFile }`）都有效：生成的 C 始终使用 C 符号名。

字段的类型可以引用同一声明中更早的字段（`FILE : Type, stdout : *FILE`）。

## 裸语句即 glob

当 `c_include(...)` 或 `extern(...)` 作为语句出现——在文件顶层，或作为块中的一行——它是其
glob 解构的语法糖：

```yo
c_include("<stdlib.h>", abs : (fn(x : int) -> int));
// 完全等价于
{ ... } :: c_include("<stdlib.h>", abs : (fn(x : int) -> int));
```

所以熟悉的写法仍然把列出的每个名字声明进当前作用域，而函数体内的声明只在该函数体内可见。

## 禁止遮蔽

因为这些名字是通过绑定进入作用域的，禁止遮蔽规则对它们同样适用：声明的名字如果在作用域中
已经可见，就是错误，无论谁先谁后。

```yo
abs :: (fn(x : i32) -> i32)(x);
c_include("<stdlib.h>", abs : (fn(x : int) -> int));
// error: Variable "abs" is already defined here (variable shadowing is not allowed)
```

解决办法是限定访问（`libc :: c_include(...)`，然后 `libc.abs`）或重命名
（`{ abs : c_abs } :: c_include(...)`）。

## 定义顺序

声明语句和任何 `::` 绑定一样是惰性的顶层定义（见 [MODULES.md](./MODULES.md#定义顺序)）：
定义在它上方的函数可以调用它绑定的名字，包括重命名后的名字。

## `std/libc` 模块

`std/libc/*` 按头文件逐个包装了常用头文件，所以大多数程序不需要自己写 `c_include`：

```yo
{ strlen, memcpy } :: import("std/libc/string");
fcntl :: import("std/libc/fcntl"); // fcntl.open、fcntl.O_RDONLY
```

## 名字不是 Yo 标识符的 C 类型

不透明的 `Name : Type` 字段会降低为拼写为 `Name` 的 C 类型。当 C 拼写不是合法的 Yo 标识符
（`struct stat`、`struct timespec`）时，用 `c_type` 显式给出：

```yo
{ stat_buf, stat } :: c_include(
  "<sys/stat.h>",
  stat_buf : c_type("struct stat"),
  stat : (fn(pathname : *char, statbuf : *stat_buf) -> int)
);
```

`stat_buf` 在 Yo 里是不透明类型，在生成的 C 里是 `struct stat`，所以 `*stat_buf` 参数就是
`struct stat*`。

如果你只是要把自己分配的缓冲区（例如按结构体大小开的 `ArrayList(u64)`）交给 C 函数，把参数
拼写为 `*void`，并用 `(*void)(ptr)` 转换缓冲区指针：C 会把 `void *` 隐式转换为任意对象指针。
不要把它拼写成缓冲区元素类型的指针。Yo 不会为 `c_include` 函数生成自己的原型——头文件里的
原型是唯一的——所以与头文件不一致的参数类型在调用处就是不兼容的指针类型，C 编译步骤会在
所有平台上用 `-Werror=incompatible-pointer-types` 拒绝它。用 `c_type` 拼写采纳 Yo 结构体（`Point : c_type("struct point")`，其中
`Point` 是一个 Yo `struct`）会把该 Yo 类型降低为该拼写。

## 限制

- 把 Yo 结构体采纳为 C 结构体（`Point : Type`，而 `Point` 已经是一个 Yo `struct`）会把该
  Yo 类型降低为 C 名字且不生成自己的定义；布局以头文件的定义为准。这样的字段就是已有的类型
  本身，所以 glob 会保留已有的 `Point` 绑定，而不是重新绑定它（那会被禁止遮蔽规则拒绝）。

## 指针

Yo 使用指针 (`*(T)`) 进行直接内存访问，类似 C。对原始指针的解引用、算术运算等危险操作需要显式 `unsafe(...)` 包装 — 详见下文 [内存安全](#内存安全)。

```yo
// 指针类型：*(T)
x := 1;
y := 2;

swap :: (fn(a : *i32, b : *i32) -> unit)(
  unsafe({
    tmp := a.*; // 解引用指针
    a.* = b.*;
    b.* = tmp;
  })
);

swap(addr_of(x), addr_of(y)); // 传入 x 和 y 的指针
// 现在 x == 2, y == 1
```

日常的就地修改应优先使用 `name : &mut T` 参数形式（见[Type Methods](./FUNCTIONS.md#类型方法)）——它在 C 中降为相同的 `T*` ABI，但保持安全，调用方用 `&mut` 借出位置（`swap(&mut x, &mut y)`），而不是取裸地址。原始 `*(T)` 仅保留给 FFI 和本节涉及的底层场景。

当 `x` 是 `&T` 参数或其中的位置（`addr_of(x.field)`）时，`addr_of(x)` 是错误 E0921：`&T` 参数作为调用方值的副本传入，因此它的地址是被调用方的副本，调用返回后即悬空。需要调用方地址的代码应接受 `x : *T` 并由调用方传入 `addr_of(place)`，或接受按指针传递的 `x : &mut T`。投影（返回 `&T` 或 `&mut T` 的函数）的 `&T` 参数按指针传递，保留 `addr_of`；prelude 中 `Array` 的 `Index` 实现正是这样取得元素的。

### 指针操作

```yo
// 使用 addr_of 创建指针
x := 42;
ptr := addr_of(x); // ptr: *(i32)
// 使用 .* 解引用（需要 unsafe — 可能读取无效内存）
value := unsafe(ptr.*); // value == 42
// 通过指针修改（需要 unsafe — 可能写入悬空指针）
unsafe(ptr.* = 100); // x 现在是 100
// 指针算术（需要 unsafe — 可能产生越界地址）
arr := [1, 2, 3, 4, 5];
ptr := addr_of(arr(0)); // 指向第一个元素的指针
ptr2 := unsafe(ptr.add(2)); // 指向第三个元素
value := unsafe(ptr2.*); // value == 3
// 指针类型转换（安全 — 只修改地址的类型标签）
float_ptr := (*f32)(ptr); // 将指针转换为 *(f32)
```

### 指针算术与比较

指针算术使用方法 — `p.add(n)`、`p.sub(n)`、`p.offset_from(q)` — 需要 `unsafe(...)` 包装；指针比较使用普通运算符（`==`、`!=`、`<`、`<=`、`>`、`>=`，经由 `*(T)` 上的 `Eq`/`Ord` impl）并保持安全 — 比较地址本身不会破坏内存安全。注意 `*(T) ==` 比较的是地址（同一性），而 `Rc(T)` 这样的句柄通过自己的 `Eq` impl 比较值。

```yo
pragma(Pragma.AllowUnsafe); // 原始指针需要 unsafe 能力的 pragma
{ assert } :: import("std/assert");

test("Pointer arithmetic", {
  x := 12;
  p := addr_of(x);

  // 加法和减法（需要 unsafe — 可能产生越界地址）
  q := unsafe(p.add(2)); // 指针前进 2 个元素
  z := unsafe(q.sub(2)); // 指针后退 2 个元素
  // 比较运算符（安全 — 地址只是数据）
  assert(q > p); // q 在 p 之后
  assert(p < q); // p 在 q 之前
  assert(q >= p); // 大于等于
  assert(p <= q); // 小于等于
  assert(z == p); // 相等（相同地址）
  assert(p != q); // 不相等
  // 指针差值同样需要 unsafe（假定两指针指向同一对象）
  diff := unsafe(q.offset_from(p)); // 距离：2 个元素
  assert(diff == 2);
});
```

### 指针操作参考

算术（方法，需要 `unsafe(...)`）：

- `p.add(n)` ：前进 `n` 个元素
- `p.sub(n)` ：后退 `n` 个元素
- `p.offset_from(q)` ：带符号的元素距离（`isize`）

比较（普通运算符，经由 `*(T)` 上的 `Eq`/`Ord` impl，安全）：

- `==` / `!=` ：地址相等 / 不等
- `<` / `<=` / `>` / `>=` ：地址排序

### consume 函数

`consume` 告诉编译器你正在初始化内存，而不是覆盖已有的值。这可以防止尝试 drop 未初始化的内存：

```yo
// 不使用 consume - 错误：尝试 drop 未初始化的值
ptr.* = some_value; // 危险！
// 使用 consume - OK：初始化，不 drop
consume(ptr.* = some_value);
```

对其他任何参数，`consume(x)` 会移动 `x`（之后再使用会报 "use of moved value"）；由于它返回 `unit`，它就是该值的最后一个所有者：被拥有的值在 consume 处释放，与 `drop(x)` 的释放完全相同。不拥有其值的绑定（`&T` 借用）只会被标记为已移动。

更多指针示例请参阅 `tests/ptr.test.yo`。

### 可空指针

Yo 使用 `Option(*(T))` 来表示可空指针：

```yo
// malloc 返回 Option(*(T))
some_ptr := malloc(size_of(i32));
match(
  some_ptr,
  .Some(ptr) => {
    ptr.* = 42;
    printf("value: %d\n", ptr.*);
    free(some_ptr);
  },
  .None => printf("Allocation failed\n")
);
```

**注意**：裸指针是不安全的。请尽可能使用 `Rc`、`Arc`、`Box` 和拥有所有权的集合来进行安全的内存管理。

### 句柄的 `Option` 就是一个指针

当 `T` 是裸指针**或**计数或装箱的句柄（`Rc`、`Arc`、`Box`）时，`Option(T)` 直接编译为裸指针，用 `NULL` 表示 `.None`。同样的 niche 优化也适用于「一个无字段变体 + 一个单字段句柄载荷」的二变体枚举。没有 tag 字、没有额外填充：`size_of` 就是指针本身的大小，对这类值的 `match` 编译为一次 NULL 判断。

```yo
pragma(Pragma.AllowUnsafe); // 仅为让 size_of 能写出指针类型

sz_opt :: size_of(Option(*i32)); // == size_of(*i32) —— 就是指针本身
sz_str :: size_of(String); // == size_of(*u8)   —— 就是句柄本身
Tree :: enum(Empty, Node(child : Rc(Self)));
sz_tree :: size_of(Tree); // == size_of(*u8)   —— NULL 即 Empty
```

### 内存安全

面向用户的指南见 [MEMORY_SAFETY.md](MEMORY_SAFETY.md) —— 覆盖默认安全的契约、`&mut T` 参数、`pragma(Pragma.AllowUnsafe);` opt-in、`unsafe(...)` 逐操作包装、`// SAFETY:` 注释约定、`yo unsafe-report`、`unwrap` 禁令，以及整数算术规则（溢出、除以零和越界移位都会中止程序）。

所有权、移动与拷贝、`&T`/`&mut T` 引用及其来源，以及编译器检查的借用规则，见 [OWNERSHIP_AND_BORROWING.md](OWNERSHIP_AND_BORROWING.md)。

Yo 的安全模型是分层的（设计计划见 `plans/reference/MEMORY_SAFETY.md`）：

- **`Rc(T)`** 是引用计数的单元，在最后一个句柄处自动释放（环会泄漏，除非用 `Weak` 打破），从构造上保证内存安全。
- **`Arc(T)`** 提供跨线程的原子 RC 共享所有权；`Send` 值通过移动转移到另一个线程。
- **`*(T)` 原始指针**的解引用、算术运算和「穿透指针的 `consume`」操作必须显式包裹在 `unsafe(...)` 中，否则编译报错。

`unsafe(...)` 是一个普通的内建函数调用，接受一个表达式作为参数。它纯粹是编译时标记 — 在代码生成阶段会被还原为其内部表达式，没有运行时开销。

```yo
// 指针解引用需要 unsafe：
read :: (fn(p : *i32) -> i32)(unsafe(p.*));

// 指针算术同样：
advance :: (fn(p : *i32, n : usize) -> *i32)(unsafe(p.add(n)));

// 使用块的多语句 unsafe：
write_and_read :: (fn(p : *i32, v : i32) -> i32)(
  unsafe({
    p.* = v;
    p.*
  })
);

// 指针比较（==、< 等）和 *(T) 类型转换（如 (*u8)(p)）
// 保持安全 — 它们不解引用，因此不被门控。
```

**需要 `unsafe(...)` 的操作**：指针解引用（`.*`）、指针算术（`.add(n)`、`.sub(n)`、`.offset_from(q)`）、对指针解引用的 `consume(p.* = v)`。

**仍然安全的操作**：取地址（`addr_of(x)`）、传递/存储/返回指针、指针比较（`<`、`==` 等）、指针类型转换（`(*u8)(p)`）、`asm(...)`（本身已经隐式不安全）。

不安全表面是可 grep 的：每个 `unsafe(` token 都标记了一处原始内存操作。文件必须在顶部声明 `pragma(Pragma.AllowUnsafe);` 才能使用 `unsafe(...)` 或执行原始指针操作。`std/`、`src/` 和 `tests/` 下的文件都显式声明了此 pragma；用户代码（`main.yo` 及项目中的其他文件）默认是安全模式，若尝试使用 `unsafe(...)` 将得到编译错误。

如需一目了然地审计，运行 `yo unsafe-report`（或 `yo unsafe-report ./std` 仅扫描标准库）。它列出每一处 `unsafe(...)` 站点、`asm(...)` 块、`extern(...)` 声明以及声明 pragma 的文件，带 `file:line:col` 跳转格式以方便编辑器查看。`--json` 标志输出机器可读格式，便于 CI 集成。

```yo ignore
// 没有 pragma 的文件 — `unsafe(...)` 被拒绝：
main :: (fn() -> unit)({
  x := i32(42);
  v := unsafe(x); // error: 'unsafe(...)' is not available in safe code.
  //        To use raw pointer operations, declare at the top:
  //            pragma(Pragma.AllowUnsafe);
});
```

```yo
// 在文件顶部添加 pragma 即可启用：
pragma(Pragma.AllowUnsafe);

main :: (fn() -> unit)({
  x := i32(42);
  p := addr_of(x);
  v := unsafe(p.*); // OK
});
```

### `&mut` 参数

要在不使用原始指针的情况下实现原地修改，请使用 `name : &mut T` 参数。`&mut` 加在参数类型之前，参数行为类似于调用方变量的绑定 — 读取访问当前值，写入更新调用方的存储。在代码生成时 `name : &mut T` 在 C 中降低为 `T*`；调用方用 `&mut x` 借出该位置，编译器传递它的地址。

```yo
{ assert } :: import("std/assert");

swap :: (fn(a : &mut i32, b : &mut i32) -> unit)({
  tmp := a.*;
  a.* = b.*;
  b.* = tmp;
});

increment :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + i32(1));
});

main :: (fn() -> unit)({
  mut(x) := i32(1);
  mut(y) := i32(2);
  swap(&mut x, &mut y); // 调用点用 `&mut` 借出每个位置
  assert(x == i32(2), "swapped");
  assert(y == i32(1), "swapped");

  mut(counter) := i32(0);
  increment(&mut counter);
  increment(&mut counter);
  assert(counter == i32(2), "incremented");
});
```

`&mut T` 参数不能与 `sink(...)`（相反的调用约定）或 `generic(...)` 组合使用；编译期参数把模式写在类型上（`comptime(x) : &mut T`）。对于链式调用，将 `&mut T` 参数传递给另一个函数的 `&mut T` 参数按预期工作（该参数本身已持有借用，所以直接书写）：

```yo
double :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + n.*);
});

double_both :: (fn(x : &mut i32, y : &mut i32) -> unit)({
  double(x); // 将借用透传给 double 的 `&mut` 参数
  double(y);
});
```

### RAII（资源获取即初始化）

Yo 自动管理内存：拥有所有权的值在其所有者的作用域结束时被 drop，计数单元（`Rc`、`Arc`）在引用计数降为零时被释放。

```yo
test :: (fn() -> unit)({
  x := String.from("World!"); // RC = 1
  // ... 使用 x ...
  // 作用域结束时，RC 递减
  // 如果 RC 降为 0，内存自动释放
});
```
