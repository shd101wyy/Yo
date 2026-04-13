# 不可变集合 (`std/imm`)

`std/imm` 模块提供持久化的不可变数据结构，底层使用 `atomic object` 节点。
每次"修改"操作都返回一个**新的**集合，原集合保持不变，从而实现跨线程的安全结构共享。

## 核心特性

| 特性         | 说明                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| **线程安全** | 所有节点类型使用 `atomic object`（原子引用计数）。                                            |
| **Send**     | 每个类型构造器要求 `T <: Send`，因此值可以安全地跨线程共享。                                  |
| **无循环**   | `atomic object` 不参与循环收集器。所有集合都是无环的树/列表结构，循环引用在结构上不可能发生。 |
| **持久化**   | "修改"后旧版本仍然有效。                                                                      |

## 模块概览

| 模块                 | 类型              | 底层数据结构                              |
| -------------------- | ----------------- | ----------------------------------------- |
| `std/imm/list`       | `List(T)`         | 单向链表（Cons list）                     |
| `std/imm/string`     | `String`          | 不可变字节缓冲区（UTF-8）                 |
| `std/imm/vec`        | `Vec(T)`          | 写时复制平坦数组                          |
| `std/imm/map`        | `Map(K, V)`       | 哈希数组映射前缀树（HAMT）                |
| `std/imm/set`        | `Set(T)`          | HAMT（`Map(T, bool)` 的包装）             |
| `std/imm/sorted_map` | `SortedMap(K, V)` | 左倾红黑树                                |
| `std/imm/sorted_set` | `SortedSet(T)`    | 左倾红黑树（`SortedMap(T, bool)` 的包装） |

## 快速入门

```rust
{ List } :: import "std/imm/list";
{ Map } :: import "std/imm/map";
{ SortedSet } :: import "std/imm/sorted_set";

// 持久化列表 — O(1) 前置插入
xs := List(i32).new().prepend(i32(3)).prepend(i32(2)).prepend(i32(1));
assert((xs.head().unwrap() == i32(1)), "head is 1");

// 持久化哈希映射 — O(log32 n) 插入/查找
m := Map(i32, i32).new();
m = m.insert(i32(1), i32(100));
m2 := m.insert(i32(2), i32(200));
assert((m.len() == usize(1)), "原始映射不变");
assert((m2.len() == usize(2)), "新映射包含两个条目");

// 有序集合 — 元素始终有序
s := SortedSet(i32).new();
s = s.insert(i32(5)).insert(i32(1)).insert(i32(3));
// s.to_list() → [1, 3, 5]
```

## `atomic object` 语法

`atomic object(...)` 关键字创建使用**原子**递增/递减的引用计数类型，
而不是普通 `object(...)` 使用的（非原子）引用计数。
使用 `atomic object` 定义的类型在所有字段都实现 `Send` 时自动派生 `Send` trait。

```rust
// 普通 object — 单线程 RC，不是 Send
Node :: (fn(comptime(T) : Type) -> comptime(Type))(
  object(value: T, next: Option(Self))
);

// 原子 object — 原子 RC，自动派生 Send
SafeNode :: (fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type))(
  atomic object(value: T, next: Option(Self))
);
```

与 `object(...)` 的主要区别：

- 使用 `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic`（C11 `_Atomic` 操作）
- **不**参与循环收集器（无 GC 注册）
- 当所有字段实现 `Send` 时自动派生 `Send`
- 不能形成循环（设计如此 — 没有循环收集器意味着循环会导致泄漏）

## API 参考

### `List(T)` — 持久化单向链表

约束：`T <: Send`

| 方法       | 签名                                           | 说明                 |
| ---------- | ---------------------------------------------- | -------------------- |
| `new`      | `() -> Self`                                   | 空列表               |
| `prepend`  | `(self, value: T) -> Self`                     | O(1) 前置插入        |
| `head`     | `(self) -> Option(T)`                          | 第一个元素           |
| `tail`     | `(self) -> Self`                               | 除第一个外的所有元素 |
| `len`      | `(self) -> usize`                              | 长度                 |
| `is_empty` | `(self) -> bool`                               | 是否为空             |
| `get`      | `(self, index: usize) -> Option(T)`            | O(n) 索引访问        |
| `reverse`  | `(self) -> Self`                               | 反转列表             |
| `concat`   | `(self, other: Self) -> Self`                  | 连接                 |
| `map`      | `(self, f: Impl(Fn(T) -> U)) -> List(U)`       | 变换元素             |
| `filter`   | `(self, f: Impl(Fn(T) -> bool)) -> Self`       | 保留匹配项           |
| `foldl`    | `(self, init: U, f: Impl(Fn(U, T) -> U)) -> U` | 左折叠               |

当 `T <: Eq(T)` 时还实现 `Eq(Self)`。

### `String` — 不可变线程安全字符串

| 方法          | 签名                                       | 说明               |
| ------------- | ------------------------------------------ | ------------------ |
| `new`         | `() -> Self`                               | 空字符串           |
| `from`        | `(s: str) -> Self`                         | 从字符串字面量创建 |
| `len`         | `(self) -> usize`                          | 字节长度           |
| `is_empty`    | `(self) -> bool`                           | 是否为空           |
| `as_bytes`    | `(self) -> Slice(u8)`                      | 字节视图           |
| `byte_at`     | `(self, i: usize) -> u8`                   | 索引处的字节       |
| `concat`      | `(self, other: Self) -> Self`              | 连接               |
| `slice`       | `(self, start: usize, end: usize) -> Self` | 子字符串           |
| `contains`    | `(self, needle: Self) -> bool`             | 搜索               |
| `starts_with` | `(self, prefix: Self) -> bool`             | 前缀检查           |
| `ends_with`   | `(self, suffix: Self) -> bool`             | 后缀检查           |

还实现了 `Eq(Self)`、`Hash` 和 `Send`。

### `Vec(T)` — 持久化向量（写时复制）

约束：`T <: Send`

| 方法         | 签名                                           | 说明           |
| ------------ | ---------------------------------------------- | -------------- |
| `new`        | `() -> Self`                                   | 空向量         |
| `from_slice` | `(s: Slice(T)) -> Self`                        | 从切片批量构造 |
| `len`        | `(self) -> usize`                              | 长度           |
| `is_empty`   | `(self) -> bool`                               | 是否为空       |
| `get`        | `(self, index: usize) -> Option(T)`            | O(1) 访问      |
| `push`       | `(self, value: T) -> Self`                     | 追加           |
| `set`        | `(self, index: usize, value: T) -> Self`       | 更新索引处的值 |
| `pop`        | `(self) -> Self`                               | 移除最后一个   |
| `slice`      | `(self, start: usize, end: usize) -> Self`     | 子向量         |
| `concat`     | `(self, other: Self) -> Self`                  | 连接           |
| `map`        | `(self, f: Impl(Fn(T) -> U)) -> Vec(U)`        | 变换           |
| `filter`     | `(self, f: Impl(Fn(T) -> bool)) -> Self`       | 保留匹配项     |
| `foldl`      | `(self, init: U, f: Impl(Fn(U, T) -> U)) -> U` | 左折叠         |
| `reverse`    | `(self) -> Self`                               | 反转           |
| `zip_with`   | `(self, other: Vec(U), f) -> Vec(R)`           | 配对变换       |

当 `T <: Eq(T)` 时还实现 `Eq(Self)`。

### `Map(K, V)` — 持久化哈希映射（HAMT）

约束：`K <: (Eq(K), Hash, Send)`，`V <: Send`

| 方法           | 签名                                | 说明             |
| -------------- | ----------------------------------- | ---------------- |
| `new`          | `() -> Self`                        | 空映射           |
| `from_entries` | `(pairs: Slice(Pair(K,V))) -> Self` | 从键值对批量构造 |
| `len`          | `(self) -> usize`                   | 条目数           |
| `is_empty`     | `(self) -> bool`                    | 是否为空         |
| `get`          | `(self, key: K) -> Option(V)`       | 查找             |
| `contains_key` | `(self, key: K) -> bool`            | 键是否存在       |
| `insert`       | `(self, key: K, value: V) -> Self`  | 插入/更新        |
| `remove`       | `(self, key: K) -> Self`            | 移除键           |
| `merge`        | `(self, other: Self) -> Self`       | 合并（右覆盖）   |
| `keys`         | `(self) -> List(K)`                 | 所有键           |
| `values`       | `(self) -> List(V)`                 | 所有值           |
| `entries`      | `(self) -> List(MapEntry(K, V))`    | 所有条目         |
| `map_values`   | `(self, f) -> Map(K, U)`            | 变换值           |
| `filter`       | `(self, f) -> Self`                 | 保留匹配项       |

当 `V <: Eq(V)` 时还实现 `Eq(Self)`。

### `Set(T)` — 持久化哈希集合

约束：`T <: (Eq(T), Hash, Send)`

| 方法           | 签名                          | 说明           |
| -------------- | ----------------------------- | -------------- |
| `new`          | `() -> Self`                  | 空集合         |
| `from_slice`   | `(s: Slice(T)) -> Self`       | 从切片批量构造 |
| `len`          | `(self) -> usize`             | 元素数         |
| `is_empty`     | `(self) -> bool`              | 是否为空       |
| `contains`     | `(self, elem: T) -> bool`     | 成员检查       |
| `insert`       | `(self, elem: T) -> Self`     | 添加元素       |
| `remove`       | `(self, elem: T) -> Self`     | 移除元素       |
| `union`        | `(self, other: Self) -> Self` | 集合并集       |
| `intersection` | `(self, other: Self) -> Self` | 集合交集       |
| `difference`   | `(self, other: Self) -> Self` | 集合差集       |
| `is_subset`    | `(self, other: Self) -> bool` | 子集检查       |
| `is_disjoint`  | `(self, other: Self) -> bool` | 不相交检查     |
| `to_list`      | `(self) -> List(T)`           | 收集为列表     |

还实现了 `Eq(Self)`。

### `SortedMap(K, V)` — 持久化有序映射（左倾红黑树）

约束：`K <: (Eq(K), Ord(K), Send)`，`V <: Send`

| 方法           | 签名                                | 说明             |
| -------------- | ----------------------------------- | ---------------- |
| `new`          | `() -> Self`                        | 空映射           |
| `from_entries` | `(pairs: Slice(Pair(K,V))) -> Self` | 从键值对批量构造 |
| `len`          | `(self) -> usize`                   | 条目数           |
| `is_empty`     | `(self) -> bool`                    | 是否为空         |
| `get`          | `(self, key: K) -> Option(V)`       | 查找             |
| `contains_key` | `(self, key: K) -> bool`            | 键是否存在       |
| `insert`       | `(self, key: K, value: V) -> Self`  | 插入/更新        |
| `remove`       | `(self, key: K) -> Self`            | 移除键           |
| `min_key`      | `(self) -> Option(K)`               | 最小键           |
| `max_key`      | `(self) -> Option(K)`               | 最大键           |
| `keys`         | `(self) -> List(K)`                 | 有序键列表       |
| `values`       | `(self) -> List(V)`                 | 键序值列表       |

当 `V <: Eq(V)` 时还实现 `Eq(Self)`。

### `SortedSet(T)` — 持久化有序集合

约束：`T <: (Eq(T), Ord(T), Send)`

| 方法           | 签名                          | 说明           |
| -------------- | ----------------------------- | -------------- |
| `new`          | `() -> Self`                  | 空集合         |
| `from_slice`   | `(s: Slice(T)) -> Self`       | 从切片批量构造 |
| `len`          | `(self) -> usize`             | 元素数         |
| `is_empty`     | `(self) -> bool`              | 是否为空       |
| `contains`     | `(self, elem: T) -> bool`     | 成员检查       |
| `insert`       | `(self, elem: T) -> Self`     | 添加元素       |
| `remove`       | `(self, elem: T) -> Self`     | 移除元素       |
| `min`          | `(self) -> Option(T)`         | 最小元素       |
| `max`          | `(self) -> Option(T)`         | 最大元素       |
| `to_list`      | `(self) -> List(T)`           | 有序列表       |
| `union`        | `(self, other: Self) -> Self` | 集合并集       |
| `intersection` | `(self, other: Self) -> Self` | 集合交集       |
| `difference`   | `(self, other: Self) -> Self` | 集合差集       |
| `is_subset`    | `(self, other: Self) -> bool` | 子集检查       |
| `is_disjoint`  | `(self, other: Self) -> bool` | 不相交检查     |

还实现了 `Eq(Self)`。

## 设计决策

1. **`atomic object` vs `Arc` 包装器**：我们没有将 `object(...)` 包装在 `Arc(...)` 中，
   而是引入了 `atomic object(...)` 作为一等语法。这让编译器完全了解原子性，
   可以进行优化和 trait 派生。

2. **无循环收集器**：`atomic object` 节点不参与循环收集器。
   所有 `std/imm` 数据结构在构造上都是无环的（树、列表、前缀树），
   因此这是安全的，同时避免了 GC 开销。

3. **`Map(T, bool)` 用于集合**：`Set(T)` 和 `SortedSet(T)` 使用 `bool` 而非 `unit`
   作为值类型，因为 `unit` 在 C 中没有表示形式，不能用作生成代码中的结构体字段值。

4. **HAMT 中的独立函数**：`Map` 实现使用独立函数而非方法来处理内部树操作，
   以解决 match 分支中泛型类型解析的限制。

完整设计文档请参见 [`plans/IMMUTABLE_COLLECTIONS.md`](../../plans/IMMUTABLE_COLLECTIONS.md)。
