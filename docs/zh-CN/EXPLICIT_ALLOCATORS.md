# 显式分配器

Yo 用引用计数管理内存：对象在最后一个引用消失时被释放。**显式分配器**提供了另一个
相互独立的选择：对象的字节放在**哪里**。你可以把一次计算产生的所有对象放进一个
分配器，统计某个库的每一次分配，或者给一个子系统单独的内存预算，而对象的用法和释放
时机都不会改变。

- [模型](#模型)
- [快速上手](#快速上手)
- [放置：`alloc` 参数](#放置alloc-参数)
- [容器](#容器)
- [何时使用显式分配器](#何时使用显式分配器)
- [线程与异步任务](#线程与异步任务)
- [编写自己的分配器](#编写自己的分配器)
- [底层 `Allocator` API](#底层-allocator-api)
- [调试：泄漏报告](#调试泄漏报告)
- [开销](#开销)
- [限制](#限制)

## 模型

**分配器决定放置位置，引用计数决定生命周期。** 这是两件独立的事：

- 由显式分配器放置的对象，依然在最后一个引用消失时立刻释放，与其他对象完全一样。
  不会有任何东西在“分配器消失时”背着你被释放。
- 释放总是把内存块还给创建它的分配器。每个块在返回指针前面都带有一个所有者前缀
  （16 字节；块的对齐更大时取其对齐），所以即使在另一个线程释放，或者在创建它的代码早已返回之后释放，块
  也会回到正确的地方。不可能把块释放到错误的分配器里。

Yo 不检查的是分配器自身的生命周期：它的上下文和 vtable 必须比它分配出去的每个块
活得更久（见[编写自己的分配器](#编写自己的分配器)）。

**默认全局，放置靠参数。** 不带分配器参数的创建总是使用全局分配器。调用方无法设置
分配作用域：`ArrayList(i32).new()` 或 `Rc.new(v)` 这样的调用做什么，从不取决于它的调用者。
放到其他分配器中的每一次放置，都以一个参数的形式出现在创建处。

## 快速上手

`Allocator` 是一个值。`Allocator.global()` 是作为这种值的全局分配器，
[编写自己的分配器](#编写自己的分配器)给出了一个计数分配器；下面的代码对两者的放置
方式相同。

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");

Point :: struct(x : i32, y : i32);

main :: (fn() -> unit)({
  a := Allocator.global();
  {
    // 一个单元，由它的 `alloc` 参数放在 `a` 中。
    p := Rc.new(Point(x : i32(3), y : i32(4)), alloc : .Some(a));
    // 一个列表，它的缓冲区及其每一次增长都在 `a` 中。
    mut(xs) := ArrayList(i32).new(alloc : .Some(a));
    xs.push(p.x);
    // 没有参数：全局分配器。
    mut(ys) := ArrayList(i32).new();
    ys.push(p.y);
    println(`${xs.len() + ys.len()}`); // 2
  };
  // `p` 和 `xs` 都已消失，它们的块已经回到 `a`。
});
export(main);
```

## 放置：`alloc` 参数

句柄构造函数 `Box.new`、`Rc.new` 和 `Arc.new`（写出类型时为 `Box(T).new`、`Rc(T).new`、
`Arc(T).new`）接受可选的 `alloc : Option(Allocator)`。`.Some(a)` 把单元放在 `a`
中；默认值 `.None` 把它放在全局分配器上。单元通过放置它的分配器释放，无论最后一个
句柄在哪个线程上被 drop。Yo 不会把值自动包装成 `Option`，所以调用方要写
`.Some(...)`：

```yo
// `a` 是任意 `Allocator` 值。
b := Box.new(i32(1), alloc : .Some(a));
r := Rc.new(i32(2), alloc : .Some(a));
c := Arc.new(i32(3), alloc : .Some(a));
```

一个允许调用方放置其所创建对象的函数，声明同样带默认值的参数并把它传下去。
`Allocator`、`Option(Allocator)` 以及持有它的结构体都是不透明句柄，因此在安全文件
（没有 `pragma(Pragma.AllowUnsafe)` 的文件）中可以作为参数类型；而使用句柄的裸字段，
例如 `a.alloc(n, align)`，仍然需要该 pragma：

```yo
{ ArrayList } :: import("std/collections/array_list");

Node :: struct(name : i32, kids : ArrayList(i32));
make_node :: (fn(name : i32, (alloc : Option(Allocator)) ?= .None) -> Rc(Node))(
  Rc.new(Node(name : name, kids : ArrayList(i32).new(alloc : alloc)), alloc : alloc)
);
```

程序中不带这种参数创建的一切都是全局的：

- `ref` struct 和 `ref` enum 的构造（要放置它，把它改成值结构体再包装：
  `Rc.new(v, alloc : .Some(a))`），
- `dyn` 为值创建的单元（`dyn(Rc.new(v, alloc : .Some(a)))` 放置的是 `Dyn` 的数据对象：
  `Rc` 单元被原样使用，不会再建第二个单元），
- 插值字符串（用 `StringBuilder.new(alloc : .Some(a))` 构建一个被放置的字符串），
- 闭包环境，
- `io.async` 任务的状态机，
- 运行时自身的簿记（事件循环结构、线程池）。

`Box.new` 直接调用 `a` 的 `alloc`。`Rc.new` 和 `Arc.new` 在这一次构造期间把 `a` 设为当前线程的
分配作用域（直到单元原语自己接受分配器为止），所以用于 `Rc.new` 或 `Arc.new` 的分配器必须
遵守[编写自己的分配器](#编写自己的分配器)中的回调规则。

## 容器

可变容器的构造函数接受与 `Box.new`、`Rc.new`、`Arc.new` 相同的带默认值参数
`alloc : Option(Allocator)`。不带它时容器是全局的，建立在它们之上的类型（`String`、
插值）也一样：

| 容器            | 接受 `alloc` 的构造函数                          | 放置的副本     |
| --------------- | ------------------------------------------------ | -------------- |
| `ArrayList(T)`  | `new(alloc : …)`、`with_capacity(n, alloc : …)`  | `clone_in(a)`  |
| `HashMap(K, V)` | `new(alloc : …)`、`with_capacity(n, alloc : …)`  | `clone_in(a)`  |
| `HashSet(T)`    | `new(alloc : …)`、`with_capacity(n, alloc : …)`  |                |
| `Deque(T)`      | `new(alloc : …)`                                 |                |
| `StringBuilder` | `new(alloc : …)`、`with_capacity(n, alloc : …)`  | `clone_in(a)`  |
| `String`        |                                                  | `clone_in(a)`  |

```yo
{ ArrayList } :: import("std/collections/array_list");

main :: (fn() -> unit)({
  a := Allocator.global(); // 任意 `Allocator` 值
  mut(xs) := ArrayList(i32).with_capacity(usize(8), alloc : .Some(a));
  xs.push(i32(1));
  ys := xs.clone_in(Allocator.global()); // 显式放置的副本
  ys.push(i32(2));
});
export(main);
```

容器会记住它的分配器。缓冲区的每一次增长、收缩和最终释放，都回到创建它时的分配器。
`xs.allocator()` 返回这个分配器；对使用全局分配器的容器返回 `.None`。`clone()` 的
结果放在源值所在的位置：显式分配器中的列表、映射或 `String` 的克隆仍在同一个分配器
中，全局容器的克隆是全局的。`clone_in(a)` 则把副本的缓冲区放在 `a` 中，无论源值在
哪里；被复制的元素放在它们自己的 `clone` 所放的位置。

被放置的容器在构造时就分配一次（`ArrayList`、`Deque` 和 `StringBuilder` 分配一个只
含所有者前缀的块，`HashMap` 分配它的 16 个桶），因为容器靠缓冲区记住分配器。全局的
`new()` 在第一次插入之前不分配任何内存。

**v0.2.73 之前**，放置用的构造函数是单独的函数。它们已被删除，请这样改写每个调用：

| 以前                                  | 现在                                              |
| ------------------------------------- | ------------------------------------------------- |
| `ArrayList(T).new_in(a)`              | `ArrayList(T).new(alloc : .Some(a))`              |
| `ArrayList(T).with_capacity_in(a, n)` | `ArrayList(T).with_capacity(n, alloc : .Some(a))` |
| `HashMap(K, V).new_in(a)`             | `HashMap(K, V).new(alloc : .Some(a))`             |
| `HashSet(T).with_capacity_in(a, n)`   | `HashSet(T).with_capacity(n, alloc : .Some(a))`   |
| `Deque(T).new_in(a)`                  | `Deque(T).new(alloc : .Some(a))`                  |
| `StringBuilder.new_in(a)`             | `StringBuilder.new(alloc : .Some(a))`             |

容器自身的大小不变：分配器记录在缓冲区的所有者前缀里，只用一个已有字段中的一位来
标记。

## 何时使用显式分配器

在引用计数下，分配器改变的是字节**从哪里来**，而不是内存管理工作的多少：每一次引用
计数更新和每一次释放仍然会发生。它真正带来的是：

- **统计。** 计数分配器显示一个库、一个子系统或一个测试分配了什么，以及是否全部
  归还。
- **预算。** 分配器可以返回 `.None` 拒绝一次请求；容器的 `try_` 操作把它报告为
  `AllocError.OutOfMemory`。
- **局部性。** 从一块区域分配的分配器让一段工作的对象挨在一起。

它不是通用的提速手段：全局分配器（mimalloc）的快速路径已经很快，在期待提速之前先
测量。

std 目前不提供 arena。`std/arena` 已于 2026-10-24 删除；`FixedBufferAllocator` 和
`ArenaAllocator` 在计划中（`plans/backlog/ZIG_STYLE_ALLOCATORS.md`）。在此之前，
按[编写自己的分配器](#编写自己的分配器)写出你需要的分配器。

## 线程与异步任务

`Allocator` 是两个字长的值，且是 `Send`，所以只要它自己的回调是线程安全的，一个
分配器就可以服务多个线程。把 `Allocator` 值传进线程，在那里放置：

```yo
{ println } :: import("std/fmt");
{ Thread } :: import("std/thread");

Point :: struct(x : i32, y : i32);

main :: (fn() -> unit)({
  a := Allocator.global(); // 任意 `Allocator`：它是 `Send`
  t := Thread(i32).spawn(io => {
    p := Rc.new(Point(x : i32(1), y : i32(2)), alloc : .Some(a));
    p.x + p.y
  });
  println(`${t.join()}`);
});
export(main);
```

**任务总是全局的。** `io.async` 任务的状态机位于全局分配器上。任务创建的对象由它们
自己的创建处决定放置，与其他地方一样。

## 编写自己的分配器

分配器是一个上下文指针加一张包含三个函数的表。这两个类型都在 prelude 中，无需导入；
它们的方法（`Allocator.global()`、`alloc`、`free` 等）由 `std/allocator` 提供：

```yo
AllocatorVTable :: struct(
  alloc : (fn(ctx : ?*void, size : usize, align : usize) -> ?*void),
  realloc : (fn(ctx : ?*void, ptr : ?*void, old_size : usize, new_size : usize, align : usize) -> ?*void),
  free : (fn(ctx : ?*void, ptr : ?*void, size : usize, align : usize) -> unit)
);
Allocator :: struct(ctx : ?*void, vtable : *AllocatorVTable);
```

这是接口第 2 版，即 Zig 的 `std.mem.Allocator` 的调用方式。约定：

- `alloc(ctx, size, align)` 返回至少 `size` 字节、按 `align` 对齐的块，或 `.None`。
  `align` 是 2 的幂，至少为 16。
- `realloc(ctx, ptr, old_size, new_size, align)` 调整由该 vtable 的 `alloc` 以
  `old_size` 字节、`align` 对齐返回的块的大小，保留前 `min(old_size, new_size)` 个
  字节。返回 `.None` 时原块保持不变，仍归调用者所有。
- `free(ctx, ptr, size, align)` 释放这样的块。`size` 和 `align` 就是该块分配（或最后
  一次重新分配）时的值，所以按尺寸分级的分配器（例如内存池）不需要自己的块头。
- 块可能在另一个线程上被释放（在那里 drop 的 `Arc`），所以被多个线程共享的分配器
  要让它的 `free` 线程安全。
- 回调不能创建不带 `alloc` 参数的引用计数对象：其中不能有 `ref` 构造器，也不能有
  不带 `alloc` 的 `Rc.new`、`Arc.new` 或 `dyn`。在 `Rc.new(v, alloc : .Some(a))` 和
  `Arc.new(v, alloc : .Some(a))` 中，回调运行时当前线程的分配作用域正是它自己的分配器，
  这样的分配会再次调用 `alloc`，递归直到栈溢出。容器、`String` 和 `Box.new(...)` 是全局的，
  可以放心使用。请从 `GlobalAllocator` 或你自己持有的缓冲区获取内存，如下面的示例
  所示。

你的函数永远看不到所有者前缀：`std/allocator` 向你的 `alloc` 申请前缀
（`max(16, align)` 字节）加上调用方所需的字节，按 `max(16, align)` 对齐，并自己管理
前缀。由 `alloc` 参数放置的引用计数单元在所有者前面还多带 16 字节，记录单元的大小和
对齐供释放使用，所以它的前缀是 `max(32, align)` 字节。实现分配器需要处理裸指针，所以
文件需要 `pragma(Pragma.AllowUnsafe);`；通过 `alloc` 参数*使用*分配器则不需要。

一个转发给全局分配器的计数分配器：

```yo
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ GlobalAllocator } :: import("std/allocator");
{ memcpy } :: import("std/libc/string");

Point :: struct(x : i32, y : i32);
_Counts :: struct(allocs : usize, frees : usize);

// 全局分配器的对齐分配族能满足任意对齐，释放时同样会被告知对齐。
_count_alloc :: (fn(ctx : ?*void, size : usize, align : usize) -> ?*void)({
  c := (*_Counts)(ctx.unwrap());
  unsafe(c.*.allocs = (c.*.allocs + usize(1)));
  GlobalAllocator.aligned_alloc(align, size)
});
_count_realloc :: (fn(ctx : ?*void, ptr : ?*void, old_size : usize, new_size : usize, align : usize) -> ?*void)(
  match(
    GlobalAllocator.aligned_alloc(align, new_size),
    .Some(q) => {
      n := cond((old_size < new_size) => old_size, true => new_size);
      unsafe(memcpy(q, ptr.unwrap(), n));
      GlobalAllocator.aligned_free(ptr);
      .Some(q)
    },
    .None => .None
  )
);
_count_free :: (fn(ctx : ?*void, ptr : ?*void, size : usize, align : usize) -> unit)({
  c := (*_Counts)(ctx.unwrap());
  unsafe(c.*.frees = (c.*.frees + usize(1)));
  GlobalAllocator.aligned_free(ptr);
});
_COUNT_VTABLE := AllocatorVTable(alloc : _count_alloc, realloc : _count_realloc, free : _count_free);

main :: (fn() -> unit)({
  counts := _Counts(allocs : usize(0), frees : usize(0));
  a := Allocator(ctx : .Some((*void)(addr_of(counts))), vtable : addr_of(_COUNT_VTABLE));
  {
    p := Rc.new(Point(x : i32(3), y : i32(4)), alloc : .Some(a));
    println(`${p.x}`);
  };
  println(`allocs=${counts.allocs} frees=${counts.frees}`); // allocs=1 frees=1
});
export(main);
```

vtable 必须比它分配出去的每个块活得更久，模块级的 `:=` 绑定满足这一点。上下文也
一样：这里的 `counts` 一直活到 `main` 返回，而内层代码块已经先释放了 `p`。

## 底层 `Allocator` API

以下调用都会交出或接收裸指针，因此都需要 `pragma(Pragma.AllowUnsafe);`：

| 调用                            | 作用                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| `Allocator.global()`            | 把全局分配器作为 `Allocator` 值。                                    |
| `a.alloc(size, align)`          | 由 `a` 拥有的 `size` 字节，按 `align`（至少 16）对齐，或 `.None`；`align` 不是 2 的幂时也返回 `.None`。 |
| `Allocator.realloc(ptr, old_size, new_size, align)` | 通过拥有该块的分配器调整块的大小。               |
| `Allocator.free(ptr, size, align)` | 把块还给拥有它的分配器。`.None` 不做任何事。                      |
| `Allocator.owner_of(ptr)`       | 拥有该块的分配器。                                                   |
| `a.same(b)`                     | 两个值是否是同一个分配器。                                           |

`realloc` 和 `free` 通过所有者前缀找到分配器，所以不接收分配器参数；它们接收该块分配
时的大小和对齐，并转告给分配器。不要把不是来自 `Allocator.alloc`/`realloc` 的指针、
或与该块不符的大小或对齐传给它们，也不要用 `GlobalAllocator.free` 释放这样的块。

## 调试：泄漏报告

用 `--allocator fixed --debug-heap` 编译，退出报告会统计退出时仍然存活的堆块
（`live at exit: N blocks / M bytes`），包括用户分配器从全局分配器取得的块：

```bash
yo compile main.yo --allocator fixed --debug-heap -o app && ./app
```

`yo test` 接受同样的参数。在全局分配器前面放一个计数分配器，可以看出泄漏的块来自
哪个子系统。

## 开销

`ref` 构造器、`dyn` 盒子和 `io.async` 任务仍会检查 `Rc.new` 和 `Arc.new` 为一次构造设置的
线程分配作用域：一次 relaxed 原子读取和一次分支，编译器自举的测量结果在噪声范围内
（`plans/archive/EXPLICIT_ALLOCATORS.md`）。等 `Rc.new` 和 `Arc.new` 通过单元原语放置之后，
这个检查就会删除（`plans/backlog/ALLOCATOR_PLACEMENT.md`，B2）。容器大小不变，因为
分配器存放在缓冲区的前缀里，而不是新增的字段。

只有被放置的块才为所有者付出空间。全局 `Box` 单元在载荷前带一个 8 字节的标志字，就像
`Rc` 单元带有计数；被放置的 `Box` 单元在标志字前面还带 16 字节的所有者前缀。被放置的
`Rc`/`Arc` 单元的前缀是 32 字节（所有者和单元的尺寸记录），被放置的容器缓冲区的前缀是
16 字节。

## 限制

- **std 中没有 arena。** 见[何时使用显式分配器](#何时使用显式分配器)。
- **超对齐的类型。** `Allocator.alloc`、容器和 `Box.new` 会按载荷的对齐申请，所以分配器
  可以满足任意 2 的幂的对齐，对齐超过 16 的类型的全局 `Box` 由对齐分配族提供。全局的
  `Rc`/`Arc` 单元只按 16 对齐，所以这种类型的 `Rc` 或 `Arc` 必须被放置。目前没有 Yo
  类型的对齐超过 16；`extern` C 类型可能超过。
- **不能放置 `ref` 对象。** `ref` 构造器不接受 `alloc` 参数。把类型改成值结构体，
  再用 `Rc.new(v, alloc : .Some(a))` 放置。

设计记录（含测量数据和各阶段的历史）见 `plans/archive/EXPLICIT_ALLOCATORS.md`，
已落地的决定汇总在 `plans/reference/EXPLICIT_ALLOCATORS.md`，放置规则（“默认全局，
放置靠参数”）见 `plans/backlog/ALLOCATOR_PLACEMENT.md`。
