# Weak(T) 与 ArcWeak(T) — 不拥有的句柄

`Weak(T)` 对应 Rust 的 `rc::Weak<T>`：它是指向某个 `Rc(T)` 单元的句柄，但不会让载荷保持存活。
它在 `std/prelude.yo` 中紧挨着 `Rc` 定义，因此 `Weak` 处处可用。`Weak` 是不泄漏地闭合一个环的办法：
父节点通过 `Rc` 拥有子节点，每个子节点通过 `Weak` 指回父节点。设计见
`plans/backlog/WEAK_AND_UNCOLLECTED_RC.md` §3。

## API

```yo ignore
impl(generic(T : Type), Rc(T),
  downgrade : (fn(self : &Self) -> Weak(T))(...)              // Rust 的 Rc::downgrade(&rc)
);
impl(generic(T : Type), Weak(T),
  new : (fn() -> Self)(...),                                   // 不指向任何单元：upgrade 为 .None
  upgrade : (fn(self : &Self) -> Option(Rc(T)))(...),
  strong_count : (fn(self : &Self) -> usize)(...),
  weak_count : (fn(self : &Self) -> usize)(...),
  ptr_eq : (fn(self : &Self, other : &Self) -> bool)(...)
);
// 另有 Clone（指向同一单元的第二个 Weak）、Default（Weak.new()）和 Drop
```

`Rc.downgrade(&h)` 通过类型调用，与 `Rc.try_unwrap` 相同，这样载荷上名为 `downgrade` 的方法仍可写作
`h.downgrade()`。

```yo
a := rc(i32(7));
w := Rc.downgrade(&a);
assert(w.strong_count() == usize(1), "one Rc");
match(
  w.upgrade(),
  .Some(b) => assert(b.* == i32(7), "a new Rc to the same cell"),
  .None => assert(false, "a is alive")
);
consume(a); // 最后一个 Rc：载荷被释放
assert(w.upgrade().is_none(), "nothing to upgrade to");
```

## 语义

- **两个计数。** 单元同时记录 `Rc` 句柄数（强计数）和 `Weak` 句柄数（弱计数）。`downgrade` 与
  `Weak.clone` 增加弱计数，释放一个 `Weak` 减少弱计数。`Weak` 从不增加强计数。
- **最后一个 `Rc` 释放载荷。** 无论是否还有 `Weak`，载荷的 `Drop` 此时运行。运行期间强计数已经是 0，
  所以在其中调用 `upgrade` 得到 `.None`。
- **任一种类的最后一个句柄释放单元。** `Weak` 只让单元的字节保持分配，从不让载荷存活：在仍有 `Weak`
  时释放最后一个 `Rc`，分配会留给最后一个 `Weak` 去释放。由显式分配器放置的单元
  （`rc(v, alloc : .Some(a))`）无论哪种情况都释放回该分配器。
- **`upgrade`** 在载荷存活时返回 `.Some(h)`（一个新的强句柄），最后一个 `Rc` 消失后返回 `.None`。
  `Weak.new()` 不指向任何单元，总是升级为 `.None`。
- **计数与 Rust 的读法一致。** 载荷消失后 `strong_count` 为 0；`weak_count` 包括当前句柄，载荷消失后为 0。
- **弱计数会饱和**，上限是指向同一单元的 32767 个句柄。饱和的单元停止计数且永不释放：这是泄漏，绝不会
  产生悬垂句柄。此时 `weak_count()` 报告 `usize.MAX`。
- **`Rc.try_unwrap`** 在仍有 `Weak` 时也会成功，之后这些 `Weak` 升级为 `.None`。**`Rc.make_mut`** 与 Rust 的
  一样会解除这些 `Weak` 句柄的关联：当有 `Weak` 指向唯一的 `Rc` 的单元时，该 `Rc` 会先移到一个持有载荷克隆的
  新单元，因此该 `Weak` 永远看不到写入，之后升级为 `.None`。

## `Weak` 不是什么

- **没有 `Deref`。** 载荷可能已经消失，所以每次读取都要经过 `upgrade`。也没有 `Weak(p)` 模式。
- **显式复制。** `Weak` 有 `Drop`，因此只能移动：当 `w` 之后不再使用时，`w2 := w` 会移动它，其他任何复制
  都是错误 E0901。`Weak.clone(&w)` 创建第二个句柄。
- **不是 `Send` 也不是 `Sync`。** `Rc` 图只属于一个线程，指向其中的 `Weak` 也是。

## 父指针

在 Rust 中，带父指针的树由强的子边和弱的父边构成。由于 `Rc` 的载荷通过句柄只读，写入要经过
`RefCell(T)`（`std/sync/refcell`）：

```yo
{ RefCell } :: import("std/sync/refcell");
{ ArrayList } :: import("std/collections/array_list");

Node :: struct(
  value : i32,
  parent : Weak(RefCell(Node)),
  children : ArrayList(Rc(RefCell(Node)))
);

root := rc(RefCell(Node).new(Node(value : i32(1), parent : Weak(RefCell(Node)).new(), children : ArrayList(Rc(RefCell(Node))).new())));
leaf := rc(RefCell(Node).new(Node(value : i32(2), parent : Rc.downgrade(&root), children : ArrayList(Rc(RefCell(Node))).new())));
root.with_mut({ leaf }(n) => {
  n.children.push(leaf);
});
parent_value := leaf.with(n => match(n.parent.upgrade(), .Some(p) => p.with(pn => pn.value), .None => i32(0)));
assert(parent_value == i32(1), "the leaf reaches its parent");
```

释放 `root` 就释放整棵树：所有强边都指向下方。

## `Acyclic` 标记

`T <: Acyclic` 表示从 `T` 的值出发，到达不了任何由强边构成的环。值的环上必须有一个共享单元（`Rc`、`Arc`、
`ref` 对象）：经由值或 `Box` 的递归（`Option(Box(Self))`）只构成树，而 `Weak` 或 `ArcWeak`
边根本不是边。该标记是推导出来的，std 中没有任何地方要求它；
`where(T <: Acyclic)` 约束是 API 承诺其值不会持有泄漏环的方式。

```yo
{ RefCell } :: import("std/sync/refcell");
Tree :: struct(value : i32, first_child : Option(Box(Self)), next_sibling : Option(Box(Self)), parent : Weak(RefCell(Self)));
Graph :: struct(value : i32, peer : Option(Rc(RefCell(Self))));
test("a Weak back edge keeps a type Acyclic", {
  comptime_assert(Type.impls(Tree, Acyclic), "the only cell edge is a Weak");
  comptime_assert(!Type.impls(Graph, Acyclic), "an Rc edge can close a cycle");
});
```

子节点是 `Rc` 句柄的树（如上面的父指针示例）不是 `Acyclic`：它的类型并不阻止子节点的边指回祖先。
目前经由 `ArrayList` 递归的类型也不是：列表是共享对象，因此列表可以持有一个持有该列表的值。
推导拒绝的类型可以声明该标记 `impl(T, Acyclic())`，无需 `pragma(Pragma.AllowUnsafe)`：错误的声明只会泄漏，
不会产生悬垂指针。该声明还会让这个类型的单元不被环回收器跟踪，它只与回收器同存续。

## 与环回收器

`Weak` 不是所有权图中的边。回收器的遍历不访问 `Weak` 字段，手写的 `Trace` 也不得访问，因此经由 `Weak`
闭合的环不算环：唯一回边是 `Weak` 的类型是无环的，它的单元永远不会被跟踪。在
`--cycle-collector off`（[CYCLE_COLLECTION.md](./CYCLE_COLLECTION.md)）下，正是 `Weak` 回边让这类结构不泄漏。

回收器释放一个垃圾环时，在它运行的 `Drop` 中调用 `upgrade`：对该环中的单元得到 `.None`，对存活单元则成功。
若环外仍有 `Weak` 指向某个垃圾单元，该单元的载荷会被释放，分配保留到那个 `Weak` 消失为止；
`tracked_count()` 不再计入它。

## `ArcWeak(T)`：线程安全的形式

`ArcWeak(T)` 对应 Rust 的 `sync::Weak<T>`，是针对 `Arc(T)` 单元的同一种句柄：`Arc.downgrade(&h)` 创建它，
只要任一线程上仍有指向该单元的 `Arc`，`w.upgrade()` 就返回 `.Some(handle)`（一个新的 `Arc`）。它的 API 与
`Weak` 相同（`new`、`upgrade`、`strong_count`、`weak_count`、`ptr_eq`、`Clone`、`Default`）。计数是原子的：
`upgrade` 只在还剩强计数时才取得一个，因此绝不会复活另一个线程正在释放的载荷；无论最后在哪个线程释放，
恰好有一个句柄释放单元。由于 `Arc` 的载荷是 `Send` 和 `Sync`，每个 `ArcWeak(T)` 也是，可以移入新线程：

```yo
{ Thread } :: import("std/thread");

a := arc(i32(7));
w := Arc.downgrade(&a);
t := Thread(unit).spawn({ w }(io) => {
  n := match(w.upgrade(), .Some(h) => h.*, .None => i32(0));
  assert(n == i32(7), "a is alive while the worker runs");
});
t.join();
```

`Arc` 句柄形成的环会泄漏（[ARC.md](./ARC.md#环)）；`ArcWeak` 回边（`Arc(Mutex(Node))` 带有
`peer : ArcWeak(Mutex(Node))` 字段）则不会。与 `Rc.make_mut` 对 `Weak` 一样，`Arc.make_mut` 会解除
`ArcWeak` 句柄的关联。

## 相关文档

- [ARC.md](./ARC.md) — 原子计数的句柄 `Arc(T)`
- [CYCLE_COLLECTION.md](./CYCLE_COLLECTION.md) — 回收器与 `--cycle-collector off`
- [MEMORY_SAFETY.md](./MEMORY_SAFETY.md) — 泄漏检测
