# 显式分配器

Yo 用引用计数管理内存：对象在最后一个引用消失时被释放。**显式分配器**提供了另一个
相互独立的选择：对象的字节放在**哪里**。你可以把一次计算产生的所有对象放进一个
arena，统计某个库的每一次分配，或者给一个子系统单独的内存预算，而对象的用法和释放
时机都不会改变。

- [模型](#模型)
- [快速上手](#快速上手)
- [分配作用域：`with_allocator`](#分配作用域with_allocator)
- [容器](#容器)
- [Arena：`std/arena`](#arenastdarena)
- [何时使用 arena](#何时使用-arena)
- [线程与异步任务](#线程与异步任务)
- [编写自己的分配器](#编写自己的分配器)
- [底层 `Allocator` API](#底层-allocator-api)
- [调试：泄漏报告](#调试泄漏报告)
- [开销](#开销)
- [限制](#限制)

## 模型

**分配器决定放置位置，引用计数决定生命周期。** 这是两件独立的事：

- 放在 arena 里的对象，依然在最后一个引用消失时立刻释放，与其他对象完全一样。
  不会有任何东西在“arena 消失时”背着你被释放。
- 释放总是把内存块还给创建它的分配器。每个块在返回指针前面都带有一个 16 字节的
  所有者前缀，所以即使在另一个线程释放，或者在创建它的代码早已返回之后释放，块
  也会回到正确的地方。不可能把块释放到错误的分配器里。

正因如此，显式分配器在 Yo 中是安全的，而在别的语言里它常常是 bug 的来源。在 Zig
中，释放一个仍被引用的 arena 是 use-after-free；在 Yo 中，只要还有活跃的块，
`Arena.deinit()` 就会 **panic**，错误变成一次明确的、可定义的失败。

这些都不需要新语法。`Point(...)` 在分配作用域内外是同一个构造调用，变化的只是它的
字节从哪里来。

## 快速上手

```rust
{ println } :: import("std/fmt");
{ Arena } :: import("std/arena");
{ with_allocator } :: import("std/allocator");
{ ArrayList } :: import("std/collections/array_list");

Point :: ref(struct(x : i32, y : i32));

main :: (fn() -> unit)({
  arena := Arena.new(usize(1) << usize(20)); // 一块 1 MiB 的区域
  {
    // 作用域内创建的每个 RC 对象和容器缓冲区都在 arena 里。
    p := arena.scoped(() => Point(x : i32(3), y : i32(4)));
    xs := with_allocator(arena.allocator(), () => {
      ys := ArrayList(i32).new(); // 跟随作用域
      ys.push(i32(1));
      ys
    });
    // 在作用域外，显式指定分配器。
    zs := ArrayList(i32).new_in(arena.allocator());
    zs.push(i32(2));
    println(`live blocks: ${arena.live_blocks()}`);
  };
  // `p`、`xs` 和 `zs` 都已消失，它们的块已经还给了 arena。
  println(`live blocks: ${arena.live_blocks()}`); // 0
  arena.deinit(); // 没有活跃的块，正常返回
});
export(main);
```

## 分配作用域：`with_allocator`

`with_allocator(a, f)`（`std/allocator`）在 `f` 运行期间（包括 `f` 调用的所有
代码）把 `a` 设为当前线程的当前分配器，并返回 `f` 的结果。`arena.scoped(f)` 是用
arena 的分配器做同样的调用。`f` 返回或 unwind 时恢复之前的分配器，所以作用域可以
嵌套。

在作用域内，以下内容来自 `a`：

- `ref` struct 和 `ref` enum 的构造，
- `box` 和 `arc`，
- `dyn` 盒子，
- `Iso` 值，
- 在作用域内创建的 `io.async` 任务的状态机，
- `imm` 集合的缓冲区，
- 在作用域内创建的可变容器的缓冲区（见[容器](#容器)）。

以下内容仍然使用全局分配器：

- 运行时自身的簿记（事件循环结构、线程池），
- 在作用域外创建的对象，即使之后在作用域内使用。

`current_allocator()` 返回作用域设置的当前分配器；没有作用域时返回 `.None`（即全局
分配器）。

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
返回 `.None`。

容器自身的大小不变：分配器记录在缓冲区的所有者前缀里，只用一个已有字段中的一位来
标记。

## Arena：`std/arena`

`Arena` 是建立在一块连续区域上的 bump 分配器。

| 方法                   | 作用                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `Arena.new(capacity)`  | 创建一个 `capacity` 字节（向上取整到 16）的 arena。无法分配该区域时 panic。   |
| `arena.allocator()`    | 把 arena 作为 `Allocator` 值，传给 `with_allocator` 或 `new_in`。             |
| `arena.scoped(f)`      | 即 `with_allocator(arena.allocator(), f)`。                                   |
| `arena.live_blocks()`  | 在这里分配且尚未释放的块数。                                                 |
| `arena.used_bytes()`   | 区域中已使用的字节数（bump 偏移）。                                           |
| `arena.capacity()`     | 区域的大小（字节）。                                                         |
| `arena.is_released()`  | 是否已经执行过 `deinit` 或 `abandon`。                                        |
| `arena.deinit()`       | 释放区域。若仍有活跃的块则 **panic**。最后一个 `Arena` 句柄消失时也会执行。   |
| `arena.abandon()`      | 停止跟踪且永不释放区域。之后 `deinit` 不做任何事。                            |

值得了解的行为：

- **只有顶部的空间会被回收。** 释放最近分配的块会让 bump 指针回退；其他被释放的
  空间要等整个 arena deinit 时才回收。区域有剩余空间时，`realloc` 会原地扩大最近
  分配的块。
- **有活跃块时 `deinit` 会 panic：**
  `Arena.deinit: 1 block(s) still live (32 of 1024 bytes in use)`。请先确保放在
  arena 里的每个对象都已消失，例如像快速上手那样把它们放在一个内层代码块里。
- **过期的 `Allocator` 副本碰不到已释放的内存。** arena deinit 之后再通过
  `Allocator` 值分配会 panic。arena 的簿记永远不会被释放，所以过期副本看到的是一个
  被标记的状态，而不是已释放的内存。
- **与进程同寿命的 arena 调用 `abandon()`。** 用于一直活到程序退出的启动表、字符串
  驻留表等：arena 停止跟踪，永不释放区域，`deinit` 不做任何事。
- **线程安全。** 每个 arena 操作都会获取 arena 自己的锁，所以块可以在任何线程上
  分配和释放。

## 何时使用 arena

在引用计数下，arena 改变的是字节**从哪里来**，而不是内存管理工作的多少：每一次引用
计数更新和每一次释放仍然会发生。所以 arena 并不是通用的提速手段。它真正带来的是：

- **为一段有界的工作提供受检查的结束点。** 在一个 arena 里解析一个文件、回答一个
  请求、运行一个测试或构建一张图，然后 `deinit`。如果这段工作的任何东西仍被引用
  （缓存、全局变量、被捕获的闭包），`deinit` 会 panic 并告诉你有多少个块逃逸了。
  这相当于断言这段工作确实清理干净了。
- **局部性。** 这段工作的对象挨在同一块区域里，有利于遍历树、图这类链式结构。
- **预算与统计。** arena 的容量是固定的，`live_blocks()` / `used_bytes()`（以及
  `--debug-heap` 报告）显示一个子系统用了多少内存。计数分配器可以对一个库或一个
  测试做同样的统计。
- **廉价的分配与释放。** 分配是一次指针递增，释放是一次计数递减，而不是调用通用
  分配器。

不适合使用的情况：

- **持续分配又释放的长时间运行的工作。** bump arena 只回收最近分配的块；中间释放
  的空间要等到 `deinit` 才回收，所以频繁分配释放的代码会无限增长。
- **与程序同寿命的数据。** 它永远不能 deinit，因此相比全局分配器没有收益（而
  `abandon()` 是停止跟踪它的唯一方式）。
- **只为追求速度。** 全局分配器（mimalloc）的快速路径已经很快；在期待提速之前先
  测量。

## 线程与异步任务

**作用域是按线程的。** 新建的线程从全局分配器开始，即使它是在作用域内创建的。要在
线程中使用 arena，把它的 `Allocator` 值传进去，再在那里打开作用域：

```rust
{ println } :: import("std/fmt");
{ Arena } :: import("std/arena");
{ with_allocator } :: import("std/allocator");
{ Thread } :: import("std/thread");

Point :: ref(struct(x : i32, y : i32));

main :: (fn() -> unit)({
  arena := Arena.new(usize(1) << usize(16));
  a := arena.allocator(); // `Allocator` 是 `Send`；`Arena` 句柄不是
  t := Thread(i32).spawn(io => {
    p := with_allocator(a, () => Point(x : i32(1), y : i32(2)));
    (p.x + p.y)
  });
  println(`${t.join()}`);
});
export(main);
```

`Allocator` 是两个字长的值，且是 `Send`。`Arena` 句柄是引用计数的，不是 `Send`，
所以要通过它的 `Allocator` 值在线程间共享 arena。

**任务保留它的作用域。** 在 `with_allocator` 内创建的 `io.async` 任务，每次挂起后
恢复时都带着同一个作用域，无论事件循环恢复它时当前是哪个作用域。即使
`with_allocator` 已经返回，任务之后做的工作仍然落在那个分配器里。

## 编写自己的分配器

分配器是一个上下文指针加一张包含三个函数的表：

```rust
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

你的函数永远看不到 16 字节的所有者前缀：`std/allocator` 会向你的 `alloc` 多要 16
字节，并自己管理前缀。实现分配器需要处理裸指针，所以文件需要
`pragma(Pragma.AllowUnsafe);`；通过 `with_allocator` 或 `new_in` *使用*分配器则不
需要。

一个转发给全局分配器的计数分配器：

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
{ Allocator, AllocatorVTable, GlobalAllocator, with_allocator } :: import("std/allocator");

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
  a := Allocator(ctx : .Some((*void)(&counts)), vtable : &_COUNT_VTABLE);
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

用 `--allocator fixed --debug-heap` 编译，退出报告会列出每个从未 deinit 的 arena 和
每个被 abandon 的 arena，以及它的活跃块数和已用字节数：

```bash
yo compile main.yo --allocator fixed --debug-heap -o app && ./app
```

`yo test` 接受同样的参数。退出时仍然存活的 arena 通常意味着放在其中的某个对象还被
某个长期存在的东西引用，比如全局变量或缓存。

## 开销

从不打开作用域的程序，在每个会查询作用域的分配位置只多付出一次 relaxed 原子读取和
一次分支：编译器自举的测量结果在噪声范围内（`plans/archive/EXPLICIT_ALLOCATORS.md`）。
容器大小不变，因为分配器存放在缓冲区的前缀里，而不是新增的字段。

## 限制

- **arena 不能嵌套。** `Arena` 的区域总是来自全局分配器；暂不支持由另一个 arena
  提供内存的 arena。
- **不支持超对齐的缓冲区。** 块按 16 对齐。元素对齐要求更严格的容器和以前一样不受
  支持。
- **仅在运行时生效。** `with_allocator` 在编译期没有作用；编译期调用是一次 extern
  调用。

设计记录（含测量数据和各阶段的历史）见 `plans/archive/EXPLICIT_ALLOCATORS.md`，
已落地的决定汇总在 `plans/reference/EXPLICIT_ALLOCATORS.md`。
