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

```rust
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

```rust
c_include("<stdlib.h>", abs : (fn(x : int) -> int));
// 完全等价于
{ ... } :: c_include("<stdlib.h>", abs : (fn(x : int) -> int));
```

所以熟悉的写法仍然把列出的每个名字声明进当前作用域，而函数体内的声明只在该函数体内可见。

## 禁止遮蔽

因为这些名字是通过绑定进入作用域的，禁止遮蔽规则对它们同样适用：声明的名字如果在作用域中
已经可见，就是错误，无论谁先谁后。

```rust
abs :: (fn(x : i32) -> i32)(x);
c_include("<stdlib.h>", abs : (fn(x : int) -> int));
// error: Variable "abs" is already defined here (variable shadowing is not allowed)
```

解决办法是限定访问（`libc :: c_include(...)`，然后 `libc.abs`）或重命名
（`{ abs : c_abs } :: c_include(...)`）。

## 定义顺序

声明语句和任何 `::` 绑定一样是惰性的顶层定义（见 [DEFINITION_ORDER.md](DEFINITION_ORDER.md)）：
定义在它上方的函数可以调用它绑定的名字，包括重命名后的名字。

## `std/libc` 模块

`std/libc/*` 按头文件逐个包装了常用头文件，所以大多数程序不需要自己写 `c_include`：

```rust
{ strlen, memcpy } :: import("std/libc/string");
fcntl :: import("std/libc/fcntl");   // fcntl.open、fcntl.O_RDONLY
```

## 限制

- 不是合法 Yo 标识符的 C 名字（`struct stat`、`struct timespec`）不能声明为类型；这类对象
  请以 `*(void)` 传递。
- 把 Yo 结构体采纳为 C 结构体（`Point : Type`，而 `Point` 已经是一个 Yo `struct`）会把该
  Yo 类型降低为 C 名字且不生成自己的定义；布局以头文件的定义为准。
