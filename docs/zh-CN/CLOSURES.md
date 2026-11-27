# 闭包

闭包：语法、捕获什么以及如何捕获、捕获列表、`FnOnce` 与 `FnMut`，以及静态
（`Impl(Fn(...))`）与动态（`Dyn(Fn(...))`）两种形式。具名函数见 [FUNCTIONS.md](./FUNCTIONS.md)。

## 概述

Yo 支持闭包（捕获其所在环境的匿名函数）。

闭包会被编译成一个保存所捕获变量的**捕获结构体**。它如何存储与调用，取决于所标注的类型：

- **`Impl(Fn(...))` —— 静态分发，不做引用计数。** 编译器会将闭包单态化为独立函数，捕获结构体**按值传递**，并生成直接调用：没有堆分配、没有虚表、也没有引用计数。每个闭包都有各自不同的类型（参见 [Closure Type Restrictions](#闭包类型限制)），因此这种形式无法用同一个变量持有两个不同的闭包。
- **`Box(Dyn(Fn(...)))` 和 `&Dyn(Fn(...))` —— 动态分发。** 值是 `{data, vtable}` 的胖指针（[TRAIT_OBJECTS.md](./TRAIT_OBJECTS.md)）：`dyn(Box.new(f))` 把捕获结构体移入由 `Box` 拥有的堆 box，`dyn(&f)` 则就地借用闭包，不做分配。当不同类型的闭包需要共享同一类型时使用它——例如存入集合、从不同分支返回，或接受任意可调用对象。擦除总是要写出来，绑定、字段、实参和结果都一样；对闭包、具名 `fn` 或 `Impl(Fn(...))` 值写裸 `dyn(f)` 是 E0620。把可调用值裸传入 `Dyn(Fn(...))` 位置（`(d : Dyn(Fn() -> i32)) = f`、`run(f)`、`S(cb : f)`、以 `f` 结尾的函数体）是错误 E0618，其提示会给出 `dyn(f)`；`yo fix <path>` 会给具名可调用值加上 `dyn(...)`。`Impl(Fn(...))` 位置不是擦除，闭包可以直接传入。

两种形式下，**被捕获的值**都遵循一般规则：被捕获的 `Rc` 句柄由该捕获结构体持有，并在其销毁时释放。

更多闭包示例和用法请参阅 `tests/closure.test.yo`。

## 基本闭包语法

创建闭包有两种方式：

1. **使用 `Impl(Fn(...))`** — 显式闭包类型：

```yo
test_closure :: (fn() -> unit)({
  x := 1;

  // 使用 Impl 的显式闭包类型
  (closure : Impl(Fn(y : i32) -> i32)) = (
    y => {
      x = (x + y);
      return(x);
    }
  );

  closure(1); // x 现在是 2
  closure(1); // x 现在是 3
  result := closure(2); // x 现在是 5
  assert(result == 5);
});
```

2. **使用 `ClosureType({...})`** — 从类型创建闭包值：

```yo
test_closure :: (fn() -> unit)({
  x := 1;

  ClosureType :: Impl(Fn(y : i32) -> i32);
  closure := ClosureType({
    x = (x + y);
    return(x);
  });

  result := closure(2);
  assert(result == 3);
});
```

## 闭包捕获语义

闭包从其环境中捕获变量：

- **值类型**（基本类型、结构体）按值捕获：`Copy` 的值被复制，其他值被移入
- **共享单元**（`Rc`、`Arc`）作为闭包拥有的句柄被捕获；第二个句柄写在捕获列表里，`{ data : Rc.clone(data) }`
- 只有当闭包的类型是 `FnMut` 或 `FnOnce` 时，才能写入它按值持有的状态（否则 E0913）

```yo
test_capture :: (fn() -> unit)({
  // 值类型 — 闭包自己的副本
  mut(counter) := i32(0);

  // 共享单元 — 闭包拥有第二个句柄
  data := Rc.new(RefCell(i32).new(i32(42))); // `std/sync/refcell`

  (mut(closure) : Impl(FnMut(increment : i32) -> i32)) = ({ counter, data : Rc.clone(data) }(increment) => {
    counter = (counter + increment); // 修改闭包自己的副本
    data.*.replace_with(v => (v.* + increment)); // 修改共享单元
    return(counter);
  });

  closure(5);
  // counter 仍然是 0（闭包有自己的副本）
  // data.*.with(v => v.*) 现在是 47（共享单元）
});
```

## 捕获列表

闭包可以在形参之前用一个字段列表列出它的捕获：

```yo
k := i32(3);
w := i32(10);
z := i32(0);
(h : Impl(Fn(m : i32) -> i32)) = ({ k, &w, &mut z }(m : i32) => {
  z.* = (z.* + m); // 通过借用写入调用方的 `z`
  k + w.* + z.*
});
(g : Impl(Fn() -> usize)) = ({ n : s.len(), name : &s }() => (n + name.len()));
count := i32(0);
(i32(1) .. i32(4)).for_each({ &mut count }(x : i32) => {
  count.* = (count.* + x);
});
```

- **条目。** `x`（或 `x : e`）是按值字段：普通数据被复制，不可隐式复制的值被移动。
  `y : &p` 与 `z : &mut p` 借用位置 `p`；`&y` 与 `&mut z` 分别是
  `y : &y` 与 `z : &mut z` 的简写。条目左边是字段名，右边的借用符号决定模式。
- **引用绑定按“复制引用”捕获。** 在标准库和编译器自身源码之外，引用绑定
  （`&T` 形参、`self : &Self`、`y := &x`、`match` 或 `for` 的绑定）的条目 `y`
  （或 `r : y`）复制的是引用本身，而不是它指向的值：`&T` 是 `Copy`，所以 `y`
  之后仍可使用，闭包的来源（origin）是 `y` 所指之处（`x`），而不是绑定 `y`。
  `{ q : &p.field }` 做投影，`{ m : &mut m.* }` 重借 `&mut T`；`&mut` 绑定的按值条目
  `{ m }` 会移动该引用，因此被拒绝。按值捕获任何带来源的值（持有者 `h`、被复制的引用）
  的闭包也带有该来源：不能越过来源所指的局部变量被返回，闭包存活期间该局部变量被冻结。
  被复制的 `&T` 形参（`{ p }`、`{ self }`）带有该形参的来源，因此在闭包类型能携带来源之前，
  这样的闭包是二等值：只能在创建处调用，返回它或把它装箱进 `Dyn(Fn(...))` 都是 E0909。
- **列表是穷尽的。** 有列表时，闭包体只能读取列出的捕获和模块级项；`{}()` 不捕获任何东西。
  没有列表时，捕获仍是隐式的。
- **借用可以指向什么。** 以具名局部绑定为根的位置：不能是临时值，不能是模块级绑定，
  也不能穿过 `Rc`/`Arc`（或任何指针解引用）——请改为捕获句柄：
  `{ &r }() => r.*.items.len()`。`&mut` 位置必须可写。`&` 捕获在闭包体中只读。
- **借用型闭包是二等值**，由它构成的任何值（副本、持有它的元组或记录、捕获它的闭包）
  也是。它可以绑定到局部变量、被调用、传给形参，但不能被返回、存入字段或 `Dyn`、
  移入 `sink` 形参、被 `io.async` 体捕获，或用作类型实参（`ArrayList(type_of(f))`），
  也不能比它借用的东西活得更久（E0909）。`&mut` 捕获还会让闭包成为只能移动的值
  （复制时报 E0901）。
- **`Copy` 与 `Clone` 由捕获记录决定**，与 Rust 相同：闭包在每个按值捕获都是 `Copy`
  （`Clone`）时才是 `Copy`（`Clone`）。所有捕获都是 `&` 的闭包是 `Copy`；拥有 `String`、
  `Rc` 或集合的闭包只能显式复制，因此 `d := c` 会移动它（之后再用 `c` 报 E0901，提示
  给出 `c.clone()`），即使对 `String` 本身写 `t := s` 目前仍是共享；`c.clone()` 克隆每个
  按值捕获、复制其余部分。`&mut` 捕获使闭包两者都不是，`where(T <: Copy)` 会拒绝不是
  `Copy` 的闭包（E0602）。
- **闭包存活期间，被借用的位置被冻结**：不能访问 `&mut` 捕获的位置，不能写入或移动
  `&` 捕获的位置（E0910）。闭包存活到其绑定作用域结束，因此若之后还需要
  该位置，请把闭包及其调用放进一个代码块。
- **调用实参是互斥的。** 持有 `&mut` 捕获的闭包按独占方式借出，因此同一调用不能再传入
  任何能到达被借用位置的东西，接收者和被调用的闭包也算在内（E0910）：
  `bump({ &z }() => z, &mut z)` 会被拒绝。按值传入的 `Copy` 值在调用前就已复制，
  不会到达任何位置，所以字段为 `u64` 时 `self.mix(self.tail)` 是合法的。
- 在 `->` 函数字面量或 `io.async` 体上写捕获列表是错误；`{ x }(y) => …` 也不是
  `match` 分支模式（记录模式是 `{ x, y } => …`）。

## 只调用一次的闭包：`FnOnce`

`FnOnce(...) -> R` 是调用时会消耗闭包本身的闭包 trait。带捕获列表、类型为 `FnOnce(...)` 的闭包拥有其按值捕获，因此函数体可以把其中之一移出：

```yo
take :: (fn(sink(t) : Token) -> i32)(t.n);
t := Token(n : i32(5));
(send : Impl(FnOnce() -> i32)) = ({ t }() => take(t)); // 把 `t` 移出，不做复制
send(); // 消耗 `send`
// send();                                               // E0901：`send` 已被上面的调用移走

run_once :: (fn(sink(f) : Impl(FnOnce() -> i32)) -> i32)(f());
k := i32(3);
(add : Impl(Fn() -> i32)) = ({ k }() => k);
run_once(add); // `Fn` 也能用于一次调用
```

- **调用会消耗闭包。** 第二次调用或之后的任何使用都是 E0901，并指向第一次调用。调用结束时，函数体会
  drop 它没有移出的捕获。从未被调用的闭包随其所有者一起 drop 其捕获。
- **`Fn` 蕴含 `FnMut`，`FnMut` 蕴含 `FnOnce`。** 任何要求 `FnOnce(...)` 的地方都接受 `Fn(...)` 或
  `FnMut(...)` 闭包；在要求 `Fn(...)` 或 `FnMut(...)` 的地方传入 `FnOnce` 闭包是 E0913。
- **至多调用实参一次的 API 按值接收它**：`sink(f) : Impl(FnOnce(...))`，例如 `Option`/`Result` 组合子
  （`map`、`and_then`、`unwrap_or_else` 等）、各种 spawn 以及 `io.async` 的函数体。通过借用形参调用
  `FnOnce` 闭包是 E0901。与所有拥有的值一样，在 `cond`/`match` 部分分支中被调用的 `sink` 闭包，会在
  其余分支末尾不经调用地被 drop。
- **把捕获移出需要 `FnOnce` 和捕获列表。** `Fn(...)` 的调用借用捕获，以便闭包能再次运行，因此在其中移出
  捕获是 E0913，指向移出的那一行。隐式捕获也不能被移出（E0913 会给出捕获列表的写法）。
- `Box(Dyn(FnOnce(...) -> R))` 可以容纳任何只调用一次的闭包；它的调用同样会消耗它。

## 可重复调用的闭包：`FnMut`

`FnMut(...) -> R` 是调用时独占借用闭包（`self : &mut Self`）的闭包 trait。它的函数体可以写入自身状态（捕获列表的按值条目）以及它的 `&mut` 捕获，写入会从一次调用
保留到下一次：

```yo
(mut(tick) : Impl(FnMut() -> i32)) = ({ n : i32(0) }() => {
  n = (n + i32(1)); // 闭包自身的状态
  n
});
tick(); // 1
tick(); // 2

twice :: (fn(f : &mut Impl(FnMut() -> i32)) -> i32)(f() + f());
twice(&mut tick); // 3 + 4：被调函数写入调用方的闭包
twice({ n : i32(10) }() => {
  n = (n + i32(1));
  n
}); // 字面量是临时值，以独占方式借出
```

- **调用独占借用闭包**，就像 `xs.push(v)`。因此闭包要通过 `mut(f)` 绑定、`f : &mut Impl(FnMut(...))`
  形参、`(mut(d) : Box(Dyn(FnMut(...))))` 或临时值来调用。通过未标记的绑定或按值形参调用是 E0917
  （把形参重新绑定：`mut(g) := f;`），通过 `f : &Impl(FnMut(...))` 或 `&Dyn(FnMut(...))` 调用是
  E0908，在它的借用仍然存活时调用是 E0911。
- **`Fn` 蕴含 `FnMut`。** 任何要求 `FnMut(...)` 的地方都接受 `Fn(...)` 闭包。把类型为 `FnMut(...)`
  的闭包传给要求 `Fn(...)` 的地方，或擦除为 `Dyn(Fn(...))`，是 E0913：那个位置可能通过共享借用再次
  调用它。`FnOnce` 闭包不是 `FnMut`（E0913）。
- **按值条目只有在 `FnMut` 下才可写。** 同样的函数体若类型为 `Fn(...)` 或 `FnOnce(...)`，写入条目是
  E0917：那里的写入只会到达每次调用的副本。在 `FnOnce` 下，请重新绑定该条目（`mut(m) := n;`）。
  条目比每次调用活得更久，因此不能保存指向本次调用形参的引用（`v : &T` 时写 `last = .Some(v)`，E0923），
  也不能保存指向函数体局部变量或闭包自身按值条目的引用（E0912）；请存入拥有所有权的值，或存入借用捕获
  （`{ o : &x, last : Option(&T).None }`，`last = .Some(o)`）。
- **隐式捕获只有在拥有其记录的 `FnMut` 或 `FnOnce` 闭包中才可写。** `Fn(...)` 闭包，或借给借用形参的
  字面量（`run(&(() => …))`），写入它在函数体中隐式捕获的变量——`s = …`、`s.push_str(…)`、
  `grow(&mut s)`——是 E0913：记录里存的是闭包自己的 `s` 副本（借出的字面量中则是调用方值的按位别名），
  写入会释放调用方仍然拥有的存储。请改为借用该位置：在 `FnMut` 位置写 `{ &mut s }(...) => …`。`&`
  捕获条目是只读的：通过 `{ r : &f }` 调用 `FnMut` 闭包是 E0908。
- **`FnMut` 闭包只能移动。** 无论捕获是什么，它都不派生 `Copy` 或 `Clone`：副本会把状态一分为二。
  `Box(Dyn(FnMut(...)))` 同样只能移动。
- **`Sync` 位置拒绝它。** `Impl(Fn(...), Sync)` 可能从多个线程同时调用闭包，因此写入 `&mut` 捕获或
  自身状态的闭包在那里被拒绝，错误会指出 `FnMut`。
- **把持有 `&mut` 捕获的字面量传给 `Fn(...)` 位置是 E0913。** 持有 `&mut` 捕获的字面量仅凭其捕获
  就是 `FnMut(...)`：std 中借给调用的回调（`for_each`、`retain`、`sort_by`、`with_lock` 的函数体、
  `RefCell.with`、`Once.call`、`*_lazy` 日志）都接受 `f : &mut Impl(FnMut(...))`，至多调用一次的回调
  （`Option`/`Result` 组合子）接受 `sink(f) : Impl(FnOnce(...))`，写入因此改在 `FnMut` 或 `FnOnce`
  位置通过捕获的指针进行。`Fn` 只在回调被共享、被存储超出调用、或从其他线程调用时保留。

## 闭包类型限制

每个闭包都有唯一的类型，即使它们看起来完全相同：

```yo
// 这将失败 — 每个闭包都有不同的类型
test_error :: (fn() -> unit)({
  closure : Impl(Fn(y : i32) -> i32);

  cond(
    some_condition() => {
      a := 1;
      closure = (y => (y + a)); // 类型 1
    },
    true => {
      b := 1;
      closure = (y => (y + b)); // 类型 2 — 不同！
    }
  );
  // 错误：即使两个闭包完全相同，它们的类型也不同
});
```

闭包永远不是裸函数指针。声明为 `fn(...) -> R` 的参数或字段只能容纳具名函数或不捕获任何变量的 `->` 字面量；
`=>` 闭包需要能携带闭包的类型：

```yo
takes_ptr :: (fn(f : (fn(a : i32) -> i32), v : i32) -> i32)(f(v));
takes_fn :: (fn(f : Impl(Fn(a : i32) -> i32), v : i32) -> i32)(f(v));
k := i32(10);
takes_ptr(double, 5); // 正确：具名函数
takes_ptr(y => (y + k), 5); // error[E0605]: a closure (`=>`) cannot be used where the function-pointer type ... is expected
takes_fn(y => (y + k), 5); // 正确
```

闭包的函数体会与它所传入的 `Fn(...) -> R` 的返回类型做比较：`takes_fn(x => true, 5)` 是 E0604。

闭包的类型可以用来实例化容器。`ArrayList(type_of(k))` 保存 `k` 的副本；两个闭包的列表是两种类型，因此一个闭包不能放进另一个闭包的列表：

```yo
(k1 : Impl(Fn() -> unit)) = (() => println(&a));
(k2 : Impl(Fn() -> unit)) = (() => println(&s));
mut(l1) := ArrayList(type_of(k1)).new();
l1.push(k1); // OK
l1.push(k2); // 错误：k2 是另一种闭包类型
```

要把不同的闭包放进同一个集合，请将它们存为 `Box(Dyn(Fn(...)))`。

## 闭包与共享单元

捕获共享单元的闭包拥有指向它的一个句柄；单元的载荷通过 `RefCell` 改变：

```yo
{ assert } :: import("std/assert");
{ RefCell } :: import("std/sync/refcell");

make_incrementer :: (fn(start : Rc(RefCell(i32))) -> Impl(Fn() -> i32))({
  return(() => {
    start.*.with_mut((n : &mut i32) => {
      n.* = (n.* + 1);
    });
    start.*.with((n : &i32) => n.*)
  });
});

test :: (fn() -> unit)({
  counter := Rc.new(RefCell(i32).new(0));
  inc := make_incrementer(Rc.clone(counter));

  assert(inc() == 1);
  assert(inc() == 2);
  assert(counter.*.with((n : &i32) => n.*) == 2);
});
```

更多示例请参阅 `tests/closure.test.yo`。
