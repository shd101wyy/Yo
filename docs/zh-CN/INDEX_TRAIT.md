# Index 特征

`Index` 特征为集合类型提供了统一的元素索引访问接口。任何实现了 `Index` 的类型都可以使用熟悉的 `value(index)` 调用语法，使自定义集合的行为与内置数组和切片一致。

## 概述

```yo
// 内置数组和自定义类型使用相同的语法：
(arr : [i32 ; 3]) = [i32(10), i32(20), i32(30)];
v := arr(usize(1)); // 20
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0)); // 42
```

## Index 特征定义

`Index` 特征及其写入的一半 `IndexMut` 在 prelude 中定义，所有 Yo 程序都可以使用：

```yo
Index :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    index : (fn(self : &Self, idx : Idx) -> &Self.Output)
  )
);
IndexMut :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(
    Output : Type,
    index_mut : (fn(self : &mut Self, idx : Idx) -> &mut Self.Output)
  )
);
```

- **`Idx`**：索引类型（例如 `usize`，或自定义的键类型），按值传入。
- **`Output`**：关联类型，指定元素类型。同一索引类型的 `Index` 与 `IndexMut` 的 `Output` 一致。
- **`index`**：读投影：以共享方式借用容器，产出元素的位置。
- **`index_mut`**：可变投影：以独占方式借用容器，产出可写入的元素位置。

```yo
// 读取：调用 index，然后读取该位置
v := collection(idx);
// 写入：使用调用语法赋值，调用 index_mut 并写入该位置
collection(idx) = val;
// 取地址：调用 index_mut，返回该位置的地址
p := addr_of(collection(idx));
```

## 读与写：`Index` 与 `IndexMut`

值语义默认化（V2b，决策 34）像 Rust 一样把元素访问一分为二。

- **下标调用哪个方法。** 作为值读取的 `x(i)` 调用 `index`。每一次写都调用 `index_mut`：`x(i) = v`、元素的字段（`x(i).f = v`）、嵌套元素（`grid(i)(j) = v`）、元素上的 `self : &mut Self` 方法（`x(i).push(v)`）、`&mut` 实参（`f(&mut x(i))`）、`addr_of(x(i))`，以及对它的 `&mut` 局部借用。`x(i) = (x(i) + 1)` 这样的读-改-写先读后写。Yo 没有复合赋值运算符。
- **只读元素。** 只实现 `Index` 而不实现 `IndexMut` 的类型，其元素是只读的；通过 `x(i)` 写入会得到一个指出缺少 `IndexMut` 的编译错误。
- **可写的接收者。** `index_mut` 接收 `self : &mut Self`，所以通过 `x` 的只读借用（一个 `x : &T` 参数）写 `x(i)` 是 E0908。
- **同一个 `Output`。** 同一索引类型的 `Index` 与 `IndexMut` 必须给出相同的 `Output`。

### 投影

`index` 和 `index_mut` 是**投影**（决策 24）：结果为借用的函数，即 `-> &T` 或 `-> &mut T`。投影产出一个位置，其结果表达式就是这个位置，并带上与结果类型一致的借用符号：

```yo ignore
Trio :: struct(a : i32, b : i32, c : i32);
impl(
  Trio,
  Index(usize)(
    Output : i32,
    index : (fn(self : &Self, idx : usize) -> &Self.Output)(
      cond(
        (idx == usize(0)) => &self.a,
        (idx == usize(1)) => &self.b,
        true => &self.c
      )
    )
  )
);
impl(
  Trio,
  IndexMut(usize)(
    Output : i32,
    index_mut : (fn(self : &mut Self, idx : usize) -> &mut Self.Output)(
      cond(
        (idx == usize(0)) => &mut self.a,
        (idx == usize(1)) => &mut self.b,
        true => &mut self.c
      )
    )
  )
);
t := Trio(a : i32(1), b : i32(2), c : i32(3));
t(usize(1)) = i32(20); // index_mut
assert(t(usize(1)) == i32(20), "index");
```

投影遵循以下规则：

- **位置从借用参数出发。** 位置以投影自己的某个 `&`/`&mut` 参数为根，经由字段和元素访问到达。局部变量、临时值、按值参数和模块级绑定都会被拒绝，因为它们的存储随调用结束。`-> &mut T` 投影的位置必须以 `&mut` 参数为根。
- **借用符号与结果一致。** `-> &T` 投影写 `&place`，`-> &mut T` 投影写 `&mut place`。
- **裸指针位置。** 在 `pragma(Pragma.AllowUnsafe)` 文件中，位置可以是裸指针解引用（`&(p &+ i).*`），结果也可以直接是裸指针 `*T`。std 的缓冲区使用的就是这种形式。
- **ABI。** 投影的 `&T` 参数按指针传递（在其他地方 `&T` 参数按值传递），所以它返回的位置属于调用者。
- **在哪里调用投影。** 目前投影只能通过其特征分派的下标（`x(i)`）到达。像 `t.index(i)` 或 `f(&x)` 这样的直接调用在决策 24 的其余部分落地之前是编译错误：其余部分指把投影结果用作接收者、实参、操作数，或绑定到局部变量。

## 实现 Index

### 基本实现

```yo
MyArray :: struct(data0 : i32, data1 : i32, data2 : i32);

impl(
  MyArray,
  Index(usize)(
    Output : i32,
    index : (fn(self : &Self, idx : usize) -> &Self.Output)(
      cond(
        (idx == usize(0)) => &self.data0,
        (idx == usize(1)) => &self.data1,
        (idx == usize(2)) => &self.data2,
        true => panic("MyArray: index out of bounds")
      )
    )
  )
);
// 没有这个 impl 时，`arr(i)` 可以读取，但 `arr(i) = v` 是编译错误。
impl(
  MyArray,
  IndexMut(usize)(
    Output : i32,
    index_mut : (fn(self : &mut Self, idx : usize) -> &mut Self.Output)(
      cond(
        (idx == usize(0)) => &mut self.data0,
        (idx == usize(1)) => &mut self.data1,
        (idx == usize(2)) => &mut self.data2,
        true => panic("MyArray: index out of bounds")
      )
    )
  )
);

// 使用：
(arr : MyArray) = MyArray(i32(10), i32(20), i32(30));
assert(arr(usize(0)) == i32(10), "应该是 10");
assert(arr(usize(1)) == i32(20), "应该是 20");
```

### 泛型实现

对于泛型类型如 `ArrayList(T)`，在 impl 中使用 `generic`。std 的缓冲区产出指向缓冲区的裸指针（位于 `pragma(Pragma.AllowUnsafe)` 文件中），其 `IndexMut` impl 以 `self : &mut Self` 和 `-> &mut Self.Output` 重复同样的函数体：

```yo
impl(
  generic(T : Type),
  ArrayList(T),
  Index(usize)(
    Output : T,
    index : (fn(self : &Self, idx : usize) -> &Self.Output)({
      assert(idx < self._length, "ArrayList: index out of bounds");
      match(
        self._ptr,
        .Some(_ptr) => _ptr.add(idx),
        .None => panic("ArrayList: index on empty list")
      )
    })
  )
);
```

## 取地址优化

当你写 `addr_of(collection(idx))` 时，编译器检测到这个模式并跳过解引用步骤。不会生成：

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

```yo
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(100));

// 通过调用语法赋值修改
list(usize(0)) = i32(999);
assert(list(usize(0)) == i32(999), "应该是 999");
```

## 范围切片

数组和切片支持基于范围的切片操作，使用 `..`（不包含结尾）和 `..=`（包含结尾）：

```yo
(arr : [i32 ; 5]) = [i32(10), i32(20), i32(30), i32(40), i32(50)];

// 不包含结尾的范围：索引 1, 2, 3 处的元素
s := arr(usize(1) .. usize(4));
assert(s.len() == usize(3), "长度为 3");
assert(s(usize(0)) == i32(20), "第一个元素是 20");

// 包含结尾的范围：索引 1, 2, 3 处的元素
s2 := arr(usize(1) ..= usize(3));
assert(s2.len() == usize(3), "长度为 3");
assert(s2(usize(0)) == i32(20), "第一个元素是 20");

// 对切片再切片
sub := s(usize(0) .. usize(2));
assert(sub.len() == usize(2), "子切片长度为 2");
```

`..` 和 `..=` 运算符产生 `Range(usize)` 和 `RangeInclusive(usize)` 类型，这些类型在 prelude 中定义：

```yo
Range :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start : T, end : T)
);

RangeInclusive :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(start : T, end : T)
);
```

范围切片创建一个**切片视图**——它不复制数据。切片与原始数组或切片共享内存。

## 内置索引与特征索引

内置数组和切片类型（`[T; N]` 和 `[T]`）使用内置索引，生成直接的 C 数组访问（`arr.data[idx]`）。这比通过 Index 特征更高效，也避免了递归问题。

自定义类型和标准库集合（如 `ArrayList`）使用 Index 特征。调度顺序为：

1. 内置数组/切片索引（如果被调用者是 `[T; N]` 或 `[T]`）
2. 范围切片 `..` 或 `..=`（如果参数是范围表达式）
3. Index 特征分派（在被调用者类型上查找 `Index(type_of(arg))` 实现）
4. 普通函数调用

## 与运算符内联使用

索引表达式可以无缝地与运算符配合使用。结果在传递给运算符之前自动解引用：

```yo
(arr : [i32 ; 3]) = [i32(10), i32(20), i32(30)];

// 比较
assert(arr(usize(0)) == i32(10), "与 == 配合使用");
assert(arr(usize(0)) < arr(usize(1)), "与 < 配合使用");

// 算术运算
sum := (arr(usize(0)) + arr(usize(1)));
assert(sum == i32(30), "与 + 配合使用");
```

## 标准库实现

以下标准库类型实现了 `Index` 特征：

### ArrayList(T) — `Index(usize)`

```yo
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0)); // 42
addr_of(list(usize(0))).* = i32(99); // 原地修改
```

### HashMap(K, V) — `Index(K)`

```yo
(map : HashMap(i32, i32)) = HashMap(i32, i32).new();
map.insert(i32(1), i32(100));
v := map(i32(1)); // 100
addr_of(map(i32(1))).* = i32(999); // 原地修改
// map(i32(99))                 // panic：键不存在
```

要求 `K <: (Eq(K), Hash)`。

### BTreeMap(K, V) — `Index(K)`

```yo
(map : BTreeMap(i32, i32)) = BTreeMap(i32, i32).new();
map.insert(i32(5), i32(500));
v := map(i32(5)); // 500
addr_of(map(i32(5))).* = i32(77); // 原地修改
// map(i32(99))                 // panic：键不存在
```

要求 `K <: Ord(K)`。

### Deque(T) — `Index(usize)`

```yo
(d : Deque(i32)) = Deque(i32).new();
d.push_back(i32(10));
d.push_back(i32(20));
v := d(usize(0)); // 10
addr_of(d(usize(0))).* = i32(555); // 原地修改
```

O(1) 随机访问，正确处理环形缓冲区回绕。

### String — 只读的 `Index(usize)`

`String` 实现 `Output : u8` 的 `Index(usize)`，且不实现 `IndexMut`：`s(i)` 读取偏移 `i` 处的字节，越界时 panic，与 `byte_at(i)` 相同。

```yo
(s : String) = `Hello`;
b := s(usize(0)); // u8(72) — 该字节（'H'）；越界时 panic
c := s.get_byte(usize(9)); // .None — 带检查的形式
```

`s(i) = b` 是编译错误，并指出缺少 `IndexMut`：写入会改变所有共享该缓冲区的字符串，还可能留下非法的 UTF-8。Rust 的 `String` 同样没有可写的字节索引。如需字符级访问，请使用 `chars()` 迭代器。区间语法糖 `s(a..b)` 构建一个新字符串；它和其余所有字符串索引（`substring`、`index_of` 等）都是字节偏移 —— 完整契约见 [STRINGS.md](./STRINGS.md)。

## 错误处理

通过 Index 特征的越界访问会在运行时导致 **panic**。这与 Rust 的行为一致。如需返回 `Option(T)` 的安全访问，请使用 `ArrayList` 的 `get` 方法：

```yo
(list : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));

// 越界会 panic：
// v := list(usize(99));  // ← panic！
// 安全访问：
match(
  list.get(usize(99)),
  .Some(v) => println(`得到: ${v}`),
  .None => println(`未找到`)
);
```
