# 所有权与借用

Yo 管理内存时既没有垃圾回收器，也没有隐藏的共享。每个值都有一个所有者，值的最后一次使用会移动它，
拷贝要么是 `Copy` 类型的按位拷贝，要么是显式的 `.clone()`，所有者消失时编译器销毁这个值。
引用（`&T`、`&mut T`）让代码在不拥有值的情况下使用它；引用的类型带有一个**来源（origin）**，
即它指向的位置集合，编译器像 Rust 的借用检查器一样，按来源检查它的每一次使用。两个名字只能通过
`Rc(T)` 或 `Arc(T)` 指向同一个对象，而且类型会写明这一点。

本页是这些规则的用户指南。页中每个完整示例都能编译并运行；每个被拒绝的示例都标出了编译器报告的错误码。
`yo explain <code>` 输出诊断的完整说明。

## 一屏看懂这个模型

- **每个值都有一个所有者。** 局部变量、字段、元素或参数拥有它所持有的值。所有者消失时，值被丢弃（drop）。
- **绑定默认不可变，除非写明 `mut`。** `x := v` 可以被读取、用 `&` 借出和移动。给它重新赋值、
  用 `&mut` 借出、调用它的 `self : &mut Self` 方法或写它的字段，需要 `mut(x) := v`（E0917）。
- **值的最后一次使用会移动它。** `y := x`、按值传递 `x`、存储、捕获和返回它都会移动 `x`。
  之后再使用是 E0901。
- **拷贝是显式的**，写作 `x.clone()`；`Copy` 类型（整数、浮点数、`bool`、引用 `&T`，以及你
  `derive(T, Copy, Clone)` 的类型）除外，它们按位拷贝。
- **引用要写出来。** `x : &T` 只读地借出一个值，`x : &mut T` 独占地借出，调用处写同样的东西：
  `f(&x)`、`f(&mut x)`。引用是一个值：它可以被绑定、返回、存入 struct 字段、元组或 `Option`，
  也可以被闭包捕获。它的类型带有来源，因此编译器知道它指向哪里。
- **共享在类型中可见。** `Rc(T)`（单线程）和 `Arc(T)`（多线程）是仅有的引用计数值。通过句柄，
  它们的载荷是只读的；共享修改要经过载荷中的 `RefCell(T)`、`Mutex(T)` 或原子类型。

```yo
{ assert } :: import("std/assert");

Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);
Token :: struct(id : i32); // 既不是 Copy 也不是 Clone：只能移动

show :: (fn(p : &Point) -> i32)(p.x + p.y); // 借用
redeem :: (fn(t : Token) -> i32)(t.id); // 取得所有权

main :: (fn() -> unit)({
  p := Point(x : i32(1), y : i32(2));
  q := p; // Copy：按位拷贝，p 仍可用
  s := show(&p); // 只读借出，p 仍可用
  t := Token(id : i32(7));
  n := redeem(t); // t 的最后一次使用：移动进 redeem
  assert((q.x + s + n) == i32(11), "p 被拷贝并借出，t 被移动");
});
export(main);
```

## 所有权与移动

### 三类类型

| 类别 | 哪些类型 | `x` 之后还会被使用时的 `y := x` |
| --- | --- | --- |
| **`Copy`** | 整数、浮点数、`bool`、`char`、`unit`、`str`、`&T`、函数指针；带 `derive(T, Copy, Clone)` 的 struct、enum 或 newtype；各部分都是 `Copy` 的元组、数组和记录 | 按位拷贝 |
| **显式拷贝** | 实现了 `Clone` 但没有实现 `Copy`：`String`、各种集合、`Box(T)`、`Rc(T)` 与 `Arc(T)` 句柄，以及包含它们的类型 | E0901；写 `x.clone()` |
| **只能移动** | 既没有实现 `Copy` 也没有实现 `Clone`，或实现了 `Drop`：上面的 `Token`、文件、锁、线程句柄，以及持有它们的任何类型 | E0901；没有拷贝 |

不是 `Copy` 的类型在最后一次使用时移动，无论它属于另外两类中的哪一类。区别只在于是否存在 `x.clone()`。

### 移动发生在最后一次使用

Yo 没有移动运算符。绑定、按值实参、存入字段或元素、捕获和返回都会移动非 `Copy` 的值，
编译器会报告移动之后的任何使用：

```yo ignore
t := Token(id : i32(7));
r := redeem(t); // 在这里被移动
s := t.id; // error[E0901]: use of moved value: `t`
```

帮助信息会给出适合该类型的修复：普通数据用 `derive(T, Copy, Clone)`，显式拷贝类型用 `x.clone()`，
被调用方只读取时让它的参数写成 `x : &T`。

### `Copy`

具名类型只有实现了 `Copy` 才会隐式拷贝，而 `Copy` 要求 `Clone`：

```yo
Point :: struct(x : i32, y : i32);
derive(Point, Copy, Clone);
```

- 只写 `derive(T, Copy)` 而没有 `Clone` 是 E0602：编译器从不替你写出 `Clone` 的 impl。
- 每个字段都必须是 `Copy`，且该类型不能实现 `Drop`。
- 元组、数组和记录恰好在所有部分都是 `Copy` 时才是 `Copy`。
- `String`、各种集合、`Box`、`Rc`、`Arc` 以及所有 `Drop` 类型永远不是 `Copy`。
- 在泛型代码中，`where(T <: Copy)` 同时给出 `T <: Clone`。

普通数据不加 `Copy` 是一种选择：必须保持唯一的令牌、表中的索引或很大的数组都可以保持只能移动。

### 显式拷贝

`x.clone()` 产生一个独立的副本。对 `String` 和集合，它会拷贝缓冲区：

```yo
{ assert } :: import("std/assert");
{ String } :: import("std/string");

main :: (fn() -> unit)({
  mut(s) := String.from("hi");
  t := s.clone(); // 缓冲区的独立副本
  s.push_str(" there");
  u := s; // s 的最后一次使用：移动
  assert(t.len() == usize(2), "t 看不到这次 push");
  assert(u.len() == usize(8), "u 拥有被写入的缓冲区");
});
export(main);
```

共享句柄用 `Rc.clone(&r)` 或 `Arc.clone(&a)` 拷贝，得到指向同一对象的第二个句柄（[堆与共享](#堆与共享)）。

### 只能移动的值与资源

锁、文件、套接字或线程句柄不能被拷贝。一个类型在以下情况下只能移动：实现了 `Drop`，
既没有实现 `Copy` 也没有实现 `Clone`，或在字段、载荷、元组、数组或捕获中持有这样的值。

- 借出不花任何代价：`f : &File` 和 `m : &mut Mutex(T)` 不移动任何东西。
- 只能移动的类型仍可以实现 `Clone`；这时 `x.clone()` 就是它的拷贝。
- 要共享一个资源，就在类型中写出来：`Arc(Mutex(T))`、`Rc(RefCell(T))`。

### 没有部分移动

非 `Copy` 的字段不能从一个值中移出（E0901）：字段是其持有者的一部分。可以改为：

- 拷贝该字段：`p.name.clone()`；
- 用 `match` 把整个值拆开：`match(p, { name, age } => …)`；
- 借用它：`&p.name`、`match(&p.name, …)`。

### 可变绑定

绑定声明在哪里决定它的生命期；名字外面的 `mut(...)` 决定它能否被写入：

| 写法 | 含义 |
| --- | --- |
| `x := v`、`(x : T) = v` | 不可变的局部或模块级绑定 |
| `mut(x) := v`、`(mut(x) : T) = v` | 可变绑定 |
| `x :: v` | 编译期常量；运行时写入是 E0918 |
| `thread_local(mut(st)) := v` | 线程局部的可变全局变量 |
| `.Some(mut(v))`、`{ a, mut(b) } := pair` | 在模式或解构中逐个名字标注 |

`mut` 管住四种写入：重新赋值、`&mut` 借出（`&mut x`、`&mut x.f`、`&mut x` 捕获）、
`self : &mut Self` 调用，以及字段或元素写入。通过引用写入不是写这个绑定，因此
`a := &mut p.x; a.* = i32(10)` 需要的是 `mut(p)`，而不是 `mut(a)`。参数不带 `mut`：
要写参数的函数体把它重新绑定，`mut(y) := x`。

解构从被解构的值中借用各个元素，这些元素仍由该值负责丢弃。解构中的 `mut(b)` 绑定是其元素的
一份副本，因此持有 `Rc`、`Box` 或自有缓冲区（`String`、集合）的元素不能绑定为 `mut`
（E0901）：不加 `mut` 绑定它，再显式复制（`mut(c) := b.clone()`）；或者对你拥有的值使用
`match`，它会把各部分移动到分支的绑定中。

## 丢弃

所有者不再持有一个值时，这个值被丢弃。丢弃会释放缓冲区、运行 `Drop` 实现，或减少 `Rc`/`Arc` 的计数。

- **作用域结束。** 没有被移动的自有局部变量在其作用域结束时被丢弃。
- **提前退出。** `return`、`break` 和 `unwind` 丢弃被退出的作用域仍拥有的值。
- **重新赋值。** `x = v` 在存储之后立即丢弃 `x` 的旧值。`old := (x = v)` 则保留旧值。
- **只在部分分支中移动。** 在 `cond` 或 `match` 的部分分支中被移动的值，会在其他分支的末尾被丢弃，
  因此它在每条路径上都已消失。不存在运行时的丢弃标志。
- **循环。** 循环的各个出口（每个 `break`，以及条件变为假）必须一致：在一部分出口上被移动、
  在另一部分出口上没有被移动的值是 E0907。请记下循环找到的东西，在循环之后移动一次。

### `Drop`

`Drop` 恰好运行一次，在唯一的所有者丢弃该值时：先运行 `drop`，再丢弃各字段。

```yo
{ println } :: import("std/fmt");

Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      println(`close ${self.n}`);
    })
  )
);

main :: (fn() -> unit)({
  a := Fd(n : i32(1));
  b := Fd(n : i32(2));
  drop(a); // 输出 "close 1"：a 在这里结束
  println("end of main");
}); // 输出 "close 2"：b 在其作用域结束时被丢弃
export(main);
```

- `Drop` 类型只能移动，永远不是 `Copy`。
- `drop` 接受 `self : &mut Self`：它可以取出或重置某个字段，之后被丢弃的字段看到的是它留下的值。
- `drop(x)` 在作用域结束之前结束一个值：这个 prelude 函数把 `x` 移入，调用返回时该值被丢弃。
- 手动调用析构函数（`x.drop()`）是 E0915：它会在一个仍然存活的值上再运行一次。
- 通过裸指针拥有一个值的不安全代码，用 `drop_in_place(p)` 原地销毁它
  （[MEMORY_SAFETY.md](./MEMORY_SAFETY.md#原地销毁一个值drop_in_place)）。

## 函数与参数

### 三种参数模式

| 参数 | 含义 | 调用 |
| --- | --- | --- |
| `x : T` | 按值：`Copy` 类型拷贝，其他类型移动 | `f(x)` |
| `x : &T` | 只读引用 | `f(&x)` |
| `x : &mut T` | 独占的读写引用 | `f(&mut x)` |

- 按值参数是被调用方自己的值。被调用方可以写它（先把它重新绑定为 `mut`）、存储或返回它，否则丢弃它。
- 模式是函数类型的一部分：`fn(x : &i32)` 与 `fn(x : i32)` 是不同的类型。
- 接收者使用同样的写法：`self : &Self` 读取，`self : &mut Self` 修改，`self : Self` 消耗接收者。
  方法调用借出或移动接收者时不写标记。

```yo
{ assert } :: import("std/assert");

Counter :: struct(n : i32);
impl(
  Counter,
  get : (fn(self : &Self) -> i32)(self.n),
  bump : (fn(self : &mut Self) -> unit)({
    self.n = (self.n + i32(1));
  }),
  finish : (fn(self : Self) -> i32)(self.n)
);

main :: (fn() -> unit)({
  mut(c) := Counter(n : i32(0));
  c.bump(); // 接收者以 &mut 借出
  v := c.get(); // 接收者以 & 借出
  last := c.finish(); // 接收者被移动：之后 c 不再可用
  assert((v == i32(1)) && (last == i32(1)), "只增加了一次");
});
export(main);
```

### 调用处标出借用

传给引用参数的具名位置带上参数的符号：`x : &T` 写 `&x`，`x : &mut T` 写 `&mut x`。裸的 `x` 按值传递。

```yo
{ assert } :: import("std/assert");

bump :: (fn(n : &mut i32) -> unit)({
  n.* = (n.* + i32(1));
});
peek :: (fn(n : &i32) -> i32)(n.*);

main :: (fn() -> unit)({
  mut(x) := i32(1);
  bump(&mut x); // x 变为 2
  y := peek(&x); // x 仍可用
  assert((x == i32(2)) && (y == i32(2)), "通过 &mut 写入");
});
export(main);
```

- 不匹配是错误，永远不会被转换（E0914）：裸的 `x` 传给 `&T` 参数、`&x` 传给按值参数、
  `&x` 传给 `&mut T` 参数。这条规则对 `Copy` 类型同样成立，所以标记总是说真话。
- 以下情况不写标记：方法接收者、临时值、字面量、闭包字面量、运算符操作数，以及整体传递的引用
  （`r : &T` 时的 `f(r)`）。
- `&x` 永远只是引用。裸指针是 `addr_of(x)`，用于不安全代码。

```yo ignore
y := peek(x); // error[E0914]: Parameter "n" is a `&` borrow (`n : &T`): lend `x` with `&x`.
```

### `.*` 通过引用读写

引用是它自己类型 `&T` 的值，而不是它指向的 `T`。`r.*` 指称被引用的值：`r.*` 读取它，
`r.* = v` 通过 `&mut T` 写入它。运算符从不穿过引用，因此 `n : &i32` 时的 `n + i32(1)` 是 E0926；
请写 `n.* + i32(1)`。

字段访问、方法调用和索引会自动穿过引用：`r.x`、`r.len()` 和 `r(i)` 不需要 `.*`。`&r` 借出的是
引用本身（一个 `&&T`）；没有任何东西会把它转换回 `&T`。

### 运算符

运算符的 trait 决定了它如何接受操作数，因此操作数不带标记。`==` 与各比较运算符（`Eq`、`Ord`）
借用两个操作数，因此 `a == b` 之后两者都还在。算术、位运算和一元运算符按值接受操作数：
`Copy` 操作数被拷贝，其他操作数被移动。

### 返回值

函数返回一个自有的值，它被移动给调用方。指向函数局部变量的引用不能被返回：局部变量的存储随调用结束
（E0912）。请返回值本身，或返回以函数自己的某个引用参数为根的引用（[来源](#返回与存储引用来源)）。

```yo ignore
get :: (fn() -> i32)({
  x := i32(1);
  y := &x;
  return(y); // error[E0912]: Cannot return the local borrow `y`
});
```

## 引用

### 局部借用

`y := &place` 只读地借用一个位置，`y := &mut place` 独占地借用它。位置是局部变量、参数，
或以它们为根的字段路径。

```yo
{ assert } :: import("std/assert");

Point :: struct(x : i32, y : i32);

main :: (fn() -> unit)({
  mut(p) := Point(x : i32(3), y : i32(4));
  a := &mut p.x;
  b := &mut p.y; // 兄弟字段各自独立地借用
  a.* = i32(10); // 写 p.x
  b.* = i32(20); // 写 p.y
  assert((p.x == i32(10)) && (p.y == i32(20)), "两次写入都落在 p 中");
});
export(main);
```

`&T` 是 `Copy`：`a := r; b := r;` 得到指向同一位置的两个引用。`&mut T` 不是 `Copy`，因此一个位置
永远至多有一个可用的 `&mut`。把 `&mut T` 绑定到新名字会移动它：`a := m`（或 `(a : &mut T) = m`）之后，
`a` 持有 `m` 的借用直到 `a` 的最后一次使用，之后再使用 `m` 是 E0901。元组元素、泛型 `T` 实参和返回值
同样会移动它。要保留 `m`，请重新借用：`a := &mut m.*` 在 `a` 的生命期内借用该位置，`a` 最后一次使用之后
`m` 又可以使用。把 `&mut T` 绑定传给 `&mut T` 参数，会为这次调用重新借用它，调用之后该绑定仍可用。

```yo
main :: (fn() -> unit)({
  mut(x) := i32(1);
  m := &mut x;
  a := &mut m.*; // 重新借用：a 最后一次使用之后 m 仍可用
  a.* = i32(2);
  m.* = i32(3);
  b := m; // 移动：此后 m 不再可用
  b.* = i32(4);
});
export(main);
```

### 借用存活到最后一次使用

引用从它被创建处存活到它的最后一次使用，而不是到作用域结束。存活期间，它的位置被**冻结**：

- 在 `&` 下：该位置、它内部的每个位置以及包含它的每个位置都既不能被写入也不能被移动；
- 在 `&mut` 下：除通过该引用之外，这些位置完全不能被访问。

```yo ignore
mut(x) := i32(1);
y := &x;
x = i32(2); // error[E0911]: Cannot write `x` here: `y` borrows `x` with `&` and is still live
z := y.*; // ……因为 y 在这里被使用
```

把写入移到 `z := y.*` 之后，程序就合法了：那时 `y` 已经不再存活。另外几条规则决定存活范围：

- 在循环中使用的引用在整个循环中存活，因为下一次迭代还会使用它。
- 由另一个引用得到的引用，在自身存活期间让源引用一直存活。
- 持有引用的值（struct、元组、`Option`、闭包）一直存活并冻结它借用的东西，直到该值自己的最后一次使用。
- 只有当一个位置是另一个位置的前缀时，两个引用才冲突。兄弟字段互相独立：`&mut s.left` 与
  `&mut s.right` 可以并存。
- 穿过 `Rc` 或 `Arc` 的 `&` 引用（`r := &h.x`）借用的是句柄：`r` 存活期间，`h` 不能被移动、
  重新赋值或丢弃。

### `&` 引用是只读的

通过 `&T` 赋值、把它传给 `&mut T` 参数、在它上面调用 `self : &mut Self` 方法，或对它下面的位置
取 `&mut`，都是 E0908。

```yo ignore
reset :: (fn(p : &Point) -> unit)({
  p.x = i32(0); // error[E0908]: Cannot write `p.x`: `p` is a `&T` parameter, a read-only borrow of the caller's value.
});
```

### 两阶段借用与参数重叠

调用的实参按顺序求值。某个实参借出的位置（`&x`、`&mut x`、被借用的接收者、其运算符借用的操作数）
从该实参被求值的那一刻起被借用，直到调用返回。因此：

- 后面的实参可以**读取**该位置：`xs.push(xs.len())` 与 `f(&mut a, a.len())` 被接受。
  这就是 Rust 的两阶段借用。
- 后面的实参不能**移动**该位置、给它赋值或以 `&mut` 借出它（E0910）：在 `sync(&mut a, eat(a))` 中，
  被调用方会在 `eat` 消耗了 `a` 之后看到它。请在调用之前算好这样的实参：
  `n := eat(a.clone()); sync(&mut a, n)`。
- 同一次调用借出的两个位置，当其中之一以 `&mut` 借出时不能重叠（E0910）：`s.push_string(&s)`、
  `f(&mut p, &p.name)` 与 `swap(&mut x, &mut x)` 都被拒绝，因为被调用方会在读取一个的同时写另一个。
  两个 `&` 借出可以重叠，不相交的字段互相独立（`f(&mut p.a, &p.b)`）。先拷贝其中一侧：
  `t := s.clone(); s.push_string(&t)`。

### 重新指向：游标遍历

局部引用可以用 `cur = &place` 或 `cur = &mut place` 移到另一个位置，这样代码可以遍历链式结构而不拷贝节点。
右侧的符号决定含义：`cur = &mut n.next` 让 `cur` 重新指向，而 `cur.* = v` 通过它写入。

```yo
{ assert } :: import("std/assert");

Node :: struct(value : i32, next : Option(Box(Self)));
List :: struct(head : Option(Box(Node)));

append :: (fn(list : &mut List, v : i32) -> unit)({
  cur := &mut list.head;
  while(cur.is_some(), {
    match(
      cur,
      .Some(n) => {
        cur = &mut n.next; // 重新指向下一个槽位
      },
      .None => ()
    );
  });
  cur.* = .Some(Box.new(Node(value : v, next : .None))); // 写入尾部槽位
});

sum :: (fn(list : &List) -> i32)({
  (mut(total) : i32) = i32(0);
  cur := &list.head;
  while(cur.is_some(), {
    match(
      cur,
      .Some(n) => {
        total = (total + n.value);
        cur = &n.next;
      },
      .None => ()
    );
  });
  total
});

main :: (fn() -> unit)({
  mut(list) := List(head : .None);
  append(&mut list, i32(1));
  append(&mut list, i32(2));
  append(&mut list, i32(3));
  assert(sum(&list) == i32(6), "三个节点");
});
export(main);
```

- `match(cur, …)` 穿过引用进行匹配：`n` 是指向 `cur` 所引用对象内部的引用。`&mut` 匹配的绑定存活期间，
  被匹配的引用只能通过该绑定到达；`cur = &mut n.next` 是唯一可以提到 `cur` 的语句，因为它让绑定重新指向，
  而不触碰它指向的东西。在 `n` 之后还会被使用时，通过 `cur` 的写、读或调用（或对它借用的位置
  `list.head` 的写入）是 E0911。
- 重新指向之后，`cur` 持有 `n` 内部的一个位置，因此之后再使用 `n` 是 E0911。
- 声明时的位置在整个遍历期间保持冻结：遍历中途的 `list.head = .None` 是 E0911。
- 重新指向一个无关的位置（`cur = &mut other.head`）是一次新的借出，按声明的规则检查：`&mut` 要求
  `other` 是 `mut`，并且在 `other` 的作用域结束之后不能再使用 `cur`。
- 由 `cur` 当前目标派生出的借用仍存活时进行重新指向，是 E0911。
- `Rc` 的载荷是只读的，因此 `&mut` 遍历需要 `Box` 单元；`&` 遍历也适用于 `Option(Rc(Node))`。

### 模块级位置

模块级绑定没有所有者栈帧，任何函数都能用名字访问它。不带 `mut` 声明的模块级绑定是不可变的，
因此可以借给任何调用。`mut(G)` 绑定能被被调用方所调用的每个函数访问，因此把它或它下面的位置借给调用是
E0916；请把它拷贝到局部变量，借出局部变量，再写回去。指向模块级位置的局部引用不能跨调用存活，
穿过模块级位置或引用单元的引用不能跨 `await` 存活。

## 返回与存储引用：来源

**来源（origin）** 是引用可能指向的位置集合。每个引用类型都带有一个来源：`&(T, p)` 与 `&mut(T, p)`
把它写出来，而大多数签名省略它，由编译器补全。来源让引用能够离开创建它的表达式：被返回、存入 struct、
放在元组或 `Option` 中，并且仍然受到检查。

### 返回引用的函数

函数可以返回以它自己的某个引用参数为根的引用。调用方的实参在结果的最后一次使用之前保持冻结。

```yo
{ assert } :: import("std/assert");

Grid :: struct(a : i32, b : i32);

first :: (fn(g : &Grid) -> &i32)(&g.a);
first_mut :: (fn(g : &mut Grid) -> &mut i32)(&mut g.a);

main :: (fn() -> unit)({
  mut(g) := Grid(a : i32(1), b : i32(2));
  r := first_mut(&mut g); // r 存活期间 g 被冻结
  r.* = i32(10); // 写 g.a
  v := first(&g).*;
  assert(v == i32(10), "通过投影写入");
});
export(main);
```

结果的来源被省略时，它是所有引用参数，因此调用方冻结全部这些实参。签名写出参数名就能声明更窄的来源：
`-> &(i32, s)` 只借用 `s`，调用不会冻结其他实参。

```yo
{ assert } :: import("std/assert");

Pair :: struct(a : i32, b : i32);

// 结果只借用 `s`。
pick :: (fn(s : &Pair, t : &Pair) -> &(i32, s))(cond((t.a > i32(0)) => &s.a, true => &s.b));

main :: (fn() -> unit)({
  p := Pair(a : i32(1), b : i32(2));
  mut(q) := Pair(a : i32(3), b : i32(4));
  r := pick(&p, &q);
  q.a = i32(0); // 被接受：结果的来源是 p，而不是 q
  assert(r.* == i32(1), "r 指向 p.a");
});
export(main);
```

- 函数体按声明的来源检查：从 `pick` 交出 `&t.a` 是 E0923。
- 调用只按签名检查，从不查看被调用方的函数体。
- 来源被省略时（`-> &i32`），同样的 `q.a = i32(0)` 是 E0911，因为结果可能指向 `q`。
- 接受并返回无关参数的引用的函数，声明一个来源参数 `generic(p : Origin)`，并在两个位置使用它：
  `fn(generic(p : Origin), a : &(T, p), b : &T) -> &(T, p)`。

索引是同一机制：`xs(i)` 读取时调用 `Index.index(self : &Self, i) -> &Output`，写入时调用
`IndexMut.index_mut`（[INDEX_TRAIT.md](./INDEX_TRAIT.md#投影)）。`r := xs.index(i)` 绑定元素引用；
在 `r` 的最后一次使用之前，`xs` 被冻结。

### 持有引用的类型

持有引用的 struct 或 enum 声明一个来源参数，并在字段的类型中写出它。这种类型的值在自己的最后一次使用之前
一直借用这个来源。

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array-list");

// 列表上的一个窗口：类型带有它所借用的列表的来源。
View :: (fn(comptime(p) : Origin) -> comptime(Type))(
  struct(xs : &(ArrayList(i32), p), lo : usize, hi : usize)
);

total :: (fn(generic(p : Origin), v : View(p)) -> i32)({
  (mut(sum) : i32) = i32(0);
  (mut(i) : usize) = v.lo;
  while(i < v.hi, {
    sum = (sum + v.xs(i));
    i = (i + usize(1));
  });
  sum
});

main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
  xs.push(i32(3));
  v := View(xs)(xs : &xs, lo : usize(1), hi : usize(3)); // 在 v 的最后一次使用之前借出 xs
  assert(total(v) == i32(5), "窗口的和是 2 + 3");
  xs.push(i32(4)); // v 已不再存活：xs 重新可用
});
export(main);
```

- `View(xs)` 用位置 `xs` 填充来源参数。
- 在 `v` 之后还会被使用时调用 `xs.push(...)` 是 E0911。
- 持有 `&mut` 分量的值只能移动。
- 元组和 `Option` 不需要声明就能持有引用：`t := (&x, &y)` 与 `Option(&i32).Some(&x)` 在存活期间
  借用 `x`（和 `y`）。
- 类型永远不能把自己的字段作为来源（E0924）：值不能包含指向自身的引用，因此移动一个值永远不会让引用悬空，
  也不需要固定（pinning）。请改为存储索引或偏移量。

### 引用不能去的地方

有些位置不接受引用，持有引用的值出现在那里会被拒绝：

- 集合的元素或单元的载荷：`ArrayList(&T)`、`RefCell(&T)`、`Box(&T)` 以及 `Rc`/`Arc` 的载荷都是 E0909；
- 模块级绑定与 `extern` 签名（E0909）；
- 移动到另一个线程的值：引用永远不是 `Send`，因此捕获了引用的 `Thread.spawn` 闭包是 E0909。

## 元素访问与迭代

`xs(i)` 是一个位置：在读取位置读取元素，在 `=` 左侧写入元素，都不拷贝容器。

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array-list");

main :: (fn() -> unit)({
  mut(xs) := ArrayList(usize).new();
  xs.push(usize(10));
  xs(usize(0)) = usize(99); // 原地写入元素
  v := xs(usize(0)); // Copy 元素：拷贝出来
  xs.push(xs.len()); // 实参在 push 借出 xs 之前读取 xs
  assert((v == usize(99)) && (xs(usize(1)) == usize(1)), "原地写入");
});
export(main);
```

- `Copy` 元素由 `xs(i)` 和 `xs.get(i)` 拷贝出来，后者越界时返回 `.None`。非 `Copy` 元素用
  `xs.get_cloned(i)` 拷贝，用 `r := xs.index(i)` 借用，或用 `xs.with(i, e => …)` 原地写入。
- `&xs(i)` 不是可以绑定的位置（E0927）；用 `xs.index(i)` 或下面的借用式 `for` 借用元素。

### 迭代

- `for(&xs, x => …)` 借用 `xs`，并把每个元素绑定为 `&` 引用。循环体可以读取 `xs`，但不能写入它。
- `for(&mut xs, x => …)` 独占地借用 `xs`；`x` 是指向元素的 `&mut` 引用，因此 `x.* = …` 原地写入元素。
  循环体完全不能提到 `xs`（E0911）：循环持有 `xs` 期间，`xs.push(v)`、`xs.len()` 以及对 `xs`
  的嵌套循环都会被拒绝。
- 普通的 `for(xs, x => …)` 按值接受并消耗 `xs`。

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array-list");

main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
  for(&mut xs, x => {
    x.* = (x.* * i32(2)); // 原地把每个元素翻倍
  });
  (mut(total) : i32) = i32(0);
  for(&xs, x => {
    total = (total + x.*);
  });
  assert(total == i32(6), "2 + 4");
});
export(main);
```

要在遍历集合的同时扩充或读取它，请改为遍历它的位置：`for(xs.indices(), i => …)` 配合 `xs(i)`。
映射用 `for(&m, (k, v) => …)` 和 `for(&mut m, (k, v) => …)`；两种形式中键都是只读的。`HashSet` 和
`PriorityQueue` 只有只读遍历，因为原地写入元素会破坏它们的顺序。放在 `Rc` 中的集合通过句柄的载荷遍历：
`for(&h.*, x => …)`。

## 模式匹配

`match` 接受被匹配值的方式与参数接受实参的方式相同：

| 被匹配值 | 绑定 |
| --- | --- |
| 非 `Copy` 的自有值或临时值 | 被消耗；选中分支的绑定拥有各自的部分 |
| `match(&x, …)` | `&` 引用；`x` 仍可用 |
| `match(&mut x, …)` | `&mut` 引用：`v.* = …` 写入 `x` |
| 一个引用 `r`（`match(r, …)`） | 以 `r` 的模式指向 `r` 所引用对象内部的引用 |
| `Copy` 值 | 拷贝 |

```yo
{ assert } :: import("std/assert");

Token :: struct(id : i32);

main :: (fn() -> unit)({
  o := Option(Token).Some(Token(id : i32(1)));
  a := match(&o, .Some(t) => t.id, .None => i32(0)); // 借用：o 仍可用
  b := match(o, .Some(t) => t.id, .None => i32(0)); // 消耗 o
  mut(n) := Option(i32).Some(i32(2));
  match(
    &mut n,
    .Some(v) => {
      v.* = (v.* * i32(3)); // 原地写入载荷
    },
    .None => ()
  );
  assert((a == b) && (n.unwrap_or(i32(0)) == i32(6)), "借用、消耗、写入");
});
export(main);
```

- 被消耗的被匹配值之后再被使用是 E0901，帮助信息会给出 `match(&x, …)`。
- 守卫把绑定看作引用；移动发生在某个分支被选中时。
- 非 `Copy` 的字段、元素或模块级绑定不能按值匹配（没有部分移动）：请写 `match(&x.f, …)`。
- 对引用 `r` 写 `match(&r, …)` 是 E0926：标记是多余的，请写 `match(r, …)`。

## 闭包

### 捕获列表

闭包在参数之前的列表中写明它捕获什么、以及如何捕获：

| 条目 | 含义 |
| --- | --- |
| `x` 或 `x : e` | 按值字段：拷贝，或移动一个拥有所有权的值 |
| `&y`、`name : &place` | 对某个位置的只读引用 |
| `&mut z`、`name : &mut place` | 对某个位置的独占引用 |
| `s2 : s.clone()`、`n : s.len()` | 在字面量处计算的普通按值字段 |

```yo
{ assert } :: import("std/assert");

main :: (fn() -> unit)({
  mut(total) := i32(0);
  k := i32(10);
  (i32(1) .. i32(4)).for_each({ &mut total }(x) => {
    total.* = (total.* + x.*); // 写调用方的 total
  });
  (add : Impl(Fn(x : i32) -> i32)) = ({ k }(x : i32) => (x + k)); // k 被拷贝进来
  assert((total == i32(6)) && (add(i32(1)) == i32(11)), "1 + 2 + 3，以及 1 + 10");
});
export(main);
```

- 列表是穷尽的：函数体只能提到列出的捕获和模块级项。`{}()` 不捕获任何东西。
- 捕获列表中的引用按同样的 `&y` / `&mut z` 实参来判断：`&mut` 捕获需要 `mut` 位置，闭包存活期间
  它借用的位置被冻结（与捕获冲突的访问是 E0910）。
- 没有列表时，闭包捕获其函数体提到的局部变量。当闭包应该借用（`{ &y }`、`{ &mut z }`），
  或拷贝应当显式（`{ s2 : s.clone() }`）时，请写出列表。
- 持有引用的闭包和任何持有引用的值一样受检查：它可以被绑定、调用和借出，只有在它借用的东西比函数活得更久时
  才能被返回。越过局部变量返回它、把它存入 `Dyn`、把它移入会保留它的按值参数，或派生它，都是 E0909。
- `&mut` 捕获使闭包只能移动。

### `Fn`、`FnMut`、`FnOnce`

| Trait | 调用接受 | 闭包在其函数体……时具有它 |
| --- | --- | --- |
| `Fn` | `self : &Self` | 只读取捕获 |
| `FnMut` | `self : &mut Self` | 写入 `&mut` 捕获或它自己的按值状态 |
| `FnOnce` | `self` | 把某个捕获移出 |

- `Fn` 蕴含 `FnMut`，`FnMut` 蕴含 `FnOnce`。
- `FnMut` 闭包通过 `mut` 绑定或 `f : &mut Impl(FnMut(…))` 参数调用。它的按值捕获是跨调用保留的状态：

```yo
{ assert } :: import("std/assert");

main :: (fn() -> unit)({
  (mut(tick) : Impl(FnMut() -> i32)) = ({ n : i32(0) }() => {
    n = (n + i32(1)); // 闭包自己的状态，跨调用保留
    n
  });
  a := tick();
  b := tick();
  assert((a == i32(1)) && (b == i32(2)), "状态被保留");
});
export(main);
```

- `FnOnce` 调用会消耗闭包，因此第二次调用是 E0901。它的函数体拥有捕获列表中的按值条目，可以移出其中之一；
  从 `Fn` 或 `FnMut` 闭包中移出捕获是 E0913。

```yo
{ assert } :: import("std/assert");

Token :: struct(id : i32);
redeem :: (fn(t : Token) -> i32)(t.id);
run_once :: (fn(f : Impl(FnOnce() -> i32)) -> i32)(f());

main :: (fn() -> unit)({
  t := Token(id : i32(4));
  (once : Impl(FnOnce() -> i32)) = ({ t }() => redeem(t)); // 把捕获移出
  n := run_once(once); // once 被移入 run_once
  assert(n == i32(4), "只调用了一次");
});
export(main);
```

- std 中不逃逸的回调（`for_each`、`retain`、`RefCell.with`、`Mutex.with_lock`、`Option` 与 `Result`
  的组合子）接受 `&mut Impl(FnMut(…))`。闭包会逃逸进去的 API（`Thread.spawn`、`io.async` 的函数体）
  按值接受 `FnOnce`。

## 堆与共享

| 类型 | 含义 | 拷贝 | 线程 |
| --- | --- | --- | --- |
| `Box(T)` | 唯一拥有的堆单元；用于递归和稳定的地址 | `Box.clone(&b)`，深拷贝 | 与 `T` 相同 |
| `Rc(T)` | 在单线程上共享，带计数 | `Rc.clone(&r)`：指向同一单元的第二个句柄 | 永远不是 `Send` |
| `Arc(T)` | 跨线程共享，原子计数 | `Arc.clone(&a)` | 当 `T` 同时是 `Send` 和 `Sync` 时，它也是 |
| `Weak(T)`、`ArcWeak(T)` | 不让载荷保持存活的句柄 | `Weak.clone(&w)` | 与其强句柄相同 |

`Box.new(v)`、`Rc.new(v)` 与 `Arc.new(v)` 把 `v` 移入一个新单元；`alloc : .Some(a)` 实参把单元放进分配器 `a`
（[EXPLICIT_ALLOCATORS.md](./EXPLICIT_ALLOCATORS.md)）。

### `Box`

```yo
{ assert } :: import("std/assert");

Tree :: enum(Leaf(v : i32), Node(l : Box(Self), r : Box(Self)));

sum :: (fn(t : &Tree) -> i32)(
  match(
    t,
    .Leaf(v) => v.*,
    .Node(l, r) => (sum(&l.*.*) + sum(&r.*.*)) // l.* 是 Box，l.*.* 是它的载荷
  )
);

main :: (fn() -> unit)({
  t := Tree.Node(Box.new(Tree.Leaf(i32(1))), Box.new(Tree.Leaf(i32(2))));
  assert(sum(&t) == i32(3), "1 + 2");
});
export(main);
```

`Box` 是其所有者的值的一部分：通过它写入就是普通的写入，丢弃所有者就会释放它。

### `Rc` 与 `Arc`

- 成员会穿过句柄转发：`r.n` 读取载荷的字段，`r.len()` 调用载荷的方法。`r.*` 指称载荷。
- 句柄和载荷都有的成员是 E0616，它会给出两种写法：`Rc.clone(&r)` 拷贝句柄，`r.*.clone()` 拷贝载荷。
  `Box` 同理：`Box.clone(&b)`。
- 由 `Rc` 句柄构成的环会泄漏，与 Rust 相同：在回边上放一个 `Weak`（[WEAK.md](./WEAK.md)）。
  `--allocator debug` 会报告这种泄漏。

### 通过 `Rc` 写入：`RefCell`、`Rc.get_mut`、`Rc.make_mut`

`Rc` 或 `Arc` 的载荷通过句柄是只读的，因为其他句柄可能共享它。通过普通句柄写入是 E0919，它会给出这些出口：

- 在载荷中放 `RefCell(T)`，用于单线程上的共享修改：`with` 以 `&T` 借出值，`with_mut` 以 `&mut T` 借出，
  其中一个运行期间发生冲突的访问会 panic；
- `Rc.get_mut(&mut h)`：`h` 是唯一句柄时为 `.Some(&mut T)`，否则为 `.None`；
- `Rc.make_mut(&mut h)`：单元被共享时，先把 `h` 移到一个新单元（载荷的克隆），再给出 `&mut T`；
- `Rc.try_unwrap(h)`：`h` 是唯一句柄时，按值取出载荷。

```yo
{ assert } :: import("std/assert");
{ RefCell } :: import("std/sync/refcell");

main :: (fn() -> unit)({
  count := Rc.new(RefCell(i32).new(i32(0)));
  other := Rc.clone(&count); // 指向同一单元的第二个句柄
  other.with_mut(v => {
    v.* = (v.* + i32(1)); // 运行时检查：没有其他访问正在进行
  });
  assert(count.with(v => v.*) == i32(1), "两个句柄都看到这次写入");

  mut(h) := Rc.new(i32(1));
  a := Rc.clone(&h);
  Rc.make_mut(&mut h).* = i32(3); // 被共享：h 先移到一个新单元
  assert((a.* == i32(1)) && (h.* == i32(3)), "a 保留旧值");
});
export(main);
```

`RefCell(T)` 在 `T` 是 `Send` 时是 `Send`，但永远不是 `Sync`；跨线程时的出口是 `Arc(Mutex(T))`、
`Arc(RwLock(T))` 和原子类型。

### `std/sync` 值

`Mutex(T)`、`RwLock(T)`、`Cond`、`Barrier`、`Semaphore`、`WaitGroup`、`Once`、`OnceCell(T)` 和
`Atomic*` 类型都是只能移动的值，与 Rust 相同：拷贝是 E0901，每个方法都接受 `self : &Self`。
多个线程通过 `Arc` 共享其中一个：用 `Arc.new(...)` 创建它，给每个线程一个自己的 `Arc.clone(&...)`，
并按值捕获这个克隆。

```yo
{ assert } :: import("std/assert");
{ Mutex } :: import("std/sync/mutex");
{ Thread } :: import("std/thread");

main :: (fn() -> unit)({
  total := Arc.new(Mutex(i32).new(i32(0)));
  mine := Arc.clone(&total); // 派生线程的句柄
  t := Thread(unit).spawn({ mine }(io : Io) => {
    mine.with_lock(v => {
      v.* = (v.* + i32(1));
    });
  });
  t.join();
  assert(total.with_lock(v => v.*) == i32(1), "线程的写入可见");
});
export(main);
```

`Channel(T)` 持有其队列的一个 `Arc`：`ch.clone()` 是同一队列上的另一个句柄。见
[THREAD_SAFETY.md](./THREAD_SAFETY.md)。

### `Dyn(Trait)`

`Dyn(Trait)` 是一个大小不定、类型被擦除的值。它位于一个说明谁拥有它的指针之后：`Box(Dyn(Trait))`
拥有它，`Rc(Dyn(Trait))` 共享它，`&Dyn(Trait)` 借用它。见 [DYN_DESIGN.md](./DYN_DESIGN.md)。

## 异步与线程

### Future

- Future 只能移动。`io.await(f, io)` 与 `io.spawn(f, io)` 消耗它；一个 Future 不能被 await 两次。
- `io.async` 的函数体是按值的 `FnOnce`：它拥有自己的捕获。
- Future 可以借用。若函数的 Future 捕获了它的 `&`/`&mut` 参数，它返回的就是借用式 Future；
  绑定它会像局部引用一样，在 Future 的最后一次使用之前冻结被借出的位置：

```yo
{ assert } :: import("std/assert");

Counter :: struct(n : i32);
bump :: (fn(c : &mut Counter, io : Io) -> Impl(Future(unit, Io)))(
  io.async({ c : &mut c.* }(io : Io) => {
    c.n = (c.n + i32(1));
  })
);

main :: (fn(io : Io) -> unit)({
  mut(c) := Counter(n : i32(0));
  f := bump(&mut c, io); // 在 f 的最后一次使用之前借用 c
  io.await(f, io); // 在这一行之前写 c 是 E0911
  assert(c.n == i32(1), "Future 写入了 c");
});
export(main);
```

借用式 Future 不能被派生或存储（E0909）。完整规则见 [ASYNC_AWAIT.md](./ASYNC_AWAIT.md)。

### 线程：`Send` 与 `Sync`

- **`Send`：值可以被移动到另一个线程。** 当一个值不触及任何 `Rc`、裸指针以及标记为 `!(Send())`
  的类型时，它是 `Send`。
- **`Sync`：值可以同时被多个线程读取。** `Arc(T)` 要求 `T <: (Send, Sync)`；`Mutex(T)` 要求
  `T <: Send`，它自身是 `Sync`。
- 指向某个栈帧所拥有位置的引用，以及任何持有这种引用的值，永远不是 `Send`。
- `Thread.spawn` 按值接受 `FnOnce`，因此被派生的闭包会把它的捕获移进去。

见 [THREAD_SAFETY.md](./THREAD_SAFETY.md) 与 [PARALLELISM.md](./PARALLELISM.md)。

## 已知限制

检查器在少数地方是保守的：它会拒绝一些安全的程序。每一处都是一个未关闭的 issue：

- 闭包捕获的借用持续到闭包绑定的作用域结束，而不是闭包的最后一次使用：之后还需要该位置时，把闭包及其调用
  包在一个 `{ …; }` 块中
  （`issues/2026-11-13-a-closures-capture-borrow-lasts-to-the-bindings-scope-end-not-its-last-use.md`）。
- 通过 `match` 绑定的重新指向让绑定和游标保持独占的时间比需要的更长：在重新指向之前使用该绑定，
  或把写它的分支放在重新指向的分支之前
  （`issues/2026-11-21-a-re-point-through-a-match-binding-keeps-the-binding-and-the-cursor-exclusive-longer-than-needed.md`）。
- 指向不可变模块级绑定的局部引用在跨调用时被拒绝
  （`issues/2026-11-11-decision-18-rule-3-rejects-a-call-while-a-local-borrows-an-unmarked-module-level-binding.md`）。

检查器也有已知的漏洞：它会接受一些误用内存的安全程序。这些是编译器 bug，作为最高严重度的未关闭 issue 跟踪
（[MEMORY_SAFETY.md](./MEMORY_SAFETY.md#这个模型不保证什么)）。当改动依赖借用规则时，请在
`--sanitize address` 下运行测试。

## 诊断

| 代码 | 含义 |
| --- | --- |
| E0901 | 使用已被移动的值，或拷贝只能移动的值 |
| E0907 | 值在循环的一部分出口上被移动、在其他出口上没有 |
| E0908 | 通过 `&` 引用写入 |
| E0909 | 持有引用的值到达不接受来源的位置，或比它借用的东西活得更久 |
| E0910 | 访问与闭包或 Future 持有的借用冲突，或与同一调用中更早的实参借出的位置冲突；重叠的 `&mut` 实参 |
| E0911 | 访问与存活的引用冲突 |
| E0912 | 指向函数局部变量的引用越过函数边界 |
| E0913 | 闭包的调用 trait 弱于其槽位要求：在 `Fn`/`FnMut` 下移出捕获，或在 `Fn` 下写入状态 |
| E0914 | 调用处标记与参数的模式不匹配 |
| E0915 | 显式调用析构函数（`x.drop()`）；请写 `drop(x)` |
| E0916 | 把 `mut(G)` 模块级绑定或它下面的位置借给调用 |
| E0917 | 写入未声明 `mut` 的绑定 |
| E0918 | 在运行时写入 `::` 常量 |
| E0919 | 通过 `Rc` 句柄写入 |
| E0922 | 没有被任何 `generic(p : Origin)` 声明的来源 |
| E0923 | 引用超出其声明的来源 |
| E0924 | 类型或绑定把自身作为来源 |
| E0926 | 不写 `.*` 就把引用当作整个值读取或写入 |
| E0927 | 对不是位置的东西做局部借用，例如 `&xs(i)` |

## 从 Rust 过来

| 概念 | Yo | Rust |
| --- | --- | --- |
| 默认参数 | 按值：`Copy` 则拷贝，否则移动 | 按值（移动） |
| 只读借用 | `x : &T`，调用 `f(&x)` | `x: &T`，`f(&x)` |
| 独占借用 | `x : &mut T`，调用 `f(&mut x)` | `x: &mut T`，`f(&mut x)` |
| 解引用 | `r.*`；字段、方法和索引自动解引用 | `*r`；`.` 自动解引用 |
| 生命周期 | 来源：`&(T, p)`、`generic(p : Origin)`、`-> &(T, xs)`；默认省略 | `&'a T`、`<'a>` |
| 持有引用的 struct | `View :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(xs : &(T, p)))` | `struct View<'a> { xs: &'a T }` |
| 隐式拷贝 | `derive(T, Copy, Clone)` | `#[derive(Copy, Clone)]` |
| 深拷贝 | `x.clone()` | `x.clone()` |
| 移动 | 在最后一次使用时隐式发生；之后使用是 E0901 | 隐式；之后使用是错误 |
| 可变绑定 | `mut(x) := v` | `let mut x = v` |
| 共享所有权 | `Rc(T)`、`Arc(T)`；`Rc.clone(&r)` | `Rc<T>`、`Arc<T>`；`Rc::clone(&r)` |
| 动态借用检查 | `RefCell(T)`，配合 `with` / `with_mut` | `RefCell<T>`，配合 `borrow` / `borrow_mut` |
| 对自有值 match | 消耗；`match(&x, …)` 借用 | 默认绑定模式 |
| 闭包捕获 | 捕获列表 `{ x, &y, &mut z }` | `move` 或推断 |
| trait 对象 | `Box(Dyn(Trait))`、`Rc(Dyn(Trait))`、`&Dyn(Trait)` | `Box<dyn T>`、`Rc<dyn T>`、`&dyn T` |
| 固定（pinning） | 不需要：值永远不持有指向自身的引用 | `Pin` |

## 延伸阅读

- [MEMORY_SAFETY.md](./MEMORY_SAFETY.md)：默认安全的契约、unsafe 的 opt-in 与审计工具。
- [THREAD_SAFETY.md](./THREAD_SAFETY.md)：`Send`、`Sync` 与 `std/sync` 类型。
- [ASYNC_AWAIT.md](./ASYNC_AWAIT.md)：Future、借用式 Future 与任务。
- [INDEX_TRAIT.md](./INDEX_TRAIT.md)：投影与 `xs(i)`。
- [WEAK.md](./WEAK.md)、[ARC.md](./ARC.md)、[DYN_DESIGN.md](./DYN_DESIGN.md)。
- [ERROR_DIAGNOSTICS.md](./ERROR_DIAGNOSTICS.md)：所有诊断代码。
- 设计记录：`plans/VALUES_BY_DEFAULT.md`（模型及其决策）与 `plans/backlog/REFERENCES_AND_ORIGINS.md`（来源）。
