# Arc(T) — 基于原子引用计数的共享所有权

`Arc(T)` 用于通过原子引用计数共享单个值的所有权。它**不再是编译器内置类型**。
在当前设计里，`Arc` 在 `std/prelude.yo` 中被定义为一个薄包装的
`atomic(ref(struct(...)))`，因此 `Arc` 与 `arc(...)` 会通过 prelude 自动可用。
`Arc(T)` 本身要求 `T <: (Send, Sync)`，这样就不会把非线程安全的值伪装成可跨线程共享的包装。每个约束各有原因：

- `Sync`：每个句柄都在自己的线程上读取载荷。
- `Send`：最后一个句柄可能在任意线程上被释放，载荷的 `Drop` 就在那个线程上运行（与 Rust 的 `Arc<T>: Send + Sync` 要求 `T: Send + Sync` 相同）。

与 Rust 一样，载荷不必是 `Acyclic`。`Arc` 句柄形成的环会泄漏：见[环](#环)。

在同样的约束下，`Arc(T)` 自身也是 `Send` 和 `Sync`。prelude 显式写出这两个 impl：闭包载荷（`Arc(Impl(Fn() -> unit))`）只能按值、通过它的捕获判断是否为 `Sync`，类型层面的派生看不到这些捕获。

## 当前定义

```yo
Arc :: (fn(comptime(V) : Type, where(V <: (Send, Sync))) -> comptime(Type))(
  atomic(
    ref(
      struct(
        (*) : V
      )
    )
  )
);

arc :: (fn(generic(V : Type), sink(value) : V, (alloc : Option(Allocator)) ?= .None, where(V <: (Send, Sync))) -> Arc(V))(
  ...
);
```

`alloc : .Some(a)` 把单元放在分配器 `a` 中。默认值 `.None` 把它放在当前
`with_allocator` 作用域中，没有作用域时使用全局分配器（见[放置单元](#放置单元)）。

## 什么时候使用 `Arc`

- 当你想在**线程或闭包之间共享一个现有值**时，使用 `Arc(T)`。
- 当你要定义**自己的共享类型**时，使用 `atomic(ref(struct(...)))`。
- 要把值**转移**到另一个线程而不是共享它，就移动它：`Send` 值可以移入派生的闭包或经由 `Channel` 发送。`Rc` 对象图只属于它所在的线程（Rust 的规则）；`Rc.try_unwrap` 从唯一持有的 `Rc` 中取出值。在 `String` 和各集合类型通过移动成为 `Send`（`plans/VALUES_BY_DEFAULT.md` V2b）之前，二者都不能跨线程：通过 `Arc` 共享同时满足 `Send` 和 `Sync` 的数据，在接收线程上用 `Send` 的部分重建该值，或将其序列化。（过去覆盖这种情况的一次性隔离移交已在 v0.2.68 中移除。）
- `Arc(T)` 只接受同时实现了 `Send` 和 `Sync` 的子类型；普通 `ref(struct(...))` 两者都不满足。是 `Send` 但不是 `Sync` 的类型（用 `impl(T, !(Sync()))` 退出 `Sync` 的类型）应放进 `Mutex(T)`，由它串行化访问。
- 对函数值（闭包或具名函数）调用 `arc(f)` 时按值判断：它捕获的东西和它的代码触及的东西都必须是 `Send` 且 `Sync` 的（规则 D4 与 D9，见 `THREAD_SAFETY.md`）。

许多标准库类型已经不再需要额外的 `Arc(...)` 包装。例如 `std/sync`
原语本身就基于 `atomic(ref(struct(...)))` 实现，可以直接跨线程共享。

如果你需要共享可变状态，应该先把这份状态定义成 `atomic(ref(struct(...)))`，
然后直接共享它；只有在你确实需要“包裹一个单独值”时，再使用 `Arc(...)`。

## 基本用法

### 创建 Arc

```yo
value := arc(i32(42));
same := Arc(i32)(i32(42));
```

### 放置单元

`arc(value, alloc : .Some(a))` 从分配器 `a`（例如一个 arena）分配单元。最后一个句柄
被 drop 时，无论在哪个线程上，单元都通过 `a` 释放。不传 `alloc` 时，由
`with_allocator` 作用域放置单元，没有作用域时使用全局分配器（见
[EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)）。与 `box` 不同，`arc` 在分配单元时
把 `a` 设为当前作用域，所以 `a` 自己的回调不能通过作用域分配（见该文档的“编写自己的
分配器”）：

```yo
{ Arena } :: import("std/arena");

arena := Arena.new(usize(1) << usize(16));
{
  a := arc(i32(42), alloc : .Some(arena.allocator()));
  assert(arena.live_blocks() == usize(1), "the cell is in the arena");
};
assert(arena.live_blocks() == usize(0), "the last handle freed it into the arena");
arena.deinit();
```

### 解引用

通过 `.*` 访问内部值，它返回借用访问：

```yo
value := arc(i32(42));
copied := value.*;
assert(copied == i32(42), "inner value is 42");
```

### 复制

复制 `Arc` 会递增引用计数，并继续共享同一份底层值：

```yo
a := arc(i32(42));
b := a;
c := b;

assert(a.* == b.*, "same shared value");
assert(b.* == c.*, "same shared value");
```

### 跨线程共享

```yo
{ Thread } :: import("std/thread");

shared := arc(i32(42));

t := Thread(unit).spawn(io => {
  assert(shared.* == i32(42), "thread sees shared value");
});

t.join();
assert(shared.* == i32(42), "main still sees shared value");
```

### 取出载荷与写时复制

`Arc` 的载荷通过句柄只能读取：安全代码中通过它的写入会被拒绝，共享修改需要通过 `Arc(Mutex(T))`、`Arc(RwLock(T))` 或原子类型进行。`Arc(RefCell(T))` 会被拒绝，因为 `RefCell` 永远不是 `Sync`。有两个入口可以证明句柄是唯一的，与 Rust 相同（[值默认计划](../../plans/VALUES_BY_DEFAULT.md)的决策 46）：

- **`Arc.try_unwrap(h)`** 消耗该句柄：若任何线程上都没有其他句柄，返回 `.Ok(payload)`（单元被释放），否则返回 `.Err(h)`。
- **`Arc.make_mut(&mut h)`**（`T <: Clone`）是被写入的载荷：共享的载荷会先被克隆到只有 `h` 持有的新单元中。

```yo
a := arc(i32(1));
b := a;
Arc.make_mut(&mut b) = i32(2); // b 得到自己的单元
assert((a.* == i32(1)) && (b.* == i32(2)), "a is unchanged");
```

## `Arc` 与 `atomic(ref(struct(...)))` 的区别

| 需求                            | 推荐工具                   |
| ------------------------------- | -------------------------- |
| 共享一个现有值                  | `Arc(T)`                   |
| 定义可复用的共享引用计数类型    | `atomic(ref(struct(...)))` |
| 把 `Send` 值交给另一个线程      | 移动（spawn、`Channel`）   |

## 语义

- **原子引用计数**：`Arc` 使用原子递增/递减操作。
- **共享所有权**：复制 `Arc` 不会复制底层分配，只会共享它。
- **借用解引用**：`.*` 提供对内部值的借用访问。
- **销毁行为**：最后一个引用被释放时，会先 drop 内部值，再释放分配。
- **闭包捕获**：闭包捕获 `Arc` 时会复制这份共享引用。

## 环

原子引用计数不参与循环回收。如果载荷直接或经由 `Mutex` 持有指回自身单元的 `Arc`，就会形成一个计数永远不会归零的环，这些单元会一直保持分配状态直到进程退出，与 Rust 中的情况相同：

```yo
{ Mutex } :: import("std/sync/mutex");

Node :: struct(id : i32, peer : Option(Arc(Mutex(Self))));

a := arc(Mutex(Node).new(Node(id : i32(1), peer : .None)));
b := a;
a.with_lock(v => {
  v.peer = .Some(b); // a -> mutex -> node -> a：这个单元永远不会被释放
});
```

在丢弃最后一个能到达环的句柄之前，清除一条回边（在锁内执行 `v.peer = .None`）即可打破环。使用 `--allocator fixed --debug-heap` 编译可以看到泄漏的环：退出报告会统计仍然存活的块（[EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md#调试泄漏报告)）。

## 相关文档

- `docs/zh-CN/PARALLELISM.md` —— 线程与线程池模型
