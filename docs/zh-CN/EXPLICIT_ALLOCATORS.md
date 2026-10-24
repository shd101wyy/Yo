# 显式分配器

Yo 用引用计数管理内存：对象在最后一个引用消失时被释放。**显式分配器**提供了另一个
相互独立的选择：对象的字节放在**哪里**。你可以把一次计算产生的所有对象放进一个
分配器，统计某个库的每一次分配，或者给一个子系统单独的内存预算，而对象的用法和释放
时机都不会改变。

- [模型](#模型)
- [快速上手](#快速上手)
- [分配作用域：`with_allocator`](#分配作用域with_allocator)
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
- 释放总是把内存块还给创建它的分配器。每个块在返回指针前面都带有一个 16 字节的
  所有者前缀，所以即使在另一个线程释放，或者在创建它的代码早已返回之后释放，块
  也会回到正确的地方。不可能把块释放到错误的分配器里。

Yo 不检查的是分配器自身的生命周期：它的上下文和 vtable 必须比它分配出去的每个块
活得更久（见[编写自己的分配器](#编写自己的分配器)）。

这些都不需要新语法。`Point(...)` 在分配作用域内外是同一个构造调用，变化的只是它的
字节从哪里来。

## 快速上手

`Allocator` 是一个值。`Allocator.global()` 是作为这种值的全局分配器，
[编写自己的分配器](#编写自己的分配器)给出了一个计数分配器；下面的代码对两者的放置
方式相同。（类型为 `Allocator` 的函数参数目前需要 `pragma(Pragma.AllowUnsafe);`，
因为这个值携带裸指针。）

```yo
{ println } :: import("std/fmt");
{ with_allocator } :: import("std/allocator");
{ ArrayList } :: import("std/collections/array_list");

Point :: ref(struct(x : i32, y : i32));

main :: (fn() -> unit)({
  a := Allocator.global();
  {
    // 作用域内创建的每个 RC 对象和容器缓冲区都来自 `a`。
    p := with_allocator(a, () => Point(x : i32(3), y : i32(4)));
    xs := with_allocator(a, () => {
      ys := ArrayList(i32).new(); // 跟随作用域
      ys.push(p.x);
      ys
    });
    // 在作用域外，显式指定分配器。
    zs := ArrayList(i32).new_in(a);
    zs.push(p.y);
    println(`${xs.len() + zs.len()}`); // 2
  };
  // `p`、`xs` 和 `zs` 都已消失，它们的块已经回到 `a`。
});
export(main);
```

## 分配作用域：`with_allocator`

`with_allocator(a, f)`（`std/allocator`）在 `f` 运行期间（包括 `f` 调用的所有
代码）把 `a` 设为当前线程的当前分配器，并返回 `f` 的结果。`f` 返回或 unwind 时恢复之前的分配器，所以作用域可以嵌套。

在作用域内，以下内容来自 `a`：

- `ref` struct 和 `ref` enum 的构造，
- `rc` 和 `arc`，
- `dyn` 盒子，
- 在作用域内创建的 `io.async` 任务的状态机，
- 在作用域内创建的可变容器的缓冲区（见[容器](#容器)）。

以下内容仍然使用全局分配器：

- 运行时自身的簿记（事件循环结构、线程池），
- 在作用域外创建的对象，即使之后在作用域内使用。

`current_allocator()` 返回作用域设置的当前分配器；没有作用域时返回 `.None`（即全局
分配器）。

## 放置单个单元：`alloc` 参数

`box`、`rc` 和 `arc` 接受可选的 `alloc : Option(Allocator)`，因此不需要作用域也能放置单个
单元。`.Some(a)` 把单元放在 `a` 中；默认值 `.None` 跟随当前作用域，没有作用域时使用
全局分配器。单元通过放置它的分配器释放，无论最后一个句柄在哪个线程上被 drop。Yo
不会把值自动包装成 `Option`，所以调用方要写 `.Some(...)`：

```yo
// `a` 是任意 `Allocator` 值。
b := box(i32(1), alloc : .Some(a));
r := rc(i32(2), alloc : .Some(a));
c := arc(i32(3), alloc : .Some(a));
```

显式的 `alloc` 只对这一个单元优先于当前作用域，之后作用域保持不变。它们到达 `a`
的方式不同：`box` 在调用者的作用域下直接调用 `a` 的 `alloc`；`rc` 和 `arc` 则像
`with_allocator` 一样，在构造期间把 `a` 设为当前作用域（直到单元原语自己接受分配器
为止）。因此在 `a` 的回调内部，`current_allocator()` 对 `box` 是调用者的作用域，对
`rc` 和 `arc` 是 `a`；用于 `rc` 或 `arc` 的分配器必须遵守
[编写自己的分配器](#编写自己的分配器)中的回调规则。

## 容器

可变容器跟随作用域。在 `with_allocator(a, …)` 内创建的 `ArrayList.new()`、
`ArrayList.with_capacity(n)`、`HashMap.new()`、`HashMap.with_capacity(n)` 和
`Deque.new()` 会把缓冲区放在 `a` 中，建立在它们之上的类型（`HashSet`、
`StringBuilder`、`String`）也一样。在任何作用域之外，它们的行为与以前完全相同。

要显式选择分配器（无论有没有作用域），使用 `_in` 构造函数：

| 容器            | 显式构造函数                                             |
| --------------- | -------------------------------------------------------- |
| `ArrayList(T)`  | `new_in(a)`、`with_capacity_in(a, n)`                    |
| `HashMap(K, V)` | `new_in(a)`、`with_capacity_in(a, n)`                    |
| `HashSet(T)`    | `new_in(a)`、`with_capacity_in(a, n)`                    |
| `Deque(T)`      | `new_in(a)`                                              |
| `StringBuilder` | `new_in(a)`、`with_capacity_in(a, n)`                    |

容器会记住它的分配器。缓冲区的每一次增长、收缩和最终释放，都回到创建它时的分配器，
无论那时当前是哪个作用域。`xs.allocator()` 返回这个分配器；对使用全局分配器的容器
返回 `.None`。`clone()` 的结果放在源值所在的位置：显式分配器中的列表、映射或
`String` 的克隆仍在同一个分配器中，即使当时没有活动的作用域。全局容器的克隆跟随当前作用域，
与 `new()` 相同。

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

**作用域是按线程的。** 新建的线程从全局分配器开始，即使它是在作用域内创建的。要在
线程中使用分配器，把 `Allocator` 值传进去，再在那里打开作用域：

```yo
{ println } :: import("std/fmt");
{ with_allocator } :: import("std/allocator");
{ Thread } :: import("std/thread");

Point :: ref(struct(x : i32, y : i32));

main :: (fn() -> unit)({
  a := Allocator.global(); // 任意 `Allocator`：它是 `Send`
  t := Thread(i32).spawn(io => {
    p := with_allocator(a, () => Point(x : i32(1), y : i32(2)));
    p.x + p.y
  });
  println(`${t.join()}`);
});
export(main);
```

`Allocator` 是两个字长的值，且是 `Send`，所以只要它自己的回调是线程安全的，一个
分配器就可以服务多个线程。

**任务保留它的作用域。** 在 `with_allocator` 内创建的 `io.async` 任务，每次挂起后
恢复时都带着同一个作用域，无论事件循环恢复它时当前是哪个作用域。即使
`with_allocator` 已经返回，任务之后做的工作仍然落在那个分配器里。

## 编写自己的分配器

分配器是一个上下文指针加一张包含三个函数的表。这两个类型都在 prelude 中，无需导入；
它们的方法（`Allocator.global()`、`alloc`、`free` 等）由 `std/allocator` 提供：

```yo
AllocatorVTable :: struct(
  alloc : (fn(ctx : ?*void, size : usize) -> ?*void),
  realloc : (fn(ctx : ?*void, ptr : ?*void, new_size : usize) -> ?*void),
  free : (fn(ctx : ?*void, ptr : ?*void) -> unit)
);
Allocator :: struct(ctx : ?*void, vtable : *AllocatorVTable);
```

约定：

- `alloc(ctx, size)` 返回至少 `size` 字节、按 16 对齐的块，或 `.None`。
- `realloc(ctx, ptr, new_size)` 调整由该 vtable 的 `alloc` 返回的块的大小，保留前
  `min(old, new_size)` 个字节。返回 `.None` 时原块保持不变，仍归调用者所有。
- `free(ctx, ptr)` 释放这样的块。没有大小参数。
- 回调不能通过作用域分配：其中不能有 `ArrayList.new()`、`String`、不带 `alloc` 的
  `box(...)` 或 `ref` 构造器。回调运行时，当前作用域可能正是它自己的分配器（在
  `with_allocator(a, …)` 之下，以及 `rc(v, alloc : .Some(a))` 和
  `arc(v, alloc : .Some(a))` 时），这样的分配会再次调用 `alloc`，递归直到栈溢出。请从 `GlobalAllocator` 或你自己持有的缓冲区获取内存，
  如下面的示例所示。

你的函数永远看不到 16 字节的所有者前缀：`std/allocator` 会向你的 `alloc` 多要 16
字节，并自己管理前缀。实现分配器需要处理裸指针，所以文件需要
`pragma(Pragma.AllowUnsafe);`；通过 `with_allocator` 或 `new_in` *使用*分配器则不
需要。

一个转发给全局分配器的计数分配器：

```yo
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ GlobalAllocator, with_allocator } :: import("std/allocator");

Point :: ref(struct(x : i32, y : i32));
_Counts :: struct(allocs : usize, frees : usize);

_count_alloc :: (fn(ctx : ?*void, size : usize) -> ?*void)({
  c := (*_Counts)(ctx.unwrap());
  unsafe(c.*.allocs = (c.*.allocs + usize(1)));
  GlobalAllocator.malloc(size)
});
_count_realloc :: (fn(ctx : ?*void, ptr : ?*void, new_size : usize) -> ?*void)(
  GlobalAllocator.realloc(ptr, new_size)
);
_count_free :: (fn(ctx : ?*void, ptr : ?*void) -> unit)({
  c := (*_Counts)(ctx.unwrap());
  unsafe(c.*.frees = (c.*.frees + usize(1)));
  GlobalAllocator.free(ptr);
});
_COUNT_VTABLE := AllocatorVTable(alloc : _count_alloc, realloc : _count_realloc, free : _count_free);

main :: (fn() -> unit)({
  counts := _Counts(allocs : usize(0), frees : usize(0));
  a := Allocator(ctx : .Some((*void)(addr_of(counts))), vtable : addr_of(_COUNT_VTABLE));
  {
    p := with_allocator(a, () => Point(x : i32(3), y : i32(4)));
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
| `a.alloc(size)`                 | 由 `a` 拥有的 `size` 字节，16 对齐，或 `.None`。                     |
| `Allocator.realloc(ptr, n)`     | 通过拥有该块的分配器调整块的大小。                                   |
| `Allocator.free(ptr)`           | 把块还给拥有它的分配器。`.None` 不做任何事。                         |
| `Allocator.owner_of(ptr)`       | 拥有该块的分配器。                                                   |
| `a.same(b)`                     | 两个值是否是同一个分配器。                                           |

`realloc`、`free` 和 `owner_of` 只接收指针：所有者前缀告诉它们该用哪个分配器。不要
把不是来自 `Allocator.alloc`/`realloc` 的指针传给它们，也不要用
`GlobalAllocator.free` 释放这样的块。

## 调试：泄漏报告

用 `--allocator fixed --debug-heap` 编译，退出报告会统计退出时仍然存活的堆块
（`live at exit: N blocks / M bytes`），包括用户分配器从全局分配器取得的块：

```bash
yo compile main.yo --allocator fixed --debug-heap -o app && ./app
```

`yo test` 接受同样的参数。在全局分配器前面放一个计数分配器，可以看出泄漏的块来自
哪个子系统。

## 开销

从不打开作用域的程序，在每个会查询作用域的分配位置只多付出一次 relaxed 原子读取和
一次分支：编译器自举的测量结果在噪声范围内（`plans/archive/EXPLICIT_ALLOCATORS.md`）。
容器大小不变，因为分配器存放在缓冲区的前缀里，而不是新增的字段。

## 限制

- **std 中没有 arena。** 见[何时使用显式分配器](#何时使用显式分配器)。
- **不支持超对齐的缓冲区。** 块按 16 对齐。元素对齐要求更严格的容器和以前一样不受
  支持。
- **仅在运行时生效。** `with_allocator` 在编译期没有作用；编译期调用是一次 extern
  调用。

设计记录（含测量数据和各阶段的历史）见 `plans/archive/EXPLICIT_ALLOCATORS.md`，
已落地的决定汇总在 `plans/reference/EXPLICIT_ALLOCATORS.md`。
