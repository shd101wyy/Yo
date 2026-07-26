# Index 特征

`Index` 特征为集合类型提供了统一的元素索引访问接口。任何实现了 `Index` 的类型都可以使用熟悉的 `value(index)` 调用语法，使自定义集合的行为与内置数组和切片一致。

## 概述

```rust
// 内置数组和自定义类型使用相同的语法：
(arr : [i32; 3]) = [i32(10), i32(20), i32(30)];
v := arr(usize(1));  // 20

(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0));  // 42
```

## Index 特征定义

`Index` 特征在 prelude 中定义，所有 Yo 程序都可以使用：

```rust
Index :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    index : (fn(inout(self) : Self, idx : Idx) -> *(Self.Output))
  )
);
```

- **`Idx`**：索引类型（例如 `usize`，或自定义的键类型）。
- **`Output`**：关联类型，指定返回的元素类型。
- **`index`**：方法以 `inout` 形式接收 `self`（这样它能返回指向调用者存储空间内部的指针）和索引，返回指向元素的**指针**。

`index` 方法返回 `*(Output)`（指针），在值上下文中会自动解引用。这种设计使得读写操作都可以通过同一个特征实现：

```rust
// 读取：自动解引用
v := collection(idx);        // 调用 index(collection, idx).*

// 写入：使用调用语法赋值（推荐）
collection(idx) = val;       // 调用 index(collection, idx)，通过指针写入

// 取地址：直接返回指针
p := &(collection(idx));     // 调用 index(collection, idx)，不解引用
```

## 实现 Index

### 基本实现

```rust
MyArray :: struct(data0: i32, data1: i32, data2: i32);

impl(MyArray, Index(usize)(
  Output : i32,
  index : (fn(inout(self) : Self, idx : usize) -> *(Self.Output))(
    cond(
      (idx == usize(0)) => &(self.data0),
      (idx == usize(1)) => &(self.data1),
      (idx == usize(2)) => &(self.data2),
      true => panic("MyArray: index out of bounds")
    )
  )
));

// 使用：
(arr : MyArray) = MyArray(i32(10), i32(20), i32(30));
assert((arr(usize(0)) == i32(10)), "应该是 10");
assert((arr(usize(1)) == i32(20)), "应该是 20");
```

### 泛型实现

对于泛型类型如 `ArrayList(T)`，在 impl 中使用 `generic`：

```rust
impl(generic(T : Type), ArrayList(T), Index(usize)(
  Output : T,
  index : (fn(inout(self) : Self, idx : usize) -> *(Self.Output))({
    assert((idx < self._length), "ArrayList: index out of bounds");
    match(self._ptr,
      .Some(_ptr) => (_ptr &+ idx),
      .None => panic("ArrayList: index on empty list")
    )
  })
));
```

## 取地址优化

当你写 `&(collection(idx))` 时，编译器检测到这个模式并跳过解引用步骤。不会生成：

```c
// 未优化（假设）：
T temp = *Index_index(&collection, idx);
T* result = &temp;  // ← 悬空指针！
```

而是生成：

```c
// 优化后：
T* result = Index_index(&collection, idx);  // ← 直接指针
```

这对正确性至关重要——指针保持有效并直接指向集合的存储空间。你可以用它进行修改：

```rust
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(100));

// 通过调用语法赋值修改
list(usize(0)) = i32(999);
assert((list(usize(0)) == i32(999)), "应该是 999");
```

## 范围切片

数组和切片支持基于范围的切片操作，使用 `..`（不包含结尾）和 `..=`（包含结尾）：

```rust
(arr : [i32; 5]) = [i32(10), i32(20), i32(30), i32(40), i32(50)];

// 不包含结尾的范围：索引 1, 2, 3 处的元素
s := arr(usize(1)..usize(4));
assert((s.len() == usize(3)), "长度为 3");
assert((s(usize(0)) == i32(20)), "第一个元素是 20");

// 包含结尾的范围：索引 1, 2, 3 处的元素
s2 := arr(usize(1)..=usize(3));
assert((s2.len() == usize(3)), "长度为 3");
assert((s2(usize(0)) == i32(20)), "第一个元素是 20");

// 对切片再切片
sub := s(usize(0)..usize(2));
assert((sub.len() == usize(2)), "子切片长度为 2");
```

`..` 和 `..=` 运算符产生 `Range(usize)` 和 `RangeInclusive(usize)` 类型，这些类型在 prelude 中定义：

```rust
Range :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start: T, end: T)
);

RangeInclusive :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start: T, end: T)
);
```

范围切片创建一个**切片视图**——它不复制数据。切片与原始数组或切片共享内存。

## 内置索引与特征索引

内置数组和切片类型（`[T; N]` 和 `[T]`）使用内置索引，生成直接的 C 数组访问（`arr.data[idx]`）。这比通过 Index 特征更高效，也避免了递归问题。

自定义类型和标准库集合（如 `ArrayList`）使用 Index 特征。调度顺序为：

1. 内置数组/切片索引（如果被调用者是 `[T; N]` 或 `[T]`）
2. 范围切片 `..` 或 `..=`（如果参数是范围表达式）
3. Index 特征分派（在被调用者类型上查找 `Index(typeof(arg))` 实现）
4. 普通函数调用

## 与运算符内联使用

索引表达式可以无缝地与运算符配合使用。结果在传递给运算符之前自动解引用：

```rust
(arr : [i32; 3]) = [i32(10), i32(20), i32(30)];

// 比较
assert((arr(usize(0)) == i32(10)), "与 == 配合使用");
assert((arr(usize(0)) < arr(usize(1))), "与 < 配合使用");

// 算术运算
sum := (arr(usize(0)) + arr(usize(1)));
assert((sum == i32(30)), "与 + 配合使用");
```

## 标准库实现

以下标准库类型实现了 `Index` 特征：

### ArrayList(T) — `Index(usize)`

```rust
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0));             // 42
&(list(usize(0))).* = i32(99);  // 原地修改
```

### HashMap(K, V) — `Index(K)`

```rust
(map : HashMap(i32, i32)) = HashMap(i32, i32).new();
map.set(i32(1), i32(100));
v := map(i32(1));               // 100
&(map(i32(1))).* = i32(999);   // 原地修改
// map(i32(99))                 // panic：键不存在
```

要求 `K <: (Eq(K), Hash)`。

### BTreeMap(K, V) — `Index(K)`

```rust
(map : BTreeMap(i32, i32)) = BTreeMap(i32, i32).new();
map.set(i32(5), i32(500));
v := map(i32(5));               // 500
&(map(i32(5))).* = i32(77);   // 原地修改
// map(i32(99))                 // panic：键不存在
```

要求 `K <: Ord(K)`。

### Deque(T) — `Index(usize)`

```rust
(d : Deque(i32)) = Deque(i32).new();
d.push_back(i32(10));
d.push_back(i32(20));
v := d(usize(0));               // 10
&(d(usize(0))).* = i32(555);  // 原地修改
```

O(1) 随机访问，正确处理环形缓冲区回绕。

### String — `Index(usize)`

```rust
(s : String) = `Hello`;
b := s(usize(0));  // u8(72) — 字节级访问（'H'）
```

返回 `u8` — 对内部 UTF-8 缓冲区的字节级索引。如需字符级访问，请使用 `chars()` 迭代器。

## 错误处理

通过 Index 特征的越界访问会在运行时导致 **panic**。这与 Rust 的行为一致。如需返回 `Option(T)` 的安全访问，请使用 `ArrayList` 的 `get` 方法：

```rust
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));

// 越界会 panic：
// v := list(usize(99));  // ← panic！

// 安全访问：
match(list.get(usize(99)),
  .Some(v) => println(`得到: ${v}`),
  .None => println(`未找到`)
);
```
