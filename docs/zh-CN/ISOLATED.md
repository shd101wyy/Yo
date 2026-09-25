# 隔离类型

`Iso(T)` 把一个**不是** `Send` 的值 —— 普通的 `ref(struct)` 对象图、`ArrayList`、`String` ——
一次性地移交给另一个线程。这是非原子对象合法跨越线程边界的唯一途径。

## 模型

- **包装器本身是原子对象。** `Iso(T)` 句柄使用原子引用计数，所以把它复制进 spawn 闭包、在两个线程上各自释放副本都是安全的。
- **内部的 `T` 保持自己的非原子引用计数。** 除 `extract()` 之外，没有任何操作通过包装器触碰它；`extract()` 把它交给恰好一个线程。
- **`Iso(T)` 无需 `T <: Send` 即为 `Send`。** 依据是唯一性：在 `extract()` 的那一刻最多只有一个线程能到达内部值，因此它的非原子引用计数只会被一个线程更新。
- **唯一性在构造时建立**，由 `^` 运算符负责，也是安全性的落脚点。`plans/reference/PARALLELISM_RULES.md` 的 D2 规则会把它变成**深度**检查（每个可达的非原子对象都必须被唯一持有）；今天它是浅层的（见下文）。

## 构造 `Iso`：`^` 运算符

```rust
data := box(i32(42));
iso_opt := ^data;              // Option(Iso(Box(i32)))
match(
  iso_opt,
  .Some(iso) => { /* 发送它 */ },
  .None => { /* `data` 被共享：什么都没有移动 */ }
);
```

`^v` 消耗 `v`（之后再使用 `v` 会报 "use of moved value"），当值不唯一时返回 `.None` 而不是 panic。它执行：

1. **对变量的编译期检查** —— `v` 必须拥有它的引用计数值，不能有其他变量作为别名，且其类型不能形成引用环（环需要每线程的循环收集器，而接收线程不会为它运行收集器）。
2. **一次运行期唯一性检查** `Isolation.can_isolate(v)`。今天只有 `Box(T)` 实现了 `Isolation`（`rc(self) == 1`）；用户类型需要手写实现：

```rust
Data :: ref(struct(v : i32));
Point :: ref(struct(x : Data, y : Data));
impl(Data, Isolation(can_isolate : (self -> (rc(self) == 1))));
impl(
  Point,
  Isolation(
    can_isolate : (self -> ((rc(self) == 1) && self.x.can_isolate() && self.y.can_isolate()))
  )
);
```

`Point` 的实现说明了"深度"的含义，以及为什么手写的浅层实现是一个 bug：如果 `can_isolate` 只看 `rc(self)`，一个 `x` 与某个局部变量共享的 `Point` 会被移走，而那个局部变量继续修改 `x`。D2 用生成的遍历（`__yo_iso_unique_<T>`）取代这种手写遍历，`Isolation` 保留为可选的快速路径。

**原始构造函数 `Iso(T)(v)`** 存在，是编译器为 `^` 生成的目标。直接调用它时，只有在参数是具名变量时才执行编译期检查，运行期什么也不检查；D2 会把它从安全代码中移除。不要在新代码中使用它。

## `extract`

```rust
inner := iso.extract();        // T
```

`extract()` 直接返回内部的 `T`（不是 `Option`），把 `Iso` 标记为已提取，并且在同一个 `Iso` 的任何副本上第二次调用时 panic：

```
panic: Iso::extract() called on already-extracted Iso
```

提取之后该值使用非原子引用计数：把它留在提取它的线程上。释放一个从未被提取的 `Iso` 会释放内部值（在释放最后一个句柄的那个线程上 —— 这是安全的，因为那时只有该线程能到达它）。

D2 给 `extract()` 增加第二项检查：包装器自身的引用计数必须为 1，这样仍然持有 `Iso` 副本的发送线程会得到 panic 而不是第二个所有者。今天这项检查并不存在；旧资料里反复出现的 "extract 验证 rc == 1" 描述的是设计意图，不是生成的代码。

## 生成的 C 代码

```c
typedef struct {
  __yo_ref_header_t header;   // 原子引用计数 —— 句柄是原子对象
  _Atomic bool extracted;     // 一次性标志
  T value;                    // 内部值，非原子引用计数
} Iso_T_struct;

T __yo_iso_extract_T(Iso_T iso) {
  if (atomic_exchange(&iso->extracted, true)) { /* panic: already extracted */ }
  return iso->value;
}
void __yo_iso_dispose_T(Iso_T iso) {
  if (!atomic_load(&iso->extracted)) { __yo_decr_rc((void*)iso->value); }
}
```

## 组合规则

- `Iso(Arc(T))` 是编译错误 —— `Arc` 已经是 `Send`，直接发送它。
- `Arc(Iso(T))` 是编译错误 —— `Arc` 共享，`Iso` 唯一。
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
      xs := iso.extract();     // 列表现在属于主线程
      // ...
    },
    .None => ()
  );
});
```

（对 `ArrayList` 使用 `^xs` 要等 D2 落地后才能编译 —— 今天它需要一个 `Isolation` 实现，而 `ArrayList` 没有；原始构造函数可用但没有任何检查。）

## 示例：在构造时被拒绝

```rust
x := box(i32(42));
y := x;
iso := ^x;                     // 编译错误：cannot isolate x, also owned by y
```

## 已知缺口（2026-09-25）

`issues/iso-constructor-is-unchecked-and-extract-verifies-no-uniqueness.md` 与
`issues/iso-checks-only-the-wrapper-refcount-not-the-interior.md`：值的内部没有被检查，原始构造函数接受字面量参数和标量 `T`，`extract()` 不检查任何引用计数。`plans/PARALLELISM_SOUNDNESS.md` 第 2 阶段关闭这些缺口。
