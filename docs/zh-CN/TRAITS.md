# Trait

Trait 与 `impl`：定义与实现 trait、静态方法、关联类型、一致性、调用有歧义的方法、
`Impl(Trait)` 类型、下标 trait `Index`/`IndexMut` 以及 `Deref`。Trait 对象（`Dyn`）见
[TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md)；派生 impl 见 [DERIVE_TRAITS.md](./DERIVE_TRAITS.md)。

## 定义与实现 trait

Trait 定义了一组可以为类型实现的函数和类型集合。它们的工作方式类似于 Rust 中的 trait。注意，`impl` 的第一个参数是接收者类型，后跟 trait 实现。

Trait 被定义为一个返回 `Trait` 类型的函数，其中包含字段定义。

```yo
// 定义一个 trait（类似于 Rust 中的 trait）
Summary :: trait(
  summarize : (fn(self : &mut Self) -> String)
);

Display :: trait(
  display : (fn(self : &mut Self) -> String),
  where(Self <: Summary) // 约束
);

NewsArticle :: struct(
  headline : String,
  location : String,
  author : String,
  content : String
);

// 为 NewsArticle 实现 Summary trait
impl(
  NewsArticle,
  Summary(
    summarize : (
      self ->
        `${self.headline}, by ${self.author} (${self.location})`
    )
  )
);

// 为 NewsArticle 实现 Display trait
impl(
  NewsArticle,
  Display(
    display : (
      self ->
        `Headline: ${self.headline}\n`
    )
  )
);

// 传入函数
notify :: (fn(item : &mut NewsArticle) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
});

// 带 trait 约束的泛型函数
notify2 :: (fn(generic(T : Type), item : &mut T, where(T <: Display)) -> unit)({
  println(`Breaking news! ${item.summarize()}`);
  println(`Breaking news! ${item.display()}`);
});
```

约束写作 `T <: Trait`，读作“`T` 实现了 `Trait`”；同一类型上的多个约束写成元组 `T <: (Clone, Hash)`。所有 `where(...)` 都使用同一写法：函数、类型构造器、trait、impl 和 derive 的 `where`。`where(T : Trait)` 是错误 E0624，在子句定义处报告（`:` 给名字指定类型或种类），`yo fix` 会把它改写为 `<:`。

### 静态 trait 方法

没有 `self` 参数的 trait 方法就是静态方法。可以在实现了该 trait 的类型上调用（`Point.make(...)`），也可以在受该 trait 约束的类型参数上调用（`T.make(...)`）。构造器风格的 trait 就是这样写的，`FromJson` 的 `from_json(v)` 即是一例。

```yo
{ println } :: import("std/fmt");

// 没有 `self` 的 trait 方法是静态（构造器风格）方法。
Make :: trait(make : (fn(n : i32) -> Self));

Point :: struct(x : i32, y : i32);
impl(Point, Make(make : (n -> Point(x : n, y : n))));

Meters :: struct(v : i32);
impl(Meters, Make(make : (n -> Meters(v : (n * i32(1000))))));

// 在类型上调用，或在泛型函数体中通过类型参数调用。
build :: (fn(comptime(T) : Type, n : i32, where(T <: Make)) -> T)(T.make(n));

main :: (fn() -> unit)({
  p := Point.make(i32(3));
  m := build(Meters, i32(2));
  println(`${p.x} ${p.y} ${m.v}`); // 3 3 2000
});
export(main);
```

### trait 的 `where` 子句与关联类型

trait 要先声明关联类型，再声明引用它的成员（先写 `Item : Type`，再写 `next : (fn(...) -> Option(Self.Item))`）。它的 `where` 子句可以借助自身的投影去约束**另一个**类型，`IntoIterator` 的 `where(Self.IntoIter <: Iterator(Item := Self.Item))` 就是如此。但不能把 `Self` 本身的关联类型绑定到 `Self` 自己的投影上：

```yo
Source :: trait(Item : Type, pull : (fn(self : &mut Self) -> Option(Self.Item)));

// 错误：Expected type for associated type constraint "Item", got: (Self.Item)
Peekable :: trait(
  Item : Type,
  peek : (fn(self : Self) -> Option(Self.Item)),
  where(Self <: Source(Item := Self.Item))
);
```

下面两种写法都可以：

```yo
Source :: trait(Item : Type, pull : (fn(self : &mut Self) -> Option(Self.Item)));

// 约束 `Self`，但不绑定它的关联类型……
Rewindable :: trait(
  rewind : (fn(self : &mut Self) -> unit),
  where(Self <: Source)
);

// ……或者借助 `Self.Item` 约束另一个关联类型。
Pullable :: trait(
  Item : Type,
  Iter : Type,
  source : (fn(self : Self) -> Self.Iter),
  where(Self.Iter <: Source(Item := Self.Item))
);
```

### 一致性：每个类型对每个 trait 只有一个 impl

在整个程序中，一个类型最多实现某个 trait 一次（`plans/reference/TRAIT_COHERENCE.md`）。以下情况都是错误 E0612：

- 第二个 `impl(P, Summary(...))`，无论在同一模块还是其他模块；
- 被导入的模块或 prelude 已经为该类型实现过的 trait，再写一个 impl，例如 `impl(i32, ToString(...))`；
- 一揽子 impl（`impl(generic(T), where(T <: Bound), T, Summary(...))`）与某个满足 `Bound` 的类型的 `Summary` 具体 impl 同时存在，无论注册顺序。

Yo 没有特化，更具体的 impl 不会覆盖更一般的 impl；在此规则之前，先注册的 impl 会静默胜出，另一个成为死代码。泛型 trait 的两个实例是不同的 trait（`Eq(String)` 与 `Eq(str)`），约束互不重叠的一揽子 impl 也没有问题。

### Trait 方法消歧义

当一个类型实现了多个定义了同名方法的 trait 时，`where` 子句约束决定使用哪个 trait 的方法：

```yo
T1 :: trait(get_number : (fn(self : Self) -> i32));
T2 :: trait(get_number : (fn(self : Self) -> i32));

Point :: struct(x : i32, y : i32);
impl(Point, T1(get_number : (self -> self.x)));
impl(Point, T2(get_number : (self -> self.y)));

// 隐式分派 — where(T <: T1) 约束 self.get_number() 只使用 T1 的方法
use_t1 :: (fn(generic(T : Type), self : T, where(T <: T1)) -> i32)({
  return(self.get_number()); // 返回 self.x (10)
});

// 显式分派 — 使用 (T <: T2).method(self) 语法
use_t2 :: (fn(generic(T : Type), self : T, where(T <: T2)) -> i32)({
  return((T <: T2).get_number(self)); // 返回 self.y (20)
});

point := Point(10, 20);
use_t1(point); // 10
use_t2(point); // 20
```

## Impl 类型

`Impl(TraitName)` 创建一个表示实现了指定 trait 的任意类型。这类似于 Rust 中的 `impl Trait`。

### 基本用法

```yo
// 定义一个 trait
Id :: trait(
  id : (fn(self : Self) -> Self)
);

// 接受任何实现了 Id 的类型的函数
use_id :: (
  fn(
    generic(T : Type),
    value : T,
    where(T <: Id)
  ) -> T
)({
  return(value.id());
});

// 为 i32 实现 Id
impl(
  i32,
  Id(
    id : (
      self -> {
        printf("i32: %d\n", self);
        return(self);
      }
    )
  )
);

// 使用
result := use_id(42); // 打印 "i32: 42"，返回 42
```

### Impl 作为返回类型

`Impl` 可以在返回类型中用于静态分发：

```yo
RetI32 :: trait(
  return_i32 : (fn(self : &mut Self) -> i32)
);

// `Impl(Trait)` 是静态分发：每条路径必须返回同一个具体类型，由编译器推断。
// 一个分支返回 `bool`、另一个返回 `i32` 无法通过编译。
get_value :: (fn(use_bool : bool) -> Impl(RetI32))({
  cond(
    use_bool => return(i32(1)),
    true => return(i32(42))
  );
});

// 要从不同分支返回不同的具体类型，请擦除为 `Dyn`：
get_any :: (fn(use_bool : bool) -> Box(Dyn(RetI32)))({
  cond(
    use_bool => return(dyn(Box.new(true))),
    true => return(dyn(Box.new(i32(42))))
  );
});
```

**重要提示**：每个返回路径必须返回一个具体类型，而不是恰好实现了相同 trait 的不同类型。

### Impl 与多个 Trait

```yo
Speak :: trait(
  speak : (fn(self : Self) -> unit)
);

Run :: trait(
  run : (fn(self : Self) -> unit)
);

// 类型必须同时实现 Speak 和 Run
perform :: (
  fn(
    generic(T : Type),
    actor : T,
    where(T <: (Speak, Run))
  ) -> unit
)({
  actor.speak();
  actor.run();
});
```

## Index 特征

`Index` 特征为集合类型提供了统一的元素索引访问接口。任何实现了 `Index` 的类型都可以使用熟悉的 `value(index)` 调用语法，使自定义集合的行为与内置数组和切片一致。

### 概述

```yo
// 内置数组和自定义类型使用相同的语法：
(arr : [i32 ; 3]) = [i32(10), i32(20), i32(30)];
v := arr(usize(1)); // 20
(mut(list) : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0)); // 42
```

### Index 特征定义

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

### 读与写：`Index` 与 `IndexMut`

元素访问像 Rust 一样一分为二。

- **下标调用哪个方法。** 作为值读取的 `x(i)` 调用 `index`。每一次写都调用 `index_mut`：`x(i) = v`、元素的字段（`x(i).f = v`）、嵌套元素（`grid(i)(j) = v`）、元素上的 `self : &mut Self` 方法（`x(i).push(v)`）、`&mut` 实参（`f(&mut x(i))`）、`addr_of(x(i))`，以及对它的 `&mut` 局部借用。`x(i) = (x(i) + 1)` 这样的读-改-写先读后写。Yo 没有复合赋值运算符。
- **只读元素。** 只实现 `Index` 而不实现 `IndexMut` 的类型，其元素是只读的；通过 `x(i)` 写入会得到一个指出缺少 `IndexMut` 的编译错误。
- **可写的接收者。** `index_mut` 接收 `self : &mut Self`，所以通过 `x` 的只读借用（一个 `x : &T` 参数）写 `x(i)` 是 E0908。
- **同一个 `Output`。** 同一索引类型的 `Index` 与 `IndexMut` 必须给出相同的 `Output`。
- **`Deref` 与 `DerefMut` 以同样的方式选择。** 所有者（`Array(T, N)`、持有 `[T]` 的用户类型）上的 `w.*` 是其 `deref` 投影给出的位置，经由它的每一次写入改为调用 `deref_mut`；只有 `Deref` 而没有 `DerefMut` 的类型，其 `.*` 是只读的（[自动解引用](#自动解引用)）。

#### 投影

`index` 和 `index_mut` 是**投影**：结果为借用的函数，即 `-> &T` 或 `-> &mut T`。投影产出一个位置，其结果表达式就是这个位置，并带上与结果类型一致的借用符号：

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
- **借用符号与结果一致。** `-> &T` 投影写 `&place`，`-> &mut T` 投影写 `&mut place`。引用绑定同样可作结果：参数 `x : &T` 的 `x` 就是该引用本身（结果是引用位置，裸读即引用，与 `&x.*` 等价），根与 origin 检查相同。`&mut` 绑定可作 `&T` 返回；`&` 绑定不能作 `&mut T` 返回。
- **裸指针位置。** 在 `pragma(Pragma.AllowUnsafe)` 文件中，位置可以是裸指针解引用（`&(p &+ i).*`），结果也可以直接是裸指针 `*T`。std 的缓冲区使用的就是这种形式。
- **ABI。** 投影的 `&T` 参数按指针传递（在其他地方 `&T` 参数按值传递），所以它返回的位置属于调用者。
- **直接调用投影。** 投影也是普通的函数或方法，按名字调用：`t.index(i)`、`Trio.index(&t, i)`、`first(&t)`。投影类型的函数值也以同样方式调用：`fn(s : &T) -> &U` 类型的参数或字段，持有具名投影或函数体产出 `&place` 的闭包的 `Impl(Fn(s : &T) -> &U)` 或 `Dyn(Fn(s : &T) -> &U)`，以及效应操作 `ctl(...) -> &U`。调用的结果就是那个位置本身，绝不是副本：
  - 作为操作数时透过它读取（`t.index(i) + 1`）；
  - 作为接收者时借出它（`n.name(0).len()`、`n.name_mut(0).push_str("!")`），对它下标就是对该位置下标（`g.index_mut(0)(2) = v`）；
  - 作为 `&T` 或 `&mut T` 参数的实参时按原样借出（`f(t.index(i))`）；
  - `r := t.index(i)` 绑定一个局部借用，与结果一样是 `&` 或 `&mut`，存活到最后一次使用。`(v : T) = t.index(i)` 则把值拷贝出来；
  - `&mut` 投影的调用可以作为 `=` 的左边（`t.index_mut(i) = v`，或 `t.index_mut(i).* = v`）。
- **结果的根。** 该位置位于调用的借用实参之中，包括接收者（`&mut` 投影的位置位于它的 `&mut` 实参之中）。结果的绑定存活期间，`&` 结果冻结这些实参（不能写入或移动），`&mut` 结果除通过该绑定外不允许访问它们（E0911）。该绑定永远不会离开函数（E0912），借用实参是临时值的投影调用不能被绑定。
- **只读投影是只读的。** 写入 `&` 投影的位置、对它调用 `self : &mut Self` 方法，或把它借给 `&mut` 参数，都是 E0908。`&mut` 投影的调用需要可写的接收者，与任何 `&mut self` 方法一样。
- **投影可以产出另一个投影的结果**（`&g.index(i).a`、`&mut g.index_mut(i).b`），前提是那次调用的借用实参以它自己的借用参数为根。`-> &mut T` 投影只能产出 `&mut` 投影的位置。

### 实现 Index

#### 基本实现

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

#### 泛型实现

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

### 取地址优化

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
(mut(list) : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(100));

// 通过调用语法赋值修改
list(usize(0)) = i32(999);
assert(list(usize(0)) == i32(999), "应该是 999");
```

### 范围切片

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

### 内置索引与特征索引

内置数组和切片类型（`[T; N]` 和 `[T]`）使用内置索引，生成直接的 C 数组访问（`arr.data[idx]`）。这比通过 Index 特征更高效，也避免了递归问题。

自定义类型和标准库集合（如 `ArrayList`）使用 Index 特征。调度顺序为：

1. 内置数组/切片索引（如果被调用者是 `[T; N]` 或 `[T]`）
2. 范围切片 `..` 或 `..=`（如果参数是范围表达式）
3. Index 特征分派（在被调用者类型上查找 `Index(type_of(arg))` 实现）
4. 普通函数调用

### 与运算符内联使用

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

### 标准库实现

以下标准库类型实现了 `Index` 特征：

#### ArrayList(T) — `Index(usize)`

```yo
(mut(list) : ArrayList(i32)) = ArrayList(i32).new();
list.push(i32(42));
v := list(usize(0)); // 42
addr_of(list(usize(0))).* = i32(99); // 原地修改
```

#### HashMap(K, V) — `Index(K)`

```yo
(map : HashMap(i32, i32)) = HashMap(i32, i32).new();
map.insert(i32(1), i32(100));
v := map(i32(1)); // 100
addr_of(map(i32(1))).* = i32(999); // 原地修改
// map(i32(99))                 // panic：键不存在
```

要求 `K <: (Eq(K), Hash)`。

#### BTreeMap(K, V) — `Index(K)`

```yo
(map : BTreeMap(i32, i32)) = BTreeMap(i32, i32).new();
map.insert(i32(5), i32(500));
v := map(i32(5)); // 500
addr_of(map(i32(5))).* = i32(77); // 原地修改
// map(i32(99))                 // panic：键不存在
```

要求 `K <: Ord(K)`。

#### Deque(T) — `Index(usize)`

```yo
(d : Deque(i32)) = Deque(i32).new();
d.push_back(i32(10));
d.push_back(i32(20));
v := d(usize(0)); // 10
addr_of(d(usize(0))).* = i32(555); // 原地修改
```

O(1) 随机访问，正确处理环形缓冲区回绕。

#### String — 只读的 `Index(usize)`

`String` 实现 `Output : u8` 的 `Index(usize)`，且不实现 `IndexMut`：`s(i)` 读取偏移 `i` 处的字节，越界时 panic，与 `byte_at(i)` 相同。

```yo
(s : String) = `Hello`;
b := s(usize(0)); // u8(72) — 该字节（'H'）；越界时 panic
c := s.get_byte(usize(9)); // .None — 带检查的形式
```

`s(i) = b` 是编译错误，并指出缺少 `IndexMut`：写入会改变所有共享该缓冲区的字符串，还可能留下非法的 UTF-8。Rust 的 `String` 同样没有可写的字节索引。如需字符级访问，请使用 `chars()` 迭代器。区间语法糖 `s(a..b)` 构建一个新字符串；它和其余所有字符串索引（`substring`、`index_of` 等）都是字节偏移 —— 完整契约见 [STRINGS.md](./STRINGS.md)。

### 错误处理

通过 Index 特征的越界访问会在运行时导致 **panic**。这与 Rust 的行为一致。如需返回 `Option(T)` 的安全访问，请使用 `ArrayList` 的 `get` 方法：

```yo
(mut(list) : ArrayList(i32)) = ArrayList(i32).new();
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

## 自动解引用

prelude 中的 `Deref` trait 给出 `w.*` 所代表的位置，`DerefMut` 是它的写入半边：

```yo ignore
Deref :: trait(Target : Type, deref : (fn(self : &Self) -> &Self.Target));
DerefMut :: trait(Target : Type, deref_mut : (fn(self : &mut Self) -> &mut Self.Target));
```

二者的选择方式与 `Index` 和 `IndexMut` 相同：读取 `w.*` 调用 `deref`；写入、
`&mut` 借出、`self : &mut Self` 接收者以及 `addr_of` 调用 `deref_mut`。只有
`Deref` 而没有 `DerefMut` 的类型，其 `.*` 是只读的；两个实现共用同一个 `Target`。

`Box`、`Rc` 和 `Arc` 是**句柄**：`w.*` 是其指针所指的载荷，由编译器直接读取，
它们的 `deref` 是 `&self.*.*`。`Rc` 和 `Arc` 没有 `DerefMut`，因为通过句柄
访问的载荷是只读的。对 `Deref` 类型，包装器自身没有的字段或方法会到载荷上查找：
`w.field` 即 `w.*.field`，`w.method()` 即 `w.*.method()`。

```yo
Point :: struct(x : i32, y : i32);
impl(Point, norm1 : (fn(self : &Self) -> i32)(self.x + self.y));
p := Rc.new(Point(x : 3, y : 4));
assert(p.x == 3); // p.*.x
assert(p.norm1() == 7); // p.*.norm1()
pp := Rc.new(Rc.new(Point(x : 1, y : 2)));
assert(pp.y == 2); // 嵌套包装器：pp.*.*.y
mut(b) := Box.new(Point(x : 3, y : 4));
b.x = 5; // 是一个位置：写入 b.*.x —— 只有 Box 有 DerefMut
assert(b.norm1() == 9);
```

- **两者都有的名字是错误（E0616）。** `Point` 派生了 `Clone`，`Rc` 也实现了
  `Clone`，因此 `p.clone()` 两种含义都有可能。用 `Rc.clone(p)` 调用 `Rc`
  自己的 `clone`（得到一个新的 `Rc`），用 `p.*.clone()` 调用载荷的（得到一个
  `Point`）；`yo fix` 会把调用改写为 `Rc.clone(p)`。只有一方拥有的名字无需
  选择，`p.*` 永远就是载荷本身。泛型函数体中的调用，例如
  `where(T <: Clone)` 下的 `x.clone()`，即使 `T` 是 `Rc` 也是约束提供的方法。
- **位置。** 在 `Box` 上，转发得到的字段是一个位置：`b.x = v` 以及
  `&mut self` 调用（如 `b.items.push(v)`）都写入载荷。通过 `Rc` 的同样写法
  是 E0919（见下文）：`Rc` 没有 `DerefMut`，其载荷通过句柄只读。在没有
  `pragma(Pragma.AllowUnsafe)` 的文件中，通过 `Arc` 写入同样会被拒绝
  （`a.n = v`，或 `self : &mut Self` 的 `a.bump()`）：请通过 `Mutex` 或原子
  类型修改 `Arc` 的载荷。
- **在 prelude 之外，`Deref` 需要非定长的 `Target`。** prelude 之外的 `Deref`
  或 `DerefMut` 实现，只有当 `Target` 是 `[T]`、`str`、`Dyn(...)` 或尾部非定长的
  结构体时才被接受。定长的 `Target` 和开放的类型变量是错误 E0622：包装定长
  载荷的类型应通过自己的字段和方法暴露它。
- 当包装器和载荷都没有这个名字时，错误信息会说明这一点：
  ``No field "z" on Rc(Point). `p` is a Rc(Point); its payload Point has no
  field "z" either.``（E0406；方法则为 E0610）。
- **被调用位置。** `p.items(i)` 对载荷的 `items` 进行索引，`p.f(x)` 调用载荷中
  保存函数的字段。包装器的方法与载荷的同名字段同样是 E0616。
- **把整个载荷当作引用：`as_ref`。** `Rc`、`Box` 和 `Arc` 都有
  `as_ref : (fn(self : &Self) -> &T)`（沿用 Rust 的名字）：在需要 `&T` 的地方
  （例如传给 `&T` 参数，`takes_point(p.as_ref())`），`h.as_ref()` 把载荷借出；
  `Rc.as_ref(h)` 是通过类型写出的同一个调用。结果可以直接传给调用，或先绑定
  再使用（`q := p.as_ref(); q.clone()` 调用的是载荷的 `clone`）。

**所有者。** 其他所有 `Deref` 类型都是非定长内容的所有者，它们的 `.*` 是其
`deref` 投影给出的位置。prelude 中的 `Array(T, N)` 和 std 中的
`ArrayList(T)` 都是所有者（`Target : [T]`，并实现 `DerefMut`），因此
`&list.*` 把列表的元素借出为 `&[T]`。持有 `[T]` 的用户类型也是：

```yo
{ assert } :: import("std/assert");
Ring :: struct(items : Array(i32, 3));
impl(Ring, len : (fn(self : &Self) -> usize)(usize(30)));
impl(Ring, Deref(Target : [i32], deref : (fn(self : &Self) -> &Self.Target)(&self.items.*)));
impl(Ring, DerefMut(Target : [i32], deref_mut : (fn(self : &mut Self) -> &mut Self.Target)(&mut self.items.*)));
count :: (fn(xs : &[i32]) -> usize)(xs.len());
main :: (fn() -> unit)({
  mut(r) := Ring(items : Array(i32, 3)(1, 2, 3));
  v := &r.*; // r.deref()：以 r 为根的视图
  assert(count(v) == usize(3));
  assert(r.len() == usize(30)); // 所有者自己的 len
  assert(r.*.len() == usize(3)); // 视图的 len
  assert(!r.is_empty()); // 只有视图有它：r.*.is_empty()
  w := &mut r.*; // r.deref_mut()：w 存活期间独占
  assert(count(w) == usize(3));
});
export(main);
```

- `&w.*` 即 `w.deref()`，`&mut w.*` 即 `w.deref_mut()`，其他位置的 `w.*` 是该
  调用的位置。视图借用所有者，因此视图存活期间，所有者不能被写入、移动或以
  `&mut` 借出（E0911）。
- **所有者自己的成员优先。** 只有视图拥有的成员通过 `.*` 访问；所有者拥有的
  成员属于所有者，因此上例中 `r.len()` 是 `Ring` 的，`r.*.len()` 是视图的。
  因此，给所有者新增成员会让原先访问视图同名
  成员的调用改为解析到所有者。
- **其他地方都不解引用。** `&Ring` 不能填入 `&[i32]` 形参：`count(&r)` 是
  E0601，其帮助信息给出 `count(&r.*)`。运算符的操作数也从不解引用。
