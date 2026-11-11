# Dyn/dyn 动态分派实现

## 概述

`Dyn(Trait, ...)` 是 trait 对象，即 Rust 的 `dyn Trait`：具体类型被擦除，每次方法调用都经由虚表。`Dyn` 是**非定长**类型（决策 49，见 [`plans/VALUES_BY_DEFAULT.md`](../../plans/VALUES_BY_DEFAULT.md)）。不同具体类型的载荷大小不同，所以 `Dyn` 自身没有大小，只能放在指针后面。由指针决定谁拥有这个对象：

| 形式 | 拥有对象 | 构造方式 |
| --- | --- | --- |
| `Box(Dyn(T))` | 独占：销毁 box 就销毁载荷 | `dyn(Box.new(v))`、`dyn(Box.new(v, alloc : a))` |
| `Rc(Dyn(T))` | 共享，通过句柄只读 | `dyn(Rc.new(v))` |
| `Arc(Dyn(T, Send, Sync))` | 跨线程共享，只读 | `dyn(Arc.new(v))` |
| `&Dyn(T)` / `&mut Dyn(T)` | 不拥有：借用一个留在原处的位置 | `dyn(&v)` / `dyn(&mut v)`；`&b.*` / `&mut b.*` |

`dyn(...)` 是唯一的入口。它擦除所给指针的指向类型，并返回同一种指针，只是指向 `Dyn`，trait 列表取自该位置所期望的类型。

```yo
{ println } :: import("std/fmt");
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
speak_via :: (fn(d : &Dyn(Speak)) -> i32)(d.speak());
main :: (fn() -> unit)({
  c := Cat(n : i32(3));
  a := speak_via(dyn(&c)); // borrowed: nothing is allocated, and `c` stays usable
  (b : Box(Dyn(Speak))) = dyn(Box.new(Cat(n : i32(4)))); // owned
  m := speak_via(&b.*); // lend the boxed object
  (s : Rc(Dyn(Speak))) = dyn(Rc.new(Cat(n : i32(5)))); // shared
  total := (a + m + s.speak() + c.n);
  println(&total);
});
export(main);
```

### 发布状态（v0.2.77）

决策 49 的编译器部分（S1）随 v0.2.77 发布，而 prelude 的 `Box`、`Rc` 和 `Arc` 要到 v0.2.78（S2）才对非定长类型泛型化。在此之前：

- **`Box(Dyn(T))` 是较早的拥有型 `Dyn` 值。** 在 v0.2.77 中，用作值类型的裸写法 `Dyn(T)` 表示 `Box(Dyn(T))`，普通的 `dyn(v)` 表示 `dyn(Box.new(v))`，而把这种值的 `&d` 传入 `&Dyn` 槽位时，其借出方式与 `&d.*` 相同。`yo fix <path> --migrate unsized` 会把裸写法改写成新写法；在 v0.2.78 中它们变成错误（E0619、E0620）。
- **在 v0.2.78 之前，`Rc(Dyn(T))` 是两次分配**：`dyn(Rc.new(v))` 把一个装箱的 `Dyn` 放进计数单元。它的类型和共享规则已经是最终形态。
- **在 v0.2.78 之前，对拥有型对象的 `downcast` 写在 `&d.*` 上。** 与任何引用一样，`downcast(&d.*, V)` 得到 `Option(&V)`。失败时交还 box 的拥有型形式随 prelude 一起到来；对拥有型 `d` 写 `downcast(d, V)` 仍是下文所述的复制形式。
- **在 v0.2.78 之前，`dyn(&v)` 引用只能用作调用实参。** 它不能被命名、存储或返回：把它绑定到局部变量或存储起来是 E0911，而返回它（包括经由投影或放在 `Option` 里返回）是 E0912。请直接传递，或者用 `dyn(Box.new(v))` 拥有该对象。

在 v0.2.78 之前，裸指针 `*Dyn(T)`/`?*Dyn(T)` 同样是指向拥有型 `Box(Dyn(T))` 的指针；迁移会把它写成 `*Box(Dyn(T))`。

## 核心设计

### 1. 胖指针

每个指向 `Dyn` 的指针都是两个字：载荷的地址，以及载荷具体类型的虚表：

```c
typedef struct {
  void* data;                 // the payload
  const TraitVtable* vtable;  // one static vtable per (concrete type, trait list)
} __yo_dyn_trait_Speak;
```

`&Dyn(T)` 以这一对值按值传递，所以 `dyn(&v)` 不分配任何内存：`data` 就是 `&v`。

### 2. 虚表

虚表描述的是具体类型而不是指针，所以同一个具体类型之上的每一种指针共用它。它以固定的前缀开头，然后是每个可调用方法一个槽位：

| 槽位 | 含义 |
| --- | --- |
| `__yo_type_id` | 具体类型的 id，`downcast` 用它比较 |
| `size`、`align` | 载荷的大小和对齐，由 `size_of_val(d)` 和 `align_of_val(d)` 读取 |
| `drop_in_place` | 就地销毁载荷 |
| `clone_into` | 把载荷克隆到调用方提供的存储中；trait 列表不含 `Clone` 时为 `NULL` |
| `payload_of`、`retain`、`release`、`clone` | v0.2.77 拥有型值的槽位；`Box(Dyn)` 成为 prelude 的 `Box` 后移除 |

```c
typedef struct {
  uintptr_t __yo_type_id;
  size_t size, align;
  void (*drop_in_place)(void*);
  void (*clone_into)(const void*, void*);
  /* legacy suffix: payload_of, retain, release, clone */
  int32_t (*speak)(const void*);  // the method slots
} __yo_dyn_trait_Speak_vtable;
```

每个方法槽位都是一个包装函数，把 `data` 转回具体类型并调用 impl。一次方法调用是一次加载加一次间接调用：

```c
int32_t r = d.vtable->speak(d.data);
```

## 对象安全约束（遵循 Rust）

一个方法满足以下条件时，可以通过 `Dyn(Trait)` 接收者调用：

1. 它的接收者是引用，`self : &Self` 或 `self : &mut Self`；
2. `Self` 不出现在签名的其他位置：既不是其他参数，也不是结果，也不在其中出现（`Option(Self)`、`Result(Self, E)`）；
3. 不带 `generic(...)` 参数。

原因如下：

- `Dyn` 擦除了具体类型，因此 `Self` 参数或结果在调用处没有唯一的 C 类型：同一个 `Dyn` 背后的两个具体类型大小和表示都不同。
- 泛型方法是一族函数（每个实例化一个），而一个虚表槽位只能放一个。
- 按值的 `self` 会把载荷从拥有它的指针里移出来，而非定长的载荷没有可供移动的值形式。

只有这些方法拥有虚表槽位。通过 `Dyn` 调用其他方法会在调用处报错 E0614（`yo explain E0614`）。带有按值 `self` 方法的 trait 完全不能放到 `Dyn` 后面，无论载荷是什么：按值接收操作数的运算符 trait（`LogicalNot`、`Negate`、`Add` 等）都在此列。

```yo ignore
Sp :: trait(speak : (fn(self : &Self) -> i32), me : (fn(self : &Self) -> Self));
(d : Box(Dyn(Sp))) = dyn(Box.new(Cat(n : i32(3))));
d.speak(); // OK: `Self` only as the receiver
d.me(); // error[E0614]: Method "me" of trait Sp cannot be called through a Dyn receiver (dyn(Sp)): it returns Self, which the Dyn erases.
```

基于 trait 约束的一揽子固有方法（`impl(generic(E), where(E <: Named), E, shout : ...)`）同样接受 `Dyn(Named)` 接收者。它不是 trait 成员，没有虚表槽位：这个调用是对该方法（针对 `Dyn` 特化）的普通调用，而方法内部的 `self.name()` 通过虚表分派。

直接写在 `Dyn` 类型上的固有 impl 会为这个 `Dyn` 添加方法，就像 Rust 的 `impl dyn Error`：
`std/error.yo` 的 `impl(AnyError, is : ...)` 让 `err.is(NotFound)` 可以用在 `AnyError` 上。

通过泛型 impl 实现的 trait（`T <: ToString` 时 `ArrayList(T)` 的 `ToString`）可以放到 `Dyn` 后面：`dyn(&xs)` 会针对具体类型特化泛型 impl 的方法。

**没有隐式的向上转换。** `Dyn(Sp, Ot)` 不会流入 `Dyn(Sp)` 槽位：两者的虚表布局不同，因此这种转换需要用 `upcast`（见下文）显式写出。trait 列表是一个集合：`Dyn(Sp, Ot)` 和 `Dyn(Ot, Sp)` 是同一个类型。

**同一个 `Dyn` 中的两个 trait 不能有同名方法**（E0616）。`Dyn` 按名字调用方法，因此当 `A` 和 `B` 都声明了可调用的 `get` 时，`Dyn(A, B)` 会在写出该类型的地方被拒绝：`d.get()` 无法说明它指的是哪个 trait 的方法。

## 构造：`dyn(...)`

`dyn(p)` 接收一个指向具体值的指针，返回同一种指针，只是指向 `Dyn`：

| 写法 | 类型 | 说明 |
| --- | --- | --- |
| `dyn(Box.new(v))` | `Box(Dyn(T))` | `v` 移入一个新的 box；`alloc : a` 把它放进 `a` |
| `dyn(Rc.new(v))` | `Rc(Dyn(T))` | 一个新的共享单元 |
| `dyn(Arc.new(v))` | `Arc(Dyn(T, Send, Sync))` | 一个新的原子单元；载荷必须是 `Send` 和 `Sync` |
| `dyn(&v)` | `&Dyn(T)` | `v` 被只读借出，调用之后仍可使用 |
| `dyn(&mut v)` | `&mut Dyn(T)` | `v` 被独占借出：同一次调用中再次借出 `v` 是 E0910 |

trait 列表取自期望的类型：形参、带标注的绑定或字段。具体类型必须实现列出的每个 trait。对已经是 `Dyn` 的值写 `dyn(d)` 是一个错误，并会提示使用 `upcast`：载荷的类型已被擦除，没有东西可以用来构造新的虚表。

对具名的 `Rc`/`Arc` 句柄写 `dyn(h)` 会被拒绝：句柄的单元可能是共享的，就地在其上构造的 `Dyn` 不会知道其他句柄。请写 `dyn(Rc.new(v))`，在创建共享对象的地方构造它；或写 `dyn(Box.new(v))` 来独占它。

`dyn` 之下 `Box.new`、`Rc.new` 或 `Arc.new` 内的闭包字面量，其类型取自期望的 `Dyn(Fn(...))`，因此它的参数不需要标注：

```yo
run :: (fn(d : &Dyn(Fn(x : i32) -> i32)) -> i32)(d(i32(2)));
main :: (fn() -> unit)({
  k := i32(3);
  (f : Box(Dyn(Fn(x : i32) -> i32))) = dyn(Box.new(x => (x * k)));
  _n := run(&f.*);
});
export(main);
```

### `dyn(...)` 是唯一入口

只有程序写出 `dyn(...)` 的地方，值才会变成 `Dyn`（决策 44）。带类型的槽位不做隐式转换，无论是名义类型的值还是可调用值。把具名闭包、具名 `fn`、`Impl(Fn(...))` 形参或闭包字面量放进拥有型 `Dyn(Fn(...))` 的绑定、字段、实参或结果是错误 E0618，其附注给出 `dyn(f)`，即 v0.2.77 中 `dyn(Box.new(f))` 的写法。`&Dyn(Fn(...))` 形参用 `dyn(&f)` 借用闭包，不做任何分配。

```yo
run :: (fn(d : &Dyn(Fn() -> i32)) -> i32)(d());
main :: (fn() -> unit)({
  n := i32(3);
  (f : Impl(Fn() -> i32)) = (() => n);
  _x := run(dyn(&f)); // a borrowed closure: no allocation
  (g : Box(Dyn(Fn() -> i32))) = dyn(Box.new(f)); // `= f` is E0618
  _y := run(&g.*);
});
export(main);
```

`Impl(Fn(...))` 槽位是闭包自身的静态类型，不是擦除，所以闭包可以直接流入其中。

## 位置：`b.*` 与 `size_of_val`

对 `b : Box(Dyn(T))` 的 `b.*`，以及对 `Rc`/`Arc` 句柄的 `h.*`，是类型为 `Dyn(T)` 的位置。它可以被借用（`&b.*`，通过 `Box` 还可以 `&mut b.*`），也可以通过它调用方法，但绝不能按值绑定、移动、赋值或匹配：`x := b.*` 是 E0619，因为该位置没有自己的大小。通过 `Rc` 或 `Arc`，载荷是只读的，所以 `&mut h.*` 和 `&mut Self` 方法是 E0919。

`size_of_val(d)` 和 `align_of_val(d)` 从虚表读取载荷的大小和对齐；`size_of(Box(Dyn(T)))` 是两个指针。

## 运行时类型检查：`downcast(d, V)`

`downcast` 取回具体类型。通过引用时，它借用载荷，不做复制：

```yo ignore
downcast(r : &Dyn(T), V) -> Option(&V)
downcast(r : &mut Dyn(T), V) -> Option(&mut V)
```

```yo ignore
(animal : Box(Dyn(Animal))) = dyn(Box.new(Cat.new()));
match(
  downcast(&animal.*, Cat),
  .Some(cat) => cat.purr(), // `cat : &Cat`, borrowed from the box
  .None => println(`not a cat`)
);
```

第二个参数是一个**类型**，在编译期求值。`std/error.yo` 里 `AnyError` 的 `err.is(T)` 就是用 `downcast` 构建的。

对拥有型 `d` 写 `downcast(d, V)` 保留 v0.2.77 的形式：它返回 `Option(V)`，即载荷的一份拷贝，所以仅移动的 `V` 需要列出 `Clone` 的 `Dyn`。在 v0.2.78 中，拥有型形式变为 `Result(Box(V), Box(Dyn(T)))`，失败时交还 box；在此之前，只读载荷时请写 `downcast(&d.*, V)`。

**检查是怎么做的。** 每个具体类型都有一个静态变量，其**地址**就是它的类型 id，每个虚表都在 `__yo_type_id` 中带着它。检查就是一次指针比较，`d.vtable->__yo_type_id == (uintptr_t)&__yo_typeid_Cat`，没有字符串比较，也没有 RTTI 表。

**永远不可能成功的 downcast 是编译期的 `.None`。** 编译器能看到程序中每一个 `dyn(...)` 的创建点。如果没有任何地方把 `V` 擦除进这个 `Dyn`，就没有任何虚表携带 `V` 的类型 id，于是该表达式被降级为常量 `.None`。

**没有非检查式的强制转换。** 不匹配时 panic 写作 `downcast(&d.*, V).unwrap()`。`type_id` 接受一个**类型**而不是值；不能用来在运行时判断 `Dyn`。

## 向上转换：`upcast(p, Dyn(...))`

`upcast` 把同一个载荷放到 trait 更少的 `Dyn` 后面，并保持指针的种类：

```yo ignore
c := Cat(n : i32(1));
speak_via(upcast(dyn(&c), Dyn(Speak))); // &Dyn(Speak, Run) -> &Dyn(Speak)
(b : Box(Dyn(Speak, Run))) = dyn(Box.new(Dog()));
(s : Box(Dyn(Speak))) = upcast(b, Dyn(Speak)); // the box moves into the result
```

目标写的是 `Dyn`，而不是指针。它在编译期检查，因此返回指针而不是 `Option`：目标要求的每个 trait 都必须是源携带的（包括展开后的父 trait），目标排除的每个 trait（`!Send`）都必须是源也排除的。从 `Dyn(Speak)` 做 `upcast(one, Dyn(Speak, Run))` 会报 E0602。

**实现方式。** 具体类型在 upcast 处已被擦除，但在构造源值的 `dyn(...)` 处并没有，而且编译器能看到整个程序。对源 `Dyn(Src)` 的每个 `upcast(_, Dyn(Tgt))`，每个 `Dyn(Src)` 虚表都多带一个指针 `__yo_up_<Tgt>`，指向同一具体类型的 `Dyn(Tgt)` 虚表。upcast 替换虚表那个字：

```c
(Tgt){ .data = d.data, .vtable = d.vtable->__yo_up_Tgt }
```

Rust 也是这样实现 `dyn Sub -> dyn Super` 的，对结果做 `downcast` 仍能找回原来的具体类型。不含 `upcast` 的程序不会生成任何额外的指针。

## 所有权

`Dyn` 自身没有所有权，适用的是它的指针的所有权（决策 7，经决策 49 修订）：

- **`Box(Dyn(T))`** 独占其载荷。除非 trait 列表含有 `Clone`，否则它是仅移动的；含 `Clone` 时，`b.clone()` 会在放置源值的分配器中生成一份独立的载荷（决策 12）。
- **`Rc(Dyn(T))` 和 `Arc(Dyn(T, Send, Sync))`** 共享同一份载荷；`Rc.clone(h)` 递增计数，通过句柄载荷是只读的（决策 46）。
- **`&Dyn(T)` 和 `&mut Dyn(T)`** 借用，遵循决策 43 的引用规则。

```yo
{ println } :: import("std/fmt");
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
derive(Cat, Clone);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
main :: (fn() -> unit)({
  (d : Box(Dyn(Speak, Clone))) = dyn(Box.new(Cat(n : i32(3))));
  e := d.clone(); // an independent payload: d and e share nothing
  both := (d.speak() + e.speak());
  println(&both);
  f := d; // the last use of d: a move
  one := f.speak();
  println(&one);
});
export(main);
```

trait 列表中的 `Clone` 不会给 `Dyn` 增加自己的方法槽位，因为它的 `clone` 返回被擦除的 `Self`；它填的是 `clone_into` 槽位。因此，同时含有 `Clone` 和另一个声明了可调用 `clone` 方法的 trait 的 `Dyn` 会报 E0616，与其他方法名冲突相同。

**源值之后仍被使用的复制是 E0901。** 复制 `Box(Dyn(T))` 会移动它，因此之后再使用源值就是使用已移动的值：

```yo ignore
(d : Box(Dyn(Speak))) = dyn(Box.new(Cat(n : i32(3))));
e := d; // value moved here
d.speak(); // error[E0901]: use of moved value: `d`
```

从无法交出值的存储中复制，会在复制处直接被拒绝。这类存储包括字段或元素、解引用、模块级绑定、`&mut` 借用、`&T` 参数以及闭包的捕获。附注会说明适用的修复：若 `Dyn` 列出了 `Clone`，就用 `d.clone()`；否则建议移动该值、借出它、在 trait 列表中加入 `Clone`，或通过 `Rc(Dyn(...))` 共享。在不含 `Clone` 的拥有型 `Dyn` 集合上调用复制型访问器（`xs.get(i)`、`xs.last()`）会在调用处报 E0901：请通过下标读取元素（`xs(i).m()`），或把它移出（`xs.pop()`）。

**`Send` 和 `Sync` 来自 trait 列表。** `Box(Dyn(T, Send))` 可以移动到另一个线程。`Arc(Dyn(...))` 需要写明 `Send, Sync` 的列表。`Rc(Dyn(...))` 两者都不是。

**错误按值抛出。** `Exception.throw` 和 `ResumableException(T).throw` 按值接收 `error : AnyError`，所以处理器拥有它捕获的错误，并通过移动来保留它（存储、返回、包进 `Context`），只读取该错误的函数则借用它。`AnyError` 在 v0.2.77 中是拥有型的 `Dyn(Error, Clone)`；v0.2.78 把它写作 `Box(Dyn(Error))`。

## 设计总结

1. **`Dyn` 是非定长的。** 它放在指针后面，由指针拥有它：`Box` 独占，`Rc` 和 `Arc` 共享且只读，`&`/`&mut` 借用。
2. **每个指向 `Dyn` 的指针都是胖指针**：`{ data, vtable }`，所以借用不需要分配。
3. **每个具体类型和 trait 列表一个虚表**，由各种指针共用：前缀 `{ type_id, size, align, drop_in_place, clone_into }`，然后是方法槽位。
4. **`dyn(...)` 是唯一显式写出的非定长化**：`dyn(Box.new(v))`、`dyn(Rc.new(v))`、`dyn(Arc.new(v))`、`dyn(&v)`、`dyn(&mut v)`。
5. **`downcast` 和 `upcast` 保持指针的种类**：通过引用时，`downcast` 把载荷借用为 `Option(&V)`；`upcast` 替换虚表那个字。
6. **在 v0.2.77 中**，`Box(Dyn(T))` 是较早的拥有型值，`Rc(Dyn(T))` 需要两次分配，拥有型 `downcast` 写在 `&d.*` 上，而 `dyn(&v)` 引用只能用作调用实参；`yo fix --migrate unsized` 会把较早的写法改写成新写法。
