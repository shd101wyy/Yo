# 数据类型

Yo 程序用来构造数据的类型：原始类型、结构体、元组、数组与区间、枚举与 ADT、
联合体、newtype、成员可见性以及标准集合。绑定与字面量见 [SYNTAX.md](./SYNTAX.md)；
这些值的所有权见 [OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md)。

## 类型

类型可以具有以下**Kind**：

- Type
  - i32
  - bool
  - ...

### Type

#### 原始类型

- `unit`（unit 类型）
- `bool`（true 或 false）
- `u8`（8 位无符号整数）
- `u16`（16 位无符号整数）
- `u32`（32 位无符号整数）
- `u64`（64 位无符号整数）
- `i8`（8 位有符号整数）
- `i16`（16 位有符号整数）
- `i32`（32 位有符号整数）
- `i64`（64 位有符号整数）
- `f32`（32 位浮点数）
- `f64`（64 位浮点数）
- `usize`（指针大小。在 32 位系统上为 `u32`，在 64 位系统上为 `u64`）
- `isize`（有符号指针大小。在 32 位系统上为 `i32`，在 64 位系统上为 `i64`）

#### 编译期已知类型：

- `comptime_int`（编译期已知的整数类型）
- `comptime_float`（编译期已知的浮点类型）
- `comptime_str`（编译期已知的字符串类型）
- `ComptimeList`（编译期已知的列表类型）
- `Expr`（编译期已知的表达式类型，用于宏和编译期求值）

#### C 兼容类型：

- `char`（C char 类型）
- `short`（C short 类型）
- `ushort`（C unsigned short 类型）
- `int`（C int 类型）
- `uint`（C unsigned int 类型）
- `long`（C long 类型）
- `ulong`（C unsigned long 类型）
- `longlong`（C long long 类型）
- `ulonglong`（C unsigned long long 类型）
- `longdouble`（C long double 类型）
- `void`（C void 类型，主要用于指针，如 `*(void)`）

#### 类型全域：

- `Type`（所有类型的类型）

#### 复合类型：

- 用 `struct(...)` 定义的结构体
- 用 `enum(...)` 定义的枚举 / ADT
- 用 `union(...)` 定义的联合体
- 共享单元：`Rc(T)`（非原子引用计数）与 `Arc(T)`（原子引用计数），以及唯一所有的单元 `Box(T)`
- 固定大小数组：`Array(T, N)` 或 `[T; N]`
- 字符串：无大小的 `str`、`&str`（胖引用），以及拥有缓冲区的 `String`；字符串字面量是 `&(str, static)`
- 用 `newtype(...)` 定义的新类型
- 元组：`Tuple(T1, T2, ...)` 或 `(T1; T2; ...)`

#### 指针类型：

- `*(T)`（指向 T 的指针）

#### 静态/动态分派类型：

- `Impl(Trait)`（实现了 Trait 的静态分派类型）
- `Dyn(Trait)`（动态分派：非定长的 trait 对象，放在 `Box(Dyn(Trait))`、`Rc(Dyn(Trait))` 或 `&Dyn(Trait)` 这样的指针后面使用；见 [TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md)）

#### 非定长类型

没有自身大小的类型只能放在指针后面：`&T`、`&mut T`、`*T`，或者 `Box(T)` 这样的拥有型句柄。共有三种：

- `[T]`（`Slice(T)`），一段 `T`，其长度由指针携带。`unsize(&a)` 把 `&Array(T, N)` 变成 `&[T]`（`&mut a` 和 `*Array(T, N)` 同理），而 `&xs(a..b)` 是对容器一部分的视图，不做复制，该容器的 `Index(Range(usize))` impl 的 `Output : [T]`。`size_of_val(s)` 和 `align_of_val(s)` 通过指针测量。
- `Dyn(Trait, ...)`，trait 对象，其指针携带虚表（[TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md)）。
- 最后一个字段是非定长的结构体。

指向非定长类型的指针是两个字：地址，以及长度或虚表。按值使用非定长类型（局部变量、按值参数或结果、非结构体最后一个字段的字段、元素、`size_of(T)`）是 E0619，对非定长位置赋值也是。`unsize` 和 `dyn` 改变的是指针的类型，从不是值的类型，所以对值写 `unsize(a)` 是 E0620。`generic(T : Type)` 绑定器带有隐含约束 `where(T <: Sized)`；函数体只在指针后面使用 `T` 的泛型写作 `generic(T : ?Sized)`，同样接受非定长类型，其函数体在定义处检查：

```yo
Show :: trait(show : (fn(self : &Self) -> i32));
show :: (fn(generic(T : ?Sized), x : &T, where(T <: Show)) -> i32)(x.show());
```

trait 的关联类型也接受同样的种类：写作 `Target : ?Sized` 时，impl 既可以把它绑定为 `[T]` 或 `str`，也可以绑定为定长类型；trait 只在指针后面使用 `Self.Target`（按值使用 `Self.Target` 在 trait 处就是 E0619）。写作 `Target : Type` 时它是定长的，为它写的值类型 `str` 表示 `&(str, static)`。

```yo
Peek :: trait(Target : ?Sized, peek : (fn(self : &Self) -> &Self.Target));
Row :: struct(a : Array(i32, 3));
impl(Row, Peek(Target : [i32], peek : (fn(self : &Self) -> &Self.Target)(&self.a.*)));
```

标准库为 `[T]` 提供 `len`、`is_empty`、`contains`、`==` 与哈希；`[T]` 没有下标，也没有迭代器。

#### 值类型与共享单元

**值类型**（栈分配，赋值时复制）：

- 原始类型：`i32`、`bool`、`f32` 等
- 用 `struct(...)` 定义的结构体
- 用 `enum(...)` 定义的枚举 / ADT
- 用 `union(...)` 定义的联合体
- 固定大小数组：`Array(T, N)` 或 `[T; N]`
- 元组：`Tuple(T1, T2, ...)` 或 `(T1; T2; ...)`

**共享单元**（堆分配，引用计数）：

- `Rc(T)` 与 `Arc(T)`：句柄就是新的所有者，写作 `Rc.clone(h)`；载荷通过句柄只读
- 在最后一个句柄处释放；引用环会泄漏，除非用 `Weak` 打破
- `Rc` 留在创建它的线程上；`Arc` 是可供线程共享的原子形式

```yo
// 值类型 - 栈分配；是 `Copy`，所以 `q := p` 是复制
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);
p := Point(x : 3, y : 4);
q := p;
// 共享单元 - 堆分配，引用计数
s1 := Rc.new(String.from("Hello"));
s2 := Rc.clone(s1); // s2 和 s1 指向同一个单元（引用计数）
```

## 结构体

```yo
Point :: struct(x : i32, y : i32);

my_point := Point(
  x : i32(10),
  y : i32(20)
);
```

编译为 C

```c
struct Point {
  int x;
  int y;
};
```

## 元组

元组定义为不同类型元素的序列，用逗号分隔，括号包围。

```yo
my_unit := (); // my_unit: unit.
my_i32_tuple := 12; // my_i32_tuple: i32
// 需要额外的逗号才能构成元组
my_i32_tuple := (12,); // my_i32_tuple: (i32,). Free type
(i32_tuple : (i32, i32, i32)) = (1, 2, 3); // tuple: (i32, i32, i32). Free type
mixed_tuple := (1, true, "Hello"); // mixed_tuple: (i32, bool, *u8[6,'\0']). Free type
(a, b, c) := mixed_tuple; // a: i32, b: bool, c: *u8[6,'\0']. Free type
a := mixed_tuple.0;
b := mixed_tuple.1;
c := mixed_tuple.2;

// 注意：只有 1 个元素的元组类型仍需要分隔符，否则它就是元素类型本身。
MyTuple :: i32;
// 等价于
MyTuple :: i32;
// 要使其成为单元素元组类型，需要加分号
MyTuple :: (
  i32;
);
```

## 数组与区间

```yo
i32_array := [i32 ; _](1, 2, 3); // i32_array: [i32; 3]
// 对应 C 代码：int i32_array[3] = {1, 2, 3};
i32_array.len(); // 3，编译期已知
(i32_array2 : [i32 ; _]) = [1, 2, 3]; // i32_array2: [i32; 3]
```

Yo 中不存在指向堆的切片类型。可能在底层缓冲区被释放后悬空的视图从构造上就被排除了：

- **区间操作是拷贝。** 在 `ArrayList(T)` 与 `String` 上，`xs(a..b)` 和
  `xs(a..=b)` 会降低为 `slice_copy` / `slice_copy_inclusive`，产生一个
  独立持有的值，而不是源缓冲区上的窗口。
- **`str` 是唯一的内建视图**，且只指向静态字符串数据 —— `str` 上的
  `s(a..b)` 是静态字节上的零拷贝窗口，永远不会悬空。
- **元素访问只交出值，从不交出内部指针** —— `xs.get(i)` 返回元素
  （`Copy` 类型返回拷贝，用 `xs(i) = v` 写回；其余用
  `xs.get_cloned(i)`，`Rc` 元素得到第二个句柄，容器增长后依然有效），见
  [OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md#元素访问与迭代)。

### 使用 `..` 的区间

```yo
mut(list) := ArrayList(i32).new();
list.push(i32(1));
list.push(i32(2));
list.push(i32(3));
list.push(i32(4));

// 元素 1..3（不含端点）的拷贝 —— 一个独立的 ArrayList(i32)
part := list(usize(1) .. usize(3)); // [2, 3]
// 含端点变体
part2 := list(usize(1) ..= usize(3)); // [2, 3, 4]
// 修改拷贝不影响源
part.set(usize(0), i32(99));
assert(list(usize(1)) == i32(2));
```

### 数组方法

Yo 中的数组自带一些实用方法：

#### Array.fill

创建一个用指定值填充的数组：

```yo
// `fill` 要求一个编译期已知的实参（它定义在 `where(T <: Comptime)` 之下，
// 接受 `comptime(val)`），但它的结果是一个运行时值——用 `:=` 绑定
// （`::` 会被拒绝："Got runtime value"）。
zeros := Array(i32, 10).fill(0); // [0,0,0,0,0,0,0,0,0,0]
ones := Array(i32, 5).fill(1); // [1,1,1,1,1]
```

#### Array.len

获取数组的长度：

```yo
arr :: [1, 2, 3, 4, 5];
len := arr.len(); // 5（运行时读取；长度也在类型里）
// 适用于泛型数组
generic_len :: (fn(comptime(T) : Type, comptime(n) : usize, arr : [T ; n]) -> usize)(arr.len()); // 返回 n
;
```

### 数组长度推断

Yo 可以使用 `_` 来推断数组长度：

```yo
// 从初始化器推断长度
arr1 :: Array(i32, _)(1, 2, 3); // Array(i32, 3)
arr2 :: [i32 ; _](10, 20, 30, 40); // Array(i32, 4)
// 字面量语法推断长度
arr3 :: [1, 2, 3]; // Array(i32, 3)
// 空数组
empty :: Array(i32, _)(); // Array(i32, 0)
// 嵌套数组推断
nested :: Array(Array(i32, _), _)(
  Array(i32, _)(1, 2, 3),
  Array(i32, _)(4, 5, 6)
); // Array(Array(i32, 3), 2)
```

**限制**：不能在没有初始化的变量绑定中使用 `_`：

```yo
// 错误：无法推断长度
arr : Array(i32, _); // 不允许！
arr = [1, 2, 3];

// 正确：使用具体长度或立即初始化
arr := Array(i32, _)(1, 2, 3); // OK
```

### 数组赋值与复制

数组是值类型，赋值时会复制：

```yo
// 创建数组
arr1 := [i32(1), i32(2), i32(3)];
arr2 := arr1; // arr2 是 arr1 的副本
// 修改 arr2
arr2(usize(0)) = i32(10);

assert(arr1(usize(0)) == i32(1), "arr1 未改变");
assert(arr2(usize(0)) == i32(10), "arr2 已修改");
```

更多数组示例请参阅 `tests/array.test.yo`。

## 代数数据类型 (ADT)

ADT 本质上是另一种记录类型，带有一个隐藏的 `tag` 字段来指示变体类型。

因此，当一个变体的值确定后，我们可以像访问记录字段一样访问该值的字段。

ADT 还有一些优化。例如，如果 ADT 只有一个变体，`tag` 字段将被省略。

此外，如果只有一个变体且只有一个字段，将直接使用字段类型而不是将其包装在记录中。这类似于 Haskell 中的 [newtype](https://wiki.haskell.org/Newtype)。

```yo
Option :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    Some(value : T),
    None
  )
);

(none : Option(i32)) = .None;
(some : Option(i32)) = .Some(i32(42));

IpAddr :: enum(
  V4(a : u8, b : u8, c : u8, d : u8),
  V6(v : String)
);

home := IpAddr.V4(u8(127), u8(0), u8(0), u8(1));
loopback := IpAddr.V6(String.from("::1"));

// 使用记录作为变体
Message :: enum(
  Quit,
  Move(x : i32, y : i32),
  Write(v : String),
  ChangeColor(r : i32, g : i32, b : i32)
);

m := Message.Write(String.from("hello"));
m = Message.Move(i32(3), i32(4));
m = Message.ChangeColor(i32(1), i32(2), i32(3));
```

## 无字段的枚举

与 ADT 相同，但所有变体都没有字段。

```yo
State :: enum(
  Working,
  Failed
);
Week :: enum(
  Monday,
  // 0
  Tuesday,
  // 1
  Wednesday // 2
);

day := Week.Wednesday;
printf("%d", day); // 2
```

## 联合体

```yo
MyNumber :: union(
  i : i32,
  j : f32
);
(my_number : MyNumber) = MyNumber(i : 10);
my_number.j = 1.2;
```

编译为 C

```c
union MyNumber {
  int i;
  float j;
};
```

## Newtype

`newtype` 关键字定义一个只有单个字段的结构体，同时可以在一个声明中定义方法、常量和 trait 实现。它提供零开销抽象 —— 在运行时与被包装的类型完全相同，但在编译期是一个独立的类型。这类似于 Haskell 的 `newtype`。

**核心特性：**

- 零运行时开销（无包装分配）
- 通过独立类型实现类型安全
- 内联定义方法和常量
- 定义中包含 trait 实现
- 通过字段名访问被包装的值

**语法：**

```yo
newtype(
  // 只有一个字段
  field_name : FieldType
);
```

**示例：**（见 `std/string/rune.yo`）：

```yo
rune :: newtype(
  c : u32
);
impl(
  rune,
  // 带验证的构造函数
  from_u32 : (fn(value : u32) -> Option(Self))(
    cond(
      ((value <= u32(0x10FFFF)) && ((value < 0xD800) || (value > 0xDFFF))) => .Some(Self(c : value)),
      true => .None
    )
  ),
  to_u32 : (fn(self : Self) -> u32)(self.c),
  is_ascii : (fn(self : Self) -> bool)(self.c <= u32(0x7F)),
  // 常量
  NUL : Self(c : 0x00),
  TAB : Self(c : 0x09),
  NEWLINE : Self(c : 0x0A),
  SPACE : Self(c : 0x20)
);
```

**使用场景：**

- 类型安全的 ID（UserId、OrderId 等）
- Unicode 字符（rune 包装 u32）
- 度量单位（Meters、Seconds、Dollars）
- 带验证的类型（Email、PhoneNumber、PositiveInt）
- 语义区分（Username vs Password）

**内存布局：**

```yo
UserId :: newtype(value : i32);
// size_of(UserId) == size_of(i32)
// 对应 C 代码：就是一个 i32，运行时没有结构体包装
```

## 私有成员

名称以 `_` 开头的结构体字段或 impl 方法是**私有的**，并由编译器强制执行。这样的成员只能在声明该类型（或该 impl）的模块以及该模块的**同目录兄弟模块**中读取、写入、调用、构造或解构。其余成员都是公开的。没有新的关键字：下划线约定*就是*可见性规则。

```yo
// counter.yo
{ String } :: import("std/string");

Counter :: struct(_count : i32, label : String);
impl(
  Counter,
  new : (fn(label : String) -> Counter)(Counter(_count : i32(0), label : label)),
  _bump : (fn(self : Self, by : i32) -> Counter)(
    Counter(_count : (self._count + by), label : self.label.clone())
  ),
  add : (fn(self : Self, by : i32) -> Counter)(self._bump(by)),
  count : (fn(self : Self) -> i32)(self._count)
);
export(Counter);
```

另一个目录中的模块导入它：

```yo
// app/main.yo
{ Counter } :: import("../counter.yo");
c := Counter.new(String.from("clicks")).add(i32(2));
c.count(); // OK —— 公开方法
c.label; // OK —— 公开字段
c._count; // error[E0405]: Field "_count" of Counter is private to its declaring module
c._bump(i32(1)); // error[E0405]: Method "_bump" of Counter is private to its declaring module
Counter(_count : i32(9), label : c.label); // error[E0405]: Cannot construct Counter outside its declaring module: field "_count" is private
{ _count } := c; // error[E0405]: Cannot destructure field "_count" of Counter outside its declaring module: it is private
{ label } := c; // OK —— 只点名公开字段
```

由此推出的规则：

- 含有任何私有字段的类型需要为外部调用者提供构造函数（`Counter.new`），外部代码只能通过方法读取这种类型。`{ ... }` 展开同样会被拒绝，所以私有字段不会从中泄漏。
- 要测试私有成员，把测试文件放在**模块旁边**（`counter.yo` 旁的 `counter.test.yo`）：兄弟模块可以访问它们，这正是 Rust 文件内 `#[cfg(test)] mod tests` 的对应形式；而放在其他目录的测试只能覆盖公开接口。`yo test <dir>` 会运行兄弟测试；普通构建把 `test(...)` 视为空操作。
- 兄弟模块规则让目录成为一个单元：`std/sync/cond.yo` 可以调用 `std/sync/mutex.yo` 声明的 `_raw_handle_ptr` 方法，而 `std/thread.yo` 不行。
- 静态形式 `Counter._bump(c, i32(1))` 与实例调用受到完全相同的检查；泛型 `impl(generic(T), ...)` 提供的方法以该 impl 所在的模块为声明处。
- 以 `___` 开头的名称保留给编译器合成的成员，永远不算私有；位置标签 `_0`、`_1`……（元组形结构体）同样不算私有。
- 模块级绑定不受影响：无论绑定叫什么名字，`export(...)` 仍是模块对外发布内容的唯一控制。trait 的*签名*不是类型的成员，也不做检查。

运行 `yo explain E0405` 查看该诊断。

## 集合

完整的集合类型及其 API 请参阅 `std/collections`。

Yo 在标准库中提供了高效的、唯一所有的集合类型。

### 修改集合：修改方法接收 `&mut self`

所有会改变集合的方法都接收 `self : &mut Self`：`ArrayList`、`HashMap`、
`HashSet`、`Deque`、`BTreeMap`、`PriorityQueue`、`OrderedMap`、
`HeaderMap` 和 `StringBuilder` 的修改方法（`push`、`pop`、`insert`、`remove`、
`clear`、`sort`、`retain`、`write_str` 等，也包括会取走缓冲区的
`StringBuilder.to_string`）。只读方法（`len`、`get`、`contains`、`iter` 等）
接收 `self : Self`。

集合是值：副本需要显式的 `.clone()`，通过克隆写入只会改变克隆。规则如下：

- **填充列表的辅助函数用 `&mut` 接收它：** `fill :: (fn(out :
  &mut ArrayList(i32)) -> unit)(...)`。普通的 `out : ArrayList(i32)` 参数是被调用者
  自己的副本。
- **通过位置写集合的元素：** `rows(i).push(x)`、`m(k).push(x)`，或
  `for(&mut xs, x => x.push(...))`。`match` 绑定（`.Some(l) => l.push(x)`）
  和按值的 `for` 绑定都是副本。
- **存放在映射或 `Option` 字段里的列表要先取出、修改、再存回：**
  `l := match(m.remove(k), .Some(v) => v, .None => ArrayList(T).new());
  l.push(x); m.insert(k, l);`，或者先 `self.f.take()`，再 `self.f = .Some(l)`。
- **两个持有者有意共享的列表用 `Rc`：** `Rc(ArrayList(T))`，通过
  `b.*.push(x)` 写入。闭包和 `io.async` 体按值捕获，所以往列表里记录内容的闭包
  要这样共享（或者返回这个列表）。

### ArrayList

支持自动扩容的动态数组。

```yo
{ ArrayList } :: import("std/collections/array-list");

// 创建新的 ArrayList
mut(list) := ArrayList(i32).new();

// 添加元素
list.push(i32(42));
list.push(i32(100));
list.push(i32(200));

printf("Length: %zu\n", list.length());
printf("Capacity: %zu\n", list.capacity());

// 通过索引获取元素
first := list.get(usize(0));
match(
  first,
  .Some(value) => printf("First element: %d\n", value),
  .None => printf("No first element\n")
);

// 设置元素
list.set(usize(1), i32(150));

// 弹出元素
popped := list.pop();
match(
  popped,
  .Some(value) => printf("Popped: %d\n", value),
  .None => printf("List is empty\n")
);

// 以初始容量创建
list2 := ArrayList(i32).with_capacity(usize(10));

// 清空并收缩
list.clear();
list.shrink_to_fit();
```

### HashMap

键值对哈希映射。

```yo
{ HashMap } :: import("std/collections/hash-map");

// 创建新的 HashMap
mut(map) := HashMap(i32, i32).new();

// 插入键值对
result := map.insert(i32(1), i32(100));
match(
  result,
  .Ok(opt) => match(
    opt,
    .None => printf("Inserted new key\n"),
    .Some(old_val) => printf("Updated, old value: %d\n", old_val)
  ),
  .Error(_) => printf("Insert failed\n")
);

// 获取值
value_opt := map.get(i32(1));
match(
  value_opt,
  .Some(v) => printf("Value: %d\n", v),
  .None => printf("Key not found\n")
);

// 检查键是否存在
cond(
  map.has(i32(1)) => printf("Contains key 1\n"),
  true => printf("Does not contain key 1\n")
);

// 删除键
removed := map.remove(i32(1));
match(
  removed,
  .Some(v) => printf("Removed value: %d\n", v),
  .None => printf("Key not found\n")
);

// 检查长度和是否为空
printf("Length: %zu\n", map.length());
cond(
  map.is_empty() => printf("Map is empty\n"),
  true => printf("Map is not empty\n")
);

// 清空映射
map.clear();
```

### HashSet

用于唯一值的哈希集合。

```yo
{ HashSet } :: import("std/collections/hash-set");

// 创建新的 HashSet
mut(set) := HashSet(i32).new();

// 插入元素
result := set.insert(i32(42));
match(
  result,
  .Ok(was_new) => cond(
    was_new => printf("Inserted new element\n"),
    true => printf("Element already exists\n")
  ),
  .Error(_) => printf("Insert failed\n")
);

// 检查是否包含
cond(
  set.has(i32(42)) => printf("Contains 42\n"),
  true => printf("Does not contain 42\n")
);

// 删除元素
removed := set.remove(i32(42));
cond(
  removed => printf("Removed element\n"),
  true => printf("Element not found\n")
);

// 集合运算
set1 := HashSet(i32).new();
set2 := HashSet(i32).new();

set1.insert(i32(1));
set1.insert(i32(2));
set1.insert(i32(3));

set2.insert(i32(2));
set2.insert(i32(3));
set2.insert(i32(4));

// 并集
union_result := set1.union(set2);
match(
  union_result,
  .Ok(union_set) => printf("Union size: %zu\n", union_set.length()),
  .Error(_) => printf("Union failed\n")
);

// 交集
inter_result := set1.intersection(set2);
match(
  inter_result,
  .Ok(inter_set) => printf("Intersection size: %zu\n", inter_set.length()),
  .Error(_) => printf("Intersection failed\n")
);

// 子集检查
is_sub := set1.is_subset(set2);
cond(
  is_sub => printf("set1 is subset of set2\n"),
  true => printf("set1 is not subset of set2\n")
);
```
