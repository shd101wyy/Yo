# 不可变集合 (`std/imm`)

`std/imm` 提供基于 `atomic object(...)` 的持久化不可变集合。每一次“修改”
都会返回一个**新值**，旧值仍然保持有效，因此结构共享可以安全地跨线程进行。

本文档有意保持为**概览与设计说明**。对于最新的逐模块 API，请优先使用
本地或 CI 生成的 `yo doc` 文档。

## 共同特性

| 特性               | 说明                                               |
| ------------------ | -------------------------------------------------- |
| **持久化**         | 插入、更新、删除后旧版本仍然有效。                 |
| **线程安全共享**   | 底层节点使用 `atomic object(...)` 与原子引用计数。 |
| **带 `Send` 约束** | 集合类型构造器要求元素/值类型实现 `Send`。         |
| **天然无环**       | 这些数据结构是树、链表、前缀树，不依赖循环收集器。 |

## 集合概览

| 模块                 | 类型              | 适用场景                             | 底层结构                  |
| -------------------- | ----------------- | ------------------------------------ | ------------------------- |
| `std/imm/list`       | `List(T)`         | 高效前置插入、栈式工作负载、递归算法 | Cons 链表                 |
| `std/imm/string`     | `String`          | 可共享的不可变 UTF-8 文本            | 不可变字节缓冲区          |
| `std/imm/vec`        | `Vec(T)`          | 带索引读取、偏向追加的不可变工作流   | 写时复制平坦数组          |
| `std/imm/map`        | `Map(K, V)`       | 基于哈希的快速查找                   | HAMT                      |
| `std/imm/set`        | `Set(T)`          | 基于哈希的成员测试                   | `Map(T, bool)` 包装       |
| `std/imm/sorted_map` | `SortedMap(K, V)` | 有序键、min/max、确定性遍历          | 左倾红黑树                |
| `std/imm/sorted_set` | `SortedSet(T)`    | 有序成员测试                         | `SortedMap(T, bool)` 包装 |

## 快速开始

```rust
{ List } :: import "std/imm/list";
{ Map } :: import "std/imm/map";
{ SortedSet } :: import "std/imm/sorted_set";

xs := List(i32).new().prepend(i32(3)).prepend(i32(2)).prepend(i32(1));
assert((xs.head().unwrap() == i32(1)), "head is 1");

m := Map(i32, i32).new();
m = m.insert(i32(1), i32(100));
m2 := m.insert(i32(2), i32(200));
assert((m.len() == usize(1)), "原始映射不变");
assert((m2.len() == usize(2)), "新映射包含两个条目");

s := SortedSet(i32).new();
s = s.insert(i32(5)).insert(i32(1)).insert(i32(3));
```

## 如何选择集合

- 当你更关心前置插入和递归分解时，选择 **`List(T)`**。
- 当你需要不可变的索引访问或切片式工作流时，选择 **`Vec(T)`**。
- 当你需要基于哈希的查找与成员判断时，选择 **`Map(K, V)`** / **`Set(T)`**。
- 当顺序本身就是 API 的一部分时，选择 **`SortedMap(K, V)`** / **`SortedSet(T)`**。
- 当你需要可共享的不可变字符串时，选择 **`imm.String`**；如果需要可变字符串构建能力，继续使用 `std/string.String`。

## API 参考

最新签名与文档注释请使用生成文档：

```bash
yo doc ./std
yo doc ./std/imm
```

在本仓库里，CI 会发布标准库的生成文档。逐方法的 API 参考应优先查看这些页面。

## 设计说明

1. **直接使用 `atomic object(...)`，而不是再包一层 `Arc(...)`**：集合本身就是原子引用计数类型，因此编译器可以直接理解其所有权模型。
2. **不参与循环收集**：不可变集合在结构上天然无环，因此将其排除在循环收集之外可以减少不必要的 GC 开销。
3. **`Set(T)` / `SortedSet(T)` 内部用 `bool` 表示值**：`unit` 在 C 中没有表示形式，因此集合包装器使用 `Map(T, bool)` / `SortedMap(T, bool)`。
4. **API 文档由生成工具负责**：本文档聚焦在概念、取舍与模块选择上，而不是手动维护签名表。

## 相关文档

- `plans/IMMUTABLE_COLLECTIONS.md` —— 实现计划与设计历史
- `docs/zh-CN/ARC.md` —— 共享所有权概览
- 生成的 `yo doc` 输出 —— 逐模块 API 详情
