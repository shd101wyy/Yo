# 隔离类型

`Iso(T)` 把一个**不是** `Send` 的引用对象 —— 普通的 `ref(struct)` 对象图、`ArrayList`、`HashMap`
—— 一次性地移交给另一个线程。这是非原子对象合法跨越线程边界的唯一途径。规则见
`plans/reference/PARALLELISM_RULES.md` 的 D2。

## 模型

- **包装器本身是原子对象。** `Iso(T)` 句柄使用原子引用计数，所以把它复制进 spawn 闭包、在两个线程上各自释放副本都是安全的。
- **内部的 `T` 保持自己的非原子引用计数。** 除 `extract()` 之外，没有任何操作通过包装器触碰它；`extract()` 把它交给恰好一个线程。
- **`Iso(T)` 无需 `T <: Send` 即为 `Send`。** 依据是唯一性：创建 `Iso` 时，发送线程上没有任何其他东西能到达值的对象图中的任何非原子对象，而 `extract()` 把这张图交给恰好一个线程 —— 所以图中每个非原子引用计数任何时刻都只被一个线程更新。
- **唯一性在构造时建立**，由 `^` 运算符负责，而且是**深度**的：从值出发可达的每个非原子对象都必须被唯一持有。

## 构造 `Iso`：`^` 运算符

```rust
xs := ArrayList(i32).new();
xs.push(i32(1));
iso_opt := ^xs;                // Option(Iso(ArrayList(i32)))
match(
  iso_opt,
  .Some(iso) => { /* 发送它 */ },
  .None => { /* 还有别的东西能到达这个列表：什么都没有移动 */ }
);
```

`^v` 消耗 `v`（之后再使用 `v` 会报 "use of moved value"），当值不唯一时返回 `.None` 而不是 panic。它执行：

1. **对变量的编译期检查** —— `v` 必须拥有它的引用计数值，不能有其他变量作为别名，且其类型不能形成引用环（环需要每线程的循环收集器，而接收线程不会为它运行收集器）。
2. **一次对整张对象图的运行期遍历**（`__yo_iso_unique`）：从 `v`（包括 `v` 本身）出发可达的每个非原子对象的引用计数都必须恰好为 1。遍历使用循环收集器所用的同一套按类型生成的遍历函数 —— 结构体与枚举的字段，以及容器通过其 `Trace` 实现暴露的元素 —— 并使用显式工作列表，所以很长的链表也不会递归。值内部的**原子**对象（`Arc`、`Mutex`、`AtomicI32`）按设计就是共享的，遍历在此停止：在隔离的对象图里捕获一个共享计数器是可以的。

```rust
shared := ArrayList(i32).new();
w := Wrap(items : shared);     // Wrap :: ref(struct(items : ArrayList(i32)))
r := ^w;                       // .None：`shared` 仍然能到达 w.items
```

代价是每次移交在发送线程上对值的对象图遍历一次。

**`T` 必须是非原子的引用对象**（`ref(struct)`、`ref(enum)`、`ArrayList`、`HashMap`、`Box` 等）。`Iso(i32)` 或 `Iso(某个值结构体)` 是编译错误 —— 值在发送时会被复制，直接传递即可（或者放进 `Box`）。`Iso(Arc(T))`、`Iso(<原子对象>)` 和 `Iso(Iso(T))` 同样是编译错误：它们本身已经可以发送。

**对象图中能容纳的每个函数值都必须是 `Send` 的**（规则 D9）。隔离证明的是对象图被唯一拥有，而不是其中存放的函数所运行的代码在接收线程上是安全的。闭包或函数字段按它捕获的东西和它的代码触及的东西判断；裸 `fn(...)` 字段（编译期不知道它是哪个函数）以及不带 `Send` 的 `Dyn(Trait)` 会让这个 `Iso` 成为编译错误。

**原始构造函数 `Iso(T)(v)`** 是 `^` 展开的目标，在安全代码（没有 `pragma(Pragma.AllowUnsafe)` 的文件）中不可用：它不检查值的内部。请使用 `^`。

## `extract`

```rust
inner := iso.extract();        // T
```

`extract()` 直接返回内部的 `T`（不是 `Option`），把 `Iso` 标记为已提取，并且在同一个 `Iso` 的任何副本上第二次调用时 panic：

```
panic: Iso::extract() called on already-extracted Iso
```

原子的一次性标志保证了移交之后值恰好有一个所有者：保留了 `Iso` 副本的发送线程在接收方提取之后再也无法提取它，而释放那个副本时也不会释放任何东西。提取之后该值使用非原子引用计数：把它留在提取它的线程上。释放一个从未被提取的 `Iso` 会释放内部值（在释放最后一个句柄的那个线程上 —— 这是安全的，因为那时只有该线程能到达它）。

## 生成的代码

```c
typedef struct {
  __yo_ref_header_t header;   // 原子 RC —— 句柄是原子对象
  _Atomic bool extracted;     // 一次性标志
  T value;                    // 内部对象句柄，非原子 RC
} Iso_T_struct;

bool __yo_iso_unique_Iso_T(T value);  // 构造时的对象图遍历
T __yo_iso_extract_Iso_T(Iso_T iso) {
  if (atomic_exchange(&iso->extracted, true)) { /* panic：已被提取 */ }
  return iso->value;
}
void __yo_iso_dispose_Iso_T(Iso_T iso) {
  if (!atomic_load(&iso->extracted)) { __yo_decr_rc((void*)iso->value); }
}
```

## 组合规则

- `Iso(Arc(T))`、`Iso(<原子对象>)` 和 `Iso(Iso(T))` 是编译错误 —— 直接发送该值即可。
- `Arc(Iso(T))` 是编译错误 —— `Arc` 是共享，`Iso` 是唯一。
- 当 `T` 是 `Acyclic` 时，`Iso(T)` 也是 `Acyclic`。

## 示例：把工作线程上构建的列表交回主线程

```rust
{ Thread } :: import("std/thread");
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");

build :: (fn() -> Option(Iso(ArrayList(String))))({
  xs := ArrayList(String).new();
  xs.push(`built on the worker`);
  ^xs
});

main :: (fn() -> unit)({
  t := Thread(Option(Iso(ArrayList(String)))).spawn((io : Io) => build());
  match(
    t.join(),
    .Some(iso) => {
      xs := iso.extract();     // 列表现在位于主线程上
      // ...
    },
    .None => ()
  );
});
```

## 示例：构造时被拒绝

```rust
x := box(i32(42));
y := x;
iso := ^x;                     // 编译错误：无法隔离 x，它同时被 y 持有
```
