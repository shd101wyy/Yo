# 字符串：字节索引契约

Yo 的字符串是 UTF-8 编码的，**每一个字符串索引都是字节偏移** —— 与 Rust 和
Go 的模型相同。这条规则贯穿日常代码里会遇到的所有字符串类型，并且在编译期同样
成立：

| 类型 | `len()` | 切片 | 元素访问 |
| --- | --- | --- | --- |
| `String`（`std/string`） | 字节数，O(1) | `substring(a, b)` —— 字节 | `s(i)` → `u8`，`at(i)` → `Option(rune)` |
| `str`（prelude；字符串字面量） | 字节数 | `s(a..b)` —— 零拷贝字节窗口 | `bytes(i)` → `u8` |
| `StringBuilder`（`std/string`） | 字节数 | — | — |
| `comptime_str`（编译期） | 字节数 | `slice(a, b)` / `s(a..b)` —— 字节 | `s(i)` → 单 rune 的 `comptime_str` |

`str` 和 `StringBuilder` 一直是字节基准；`String` 在 D4 迁移中与它们对齐
（2026-08-26，`plans/STD_API_AUDIT_D4_PLAN.md`），编译期字符串操作也在同一
役中完成对齐。字符串索引只有一个故事。

## 唯一的规则

字符串索引命名的是一个**字节**，并且字符串方法接受或返回的每个索引都必须落在
**UTF-8 字符边界**上（某个 rune 的首字节，或 `len()`）。ASCII 文本不受影响
—— 它的每个字节都是边界。

```rust
open(import("std/string"));

//        a=1B @0   é=2B @1   中=3B @3   𝄞=4B @6   —— 共 10 字节，4 个 rune
s := String.from("aé中𝄞");
s.len();                              // usize(10) —— 字节数，O(1)
s.chars().count();                    // usize(4)  —— rune 数量，O(n)
s.substring(usize(3), usize(6));      // "中" —— 字节区间 [3, 6)
s.index_of(String.from("中"));        // .Some(usize(3)) —— 字节偏移，
                                      //   可直接回喂给 substring
```

`index_of`、`last_index_of`、`s(a..b)` / `s(a..=b)` 区间语法糖，以及
`contains` / `starts_with` / `ends_with` 的可选位置参数，全部使用同一单位。
`Pattern` trait 的各个方法也是。

## 边界策略

在 `substring` 上陈述一次，同样适用于 `s(a..b)` 语法糖：

- **越界会被钳制（CLAMP）。** 超过 `len()` 的端点被拉回到 `len()`，
  `start >= end` 得到空字符串。
- **非边界索引会 PANIC。** 落在 rune 内部的端点是程序员错误 —— 一个来自错误
  基准的字节偏移 —— 而不是范围问题；迁就它会交出非法的 UTF-8。
- **`try_substring(a, b)`** 是不 panic 的形式：对 `a > b`、`b > len()` 或
  rune 内部的端点返回 `.None`（对应 Rust 的 `s.get(a..b)`）。
- **`floor_char_boundary(i)` / `ceil_char_boundary(i)`** 把任意字节偏移向
  前/向后吸附到边界上（钳制到 `len()`），供做字节运算的调用者使用。
- **`is_char_boundary(i)`** 直接回答这个问题：`0` 和 `len()` 永远是边界；
  超出末尾的索引永远不是。

```rust
s := String.from("aé中𝄞");
s.substring(usize(1), usize(2));      // PANIC —— 字节 2 在 é 内部
s.try_substring(usize(1), usize(2));  // .None —— 同一区间，礼貌地拒绝
s.floor_char_boundary(usize(2));      // usize(1) —— 吸附回 é 的起点
s.substring(usize(0), usize(99));     // "aé中𝄞" —— 越界钳制
```

`at(i)` 解码**从**字节 `i` 开始的 rune，对字节偏移无法命名 rune 的三种情况
返回 `.None`：达到或超过 `len()`、落在续延字节上、或字节无法解码。因此
`while(i < s.len())` 里逐字节调用 `at(i)` 会经过续延字节 —— 遍历 rune 请改用
`chars()` / `char_indices()`。

## 搜索方法从不 panic —— 但有一个被钉住的例外

`index_of` / `last_index_of` / `contains` / `starts_with` / `ends_with` 有意
不对位置参数做边界检查：UTF-8 是自同步编码，合法 UTF-8 的 needle 不可能从
续延字节处开始匹配。落在 rune 中间的 `from_index` / `position` 无法凭空制造
命中，只会得到 `false` / `.None`。对非空 needle，这些方法返回的每个索引都是
rune 边界。

**空 needle 是例外，其行为已被钉住：**

- `index_of("", i)` **原样返回 `.Some(i)`，不做任何校验** —— 包括落在 rune
  内部的 `i` 和超过 `len()` 的 `i`。（JavaScript 的 `indexOf("")` 会钳制到
  长度；这里不钳制，D4 之前的版本同样不钳制。）
- `last_index_of("", i)` 无视 `i`，一律返回 `len()`（Rust `rfind("")` 的
  形状），因此这是结果可能超过调用者所给上限的唯一情形。

超出末尾的偏移在下游是无害的，因为 `substring` 会钳制；但 rune 中间的偏移会
让 `substring` panic。既把搜索结果直接回喂给切片、又可能拿到空 needle 的调用
者，应该改走 `try_substring`，或先用 `floor_char_boundary` 吸附。

## rune 操作：用迭代器，而不是字符索引

API 中没有按字符索引的切片。rune 操作由 `chars()` / `char_indices()` 与迭代
器方法组合完成：

```rust
s := String.from("aé中𝄞");

// rune 数量。O(n) —— 迭代器写法让这份开销在调用处可见（std 里的 `len()`
// 处处都是 O(1)；Rust 把 `len()` 留给 ExactSizeIterator，而 chars 迭代器
// 不是）。
n := s.chars().count(); // usize(4)

// 携带字节偏移遍历 rune：p._0 = 字节偏移，p._1 = rune。
for(s.char_indices(), (p) => { ... });

// 截断到至多 n 个 rune：第 n 个 rune 的起始字节偏移就是切点；
// 不足 n+1 个 rune 时保留整个字符串。
cut := match(
  s.char_indices().nth(usize(2)),
  .Some(p) => s.substring(usize(0), p._0),
  .None => s
); // "aé"

// 第一个 rune + 其余部分。
first := s.chars().next(); // Option(rune)
```

`chars()` 与 `char_indices()` 建立在 `std/encoding/utf8` 之上，继承其对畸形
输入的行为：在第一个无法解码的序列处停止。

（`bytes_len()` 作为 `len()` 的弃用别名保留；`char_len()`、
`char_substring()` 和 `truncate_chars()` 目前仍存在，但已弃用并将被移除
—— 请改写上面的惯用法。）

## 元素访问：`s(i)` 是一个字节

`String` 上的 `Index` trait 返回偏移 `i` 处的**字节**（`u8`）—— 对 UTF-8
缓冲区的字节级访问，没有边界要求。`byte_at(i)` 是同一件事的具名版本。解码用
`at(i)`。

## 编译期字符串共享同一基准

自 D4 PR 7 起，`comptime_str` 的操作同样以字节为基准：

```rust
s :: "aé中𝄞";
comptime_assert(s.len() == 10);        // 字节数，与运行期 len() 一致
comptime_assert(s.slice(3, 6) == "中"); // 字节偏移，与 substring 一致
comptime_assert(s(1) == "é");           // 从字节 1 开始的那个 rune
comptime_assert(s(3 .. 6) == "中");     // 字节区间
```

两个编译期特有的要点：

- **rune 中间的偏移是编译错误**，不是 panic —— 对上面的字符串，编译器会拒绝
  `s(2)`（"not on a UTF-8 character boundary"）而不是中止进程。越界索引同样
  是编译错误；`slice` 对越界仍然钳制，一如既往。
- **`s(i)` 产出的是单 rune 的 `comptime_str`，不是字节。** 编译期字符串是
  文本，不是字节缓冲区，所以编译期 `s(i)` 对应运行期的 `at(i)`（从字节 `i`
  开始的 rune），而不是运行期的 `s(i)`（`u8`）。这个结果类型上的差异早于
  字节迁移，是有意保留的。

## 实用规则

- 字节循环用 `len()` 做上界、用 `byte_at(i)` 读取 —— 两个基准现在天然一致。
- `index_of` 返回什么就直接喂回 `substring`（空 needle 除外 —— 见上文）。
- 永远不要在字节上做"索引 + 1 个 rune"这类算术；用 `char_indices()` 或
  `ceil_char_boundary`。
- 想表达"有多少个字符"时，写 `s.chars().count()`；想表达"缓冲区多大"时，写
  `s.len()`。
- `Content-Length` 这类协议字段数的是字节；如今 `len()` 默认就是正确答案。

`std/imm` 中的不可变字符串正在同一迁移的后续步骤中对齐到同样的契约；见
`plans/STD_API_AUDIT_D4_PLAN.md`。
