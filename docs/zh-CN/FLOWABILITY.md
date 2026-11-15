# 可流动性（Flowability）—— 默认安全的引用

> **状态（2026-11-12）。** 本页仍把借用描述为二等的（只出现在参数位置和局部绑定位置）。
> 自决策 43 起，引用是一等值，其类型带有它的来源（origin），即它可能指向的位置集合：
> 它还可以被返回，存入 struct 字段、元组或 `Option`，以及被闭包捕获
> （[`plans/backlog/REFERENCES_AND_ORIGINS.md`](../../plans/backlog/REFERENCES_AND_ORIGINS.md)；
> 面向用户的概述见 [MEMORY_SAFETY.md](./MEMORY_SAFETY.md)）。
> 下文的冻结与存活规则没有变化。本页说悬垂引用“无法表达”的地方，应读作“被来源检查器拒绝”；
> 检查器的已知缺口列在
> [`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md`](../../plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md)。

Yo 在编译期保证：安全代码无法构造出悬垂引用。这一设计是**构造即正确**
（sound by construction）：安全语言中根本没有任何方式能形成指向可重分配
存储的指针，因此经典的失效陷阱（增长列表导致借用悬垂）不是被某种聪明的
分析"拒绝"的 —— 它们*无法表达*。

## 借用能出现在哪里

借用（`&T` 或 `&mut T`）是 Yo 的二等引用，它只存在于**两个**位置：**参数位置**和
**局部绑定位置**。`name : &mut T` 接收调用者的左值（可写回，大结构体
免拷贝）；接收借用的回调参数（`body : Impl(Fn(v : &mut T) -> R)`，如
`Mutex.with_lock`）是同一机制向下传递一层。局部借用把 `name` 绑定到
`place` 所指的存储：`name := &mut place;`
是独占借用，`name := &place;` 是只读借用（`plans/VALUES_BY_DEFAULT.md`
决策 18）：

```yo
x := i32(1);
y := &mut x; // y 命名 x 的槽位
y.* = i32(2); // 写入 x
z := x; // 可以：y 的最后一次使用在上面，x 重新可用
r := &p.x; // 对值结构体字段的只读借用
v := r.*; // 通过 r 读取；`r.* = v` 会是 E0908
n := &mut h.n; // RC 对象的字段：h 指向的对象在此作用域内被钉住
copy := n.*; // 拷贝被引用的值
```

**借用从绑定处一直存活到它的最后一次使用**，并在这段范围内冻结它的位置：

- `&` 借用存活时，它的位置、位置内部的位置以及包含它的位置都不能被写入或移动；
- `&mut` 借用存活时，除通过该借用外完全不能访问它们；
- **兄弟字段不受影响**：`a := &mut p.x; b := &mut p.y;` 是合法的；
- 在引用单元（`Rc`、`Arc`、`ref` 对象）之下，**整个单元是一个单位**，
  因为其他句柄也能到达它：`a := &mut h.n; b := &mut h.s;` 会被拒绝；
- 使用该借用的循环会让它在整个循环内保持存活（下一次迭代还会使用它）；
- 借用的借用会让它的来源与它存活得一样久。

冲突的访问是 E0911，通过 `&` 借用写入是 E0908。另有两条规则覆盖编译器
无法看到全部别名的位置：**模块级**位置的借用不能跨越调用存活（被调用方可以
按名字访问该位置）；位置经由引用单元或模块级位置的借用不能跨越 **`await`**
存活。调用自身的实参借用遵循同样的道理：模块级绑定除非声明为 `mut(name)`
否则不可变，不可变的绑定可以借给任何调用，而把 `mut(...)` 绑定或它下面的
位置借给调用是 E0916（见[错误参考](ERROR_DIAGNOSTICS.md)）。

局部绑定接受与实参相同的**位置（place）**（见下），并多出一种：经过 RC
对象到达的字段（`h.n`、`a.b.n`）是允许的，并会**钉住**最内层的对象 ——
一个隐藏的持有局部让它一直存活到绑定的作用域结束，`break`、`return`
与效应 `unwind` 一视同仁。**元素位置**（`xs(i)`、`p.*`）会被拒绝：指向
集合存储内部的指针没有绑定可以钉住的所有者。绑定只能是局部的（不能在模块
级），且只能用 `:=`。它们在 `io.async` 体内同样可用；当位置停留在任务局部
的值中时，也可以跨越其中的 await：任务把绑定、它钉住的对象以及位置的根都
保存在自己的内存里。

**重新指向借用**用来遍历链式结构（决策 25）：`cur = &mut place` /
`cur = &place` 把 `cur` 移到同类型的另一个位置 —— `cur` 目标的字段，
对 `cur` 直接做 `match` 得到的绑定的字段（该绑定就是 `cur` 目标中的一个
位置；途经的 `Box` 会被穿过），或另一个变量的位置。由右侧的符号决定：
不带符号的 `cur = v` 经由借用把 `v` 写入被借出的位置，如下例最后一行：

```yo
append :: (fn(list : &mut List, v : i32) -> unit)({
  cur := &mut list.head; // Option(Box(Node))
  while(cur.is_some(), {
    match(
      cur,
      .Some(n) => {
        cur = &mut n.next;
      },
      .None => ()
    );
  });
  cur.* = .Some(Box.new(Node(value : v, next : .None))); // 写入尾部槽位
});
```

另一个变量的位置（`cur = &mut other.head`）是一个新的借出，按声明的规则检查：
`&mut` 需要 `other` 带 `mut`，不能与其存活的借用冲突，且在 `other` 的作用域
结束后不能再使用 `cur`（在重新指向处报 E0911）。`cur = &y` 之后，在 `cur`
存活时写 `y` 是 E0911；指向模块级位置时，`cur` 存活范围内的每个调用和 `await`
都是 E0911，与声明时借用它相同。调用结果、索引、`.*` 一步（尚未允许）以及按值
`match(cur.*, …)` 的绑定（载荷的副本）都会被拒绝。声明时的位置（`list.head`）在
`cur` 的整个存活范围内保持冻结；当派生自 `cur` 当前目标的借用仍存活时，
重新指向是 E0911。穿过 `Box` 的一步没有开销。每一步进入一个单元时（对
`Option(Rc(Node))` 的 `&` 遍历；`Rc` 的载荷是只读的，所以 `&mut` 遍历需要
`Box`）都会钉住它，并释放上一步钉住的单元，因此即使别的句柄丢弃了某个节点，
遍历也是内存安全的。

**函数只能以投影的形式返回借用**（`-> &T` / `-> &mut T`，决策 24）：函数体
产出一个用结果符号书写的位置（`&self.a`、`&mut self.rows(i)`）或引用绑定（`x : &T` 的 `x`），其根是函数自己
的某个借用参数；投影通过下标（`x(i)`）到达，也可以直接调用（`t.index(i)`，
其结果就是那个位置；`r := t.index(i)` 绑定一个局部借用，在它存活期间冻结调用的
借用实参；见 [INDEX_TRAIT.md](./INDEX_TRAIT.md#投影)）。借用也不能
存入字段、被闭包捕获、或出现在泛型类型内。借用在调用边界或绑定处出生、随所在作用域消亡 —— 它永远不可能
比它指向的存储活得更久。

出于同样的原因，**局部借用永远不跨越函数边界**：`return(y)` 与以该借用
（或从它到达的位置，包括函数体结果所终止于的嵌套块）作为结果表达式的
函数体都是 **E0912**（决策 18 规则 1）。即便在可隐式复制类型的借用上读取
目前会产生一份副本，这个拼写指名的也是借用本身，而不是它读取到的值。
请先把值读到一个自有局部变量中（`v := y;` …… `v`）；对借用调用函数或做
运算（`y.len()`、`y + i32(0)`）本身产生值，是合法的。`&mut T`
**参数**是另一套机制：返回它仍然返回的是 pointee 副本。

传给 `&mut T` 参数的实参是一个简单的左值**位置（place）**：

- 完整变量（任何作用域 —— 变量槽位是稳定存储）；
- 以**局部变量或参数**为根的 `var.field`（或 struct 字段路径）——
  该位置位于根对象的分配内部，调用者的句柄会让它在整个调用期间存活；
- 经过中间 **object**（如 `a.b.s` 中 `b` 是 object 字段）的链，以及
  以**模块级**变量为根的字段链都会被拒绝 —— 被调用者可能替换该句柄的
  槽位并释放被借用的存储。修复只需一行：先把对象绑定到局部
  （`b := a.b`）—— 局部句柄会自然地钉住它；
- **索引元素**（`xs(i)`）或经过**中间 object** 的链（包括 `Rc` 解引用
  `b.*` —— `Rc` 是普通 object，`*` 只是字段名）是指向堆对象存储内部的
  指针；只有当被调用者无法接触到该对象时才能作为 `&mut` 实参 —— 同一次
  调用中传入该容器/单元（或别名）、索引模块级容器，或传入**任何其他
  可能持有它的句柄的实参**，都会被拒绝（增长或重新赋值会在引用之下释放
  存储）。实参可能持有句柄，是指它是闭包，或者它的类型的值能在字段、
  单元、box 或指针中持有容器类型或通往容器的字段路径上某个类型的值；
  `Dyn` 或未确定的类型变量总是可能持有。因此 `xs : ArrayList(String)`、
  `v : String` 时的 `replace(&mut xs(i), v)` 是合法的：`String` 不会持有
  `ArrayList(String)`。仅元素的用法（`to_string(xs(i))`、`${xs(i)}`、
  `bump(xs(i))`、`owner_box.*.id.clone()`）安全且合法；要在一次调用中
  同时使用元素和容器，先把元素读到局部变量（`.get(i)` 复制它，`std/mem`
  的 `take(&mut xs(i))` 把它移出）。

> **运行时后挡。** 有一种形态可以绕过静态实参可达性检查：容器先逃逸进
> **全局**堆结构（`g.push(xs); bump(xs(i))`，其中 `bump` 通过全局增长
> `xs`）。静态封闭它需要全程序逃逸分析。一个轻量级的运行时借用标志
> （RC 头部的 `borrow_count`，利用现有填充字节，零额外内存）封闭了该残留：
> 被调用者触发确定性 panic（`"container operation while an interior reference
borrows from it"`）而非内存破坏。同缓存行加载 + 预测分支 —— 实测约
> ~0% 开销。

## 元素访问：句柄与拷贝，而非内部指针

容器只交出**值**，从不交出指向其缓冲区内部的指针：

```yo
e := xs.get_cloned(i); // String 元素：一份副本（自 B8 起 String 是值），
//   在 xs.push / realloc 之后依然有效
xs.with(i, s => s.push_str("!")); // 就地写入元素
h := xs.get(i); // `ref(struct(...))` 元素：指向对象的句柄，
//   通过它就地变异对象
xs(i) = v; // 索引写：就地替换元素
t := xs.get(i).unwrap(); // Copy 的 struct 元素：拷出 ……
xs(i) = t2; //   …… 再写回
for(xs, x => { ... }); // 迭代是值形式（into_iter）
```

元素也可以被**借用**，但只在一个地方：借用形式的 `for`。

```yo
for(&mut enemies, e => {
  e.hp = (e.hp - i32(1));
}); // struct 元素就地修改
for(&mut names, s => {
  s.push_str("!");
}); // String 元素：就地写入
for(&mut counts, c => {
  bump(c);
}); // 把元素交给 &mut 参数
for(&mut scores, (k, v) => {
  v = (v + i32(10));
}); // map：键只读、值被借用
```

借用形式的 `for` 降级为基于借用迭代器的值形式：`for(&mut coll, x => body)` 即
`for((&mut coll).into_iter(), …)`，`for(&coll, x => body)` 则是同样的循环，作用于
`(&coll).into_iter()`（`plans/backlog/REFERENCES_AND_ORIGINS.md` R-FOR）。
`into_iter` 是 `&C` / `&mut C` 的 `IntoIterator` 实现：它返回一个游标
（`ArrayListCursor(T, p)`、`HashMapCursor(K, V, p)` 等），游标持有对 `coll` 的借出，
并把每个元素作为以被借出位置为根的引用绑定 `&(T, p)` / `&mut(T, p)` 交出。循环不会
复制集合。由于游标在整个循环期间持有该借出，循环体完全不能再提到 `coll`：
`coll.push(x)` 是编译错误，`coll.len()`、`coll.clone()` 或对 `coll` 的嵌套
循环同样是（E0911，即任何 `&mut` 局部借用的规则，也是 Rust 对 `iter_mut` 的
规则）。元素本身是引用绑定，因此不能被返回（先复制出来：`v := x.*; return(v)`），
也不能被逃逸闭包捕获。若要在遍历时读取或扩充集合，请改为遍历它的位置：
`for(xs.indices(), i => …)` 配合 `xs(i)`（`ArrayList`、`Deque`），每次 `xs(i)`
都读取当前的缓冲区。

**只读遍历** `for(&coll, x => body)` 是同一个循环，作用于 `&coll`：每个元素是 `&`
引用，因此既不复制集合也不复制元素（`String` 元素不会被 dup），经由 `x` 写入是
E0908。`&` 借用只冻结它的位置，所以循环体可以读取 `coll`（`coll.len()`、嵌套的
`for(&coll, …)`），但不能写入它（E0911）。map 使用 `for(&m, (k, v) => …)`：元素类型是
`(&(K, p), &(V, p))`（`&mut` 下为 `(&(K, p), &mut(V, p))`），所以两种形式里键都是只读的。

```yo
for(&enemies, e => {
  total = (total + e.hp);
}); // 原地读取，不复制
for(&scores, (k, v) => {
  seen = (seen + v.*);
}); // map：键和值都只读借用
```

经由 `Rc` 句柄触及的来源要借出句柄的载荷：写成 `for(&xs.*, …)`（Rust 的 `&*rc`），
`(&xs).into_iter()` 不会自动解引用到载荷。每个 std 集合都为 `&C` 实现了
`IntoIterator`（`ArrayList`、`Deque`、`HashMap`、`HashSet`、`BTreeMap`、`OrderedMap`、
`PriorityQueue`）；可原地写入的来源还为 `&mut C` 实现了它（`ArrayList`、`Deque`、
`HashMap`、`BTreeMap`、`OrderedMap`）。`HashSet` 与 `PriorityQueue` 只有只读遍历，
因为原地改写一个按哈希或堆序存放的元素会破坏容器，所以 `for(&mut set, …)` 是一个
点名缺失实现的错误。用户类型为 `&C`（原地遍历还要为 `&mut C`）实现 `IntoIterator`，
并提供一个持有 `&(C, p)` 的游标结构体即可成为来源；交出 `&mut(T, p)` 的游标通过裸缓冲区
指针取元素，需要 `pragma(Pragma.AllowUnsafe)`。`String` 没有遍历（请遍历
`s.chars()`），`Array(T, N)` 请使用值形式或索引循环。不是位置的来源
（`for(&mut make(), x => …)`）由一个隐藏局部在循环期间持有。借用形式的 `for` 在
`io.async` 体内同样可用，循环体里也可以 await。

值集合没有"第二个句柄"：origin 冻结拥有它的那一个位置，所以循环不需要运行时标志。
`mut` 模块级绑定没有这样的位置（任何函数都能按名字写它），因此遍历它在循环处就是
E0911。

安全代码不能*持有*原始指针值 —— 指针迭代器（`xs.iter()`）的 `it.next()` 交出
`Option(*(T))`，在没有 `pragma(Pragma.AllowUnsafe)` 的文件中是错误（标准库作为经审计的
可信基础除外），因此借用形式的 `for` 是安全代码借用元素的唯一途径（`count`、`map`
等不暴露指针的迭代器组合子仍然可用）。

`project` 与 `Indexable` 已不存在。`str` 仍然是永生的静态字节视图（自由
复制、无约束），区间索引**拷贝**（`arr(a..b)` 返回新 `ArrayList`），所以
修改源永远不会影响结果。

## 一条调用点规则

**同一次调用不得把同一个对象同时作为 `&mut` 扎根的实参和 `sink` 实参传入**
（`use_and_sink(h.s, h)` 配 `sink(victim)` 会被拒绝）—— `sink` 把调用者
的引用计数移交给被调用者，而后者可能在借用仍被使用时释放它。不同对象
没有问题。与 `&mut` 实参重叠的按值实参会在调用期间保持存活：被调用者可能替换
`&mut` 变量的值，从而释放按值实参所借用的值（`fn(a : &mut S, b : S)` 的
`clobber(x, x)`），因此该实参在调用返回前持有一个由调用者拥有的 `+1`，
与重叠的字段投影相同。借用的句柄本身永远无法释放调用者的计数（把它转交给
`sink` 位置会先 dup）。

实参按顺序求值，某个实参借出的位置（`&x`、`&mut x`、`&mut x.f`、
`&self`/`&mut self` 方法的接收者，或被运算符借用的操作数，如 `a == b` 中的
`a`）从该实参求值的那一刻起被借用，直到调用返回。**后续实参不得移动该位置、
给它赋值或以 `&mut` 再借出它**（E0910），无论代码是直接写出、位于嵌套调用中
还是位于代码块中：

- 在 `sync(&mut a, eat(a))` 和 `a == make(eat(a))` 中，`eat` 已把 `a` 移出并
  drop，被调用者却仍会读取 `a`；
- 在 `peek(&p.s, { p = q; k })` 和 `peek(&p.s, reset(&mut p))` 中，后续实参
  替换 `p` 并 drop 旧的 `p.s` 时，`&p.s` 已经被读取，被调用者会读到已释放的
  内存。

后续实参读取该位置是允许的（`xs.push(xs.len())`、`f(&mut a, a.len())`），
以 `&` 借用某个先前实参以 `&` 借出的位置也允许（`peek(&a, peek(&a, k))`），
写入与被借出位置不重叠的字段同样允许（`peek(&p.s, { p.k = 3; k })`）。这就是
Rust 的两阶段借用规则。请移动一份副本（`eat(a.clone())`），或在调用之前先算好
后续实参（`k := reset(&mut p); peek(&p.s, k)`）。产生借用型 Future 的调用遵循
同一规则，只是它的借用一直持续到 Future 被 await（[ASYNC_AWAIT.md](./ASYNC_AWAIT.md)）。

**同一调用借出的两个位置，若其中一个以 `&mut` 借出且两者都以同一个值局部变量为根，
就不得重叠**（决策 28 的值根规则，E0910），先后顺序不限：`s.push_string(&s)`
（接收者以 `&mut` 借出）、`sync_peek(&mut a, &a)`、`f(&mut p, &p.name)` 与
`f(&mut p.name, &p)` 都会被拒绝，因为被调用方会在通过另一个实参读取该位置的同时
写入它。两个 `&` 借出可以重叠，互不重叠的字段也可以（`f(&mut p.s, &p.k)`）。以引用
单元（`Rc`、`Arc`、`ref` 对象，以及在成为值之前的集合）为根的位置不是值根：其他
句柄本来就能到达该单元。请先复制其中一方（`t := s.clone(); s.push_string(&t)`）。

没有了局部绑定，就没有任何东西可"失效"：旧的借用失效门已随绑定形式
一并删除。`get` 返回的元素句柄在任何容器操作之后都有效 —— 即使容器被
重新赋值 —— 因为句柄对元素对象持有 +1。

## 逃逸通道

`pragma(Pragma.AllowUnsafe);` 豁免整个文件（标准库经过审计的内部实现使
用它）；`unsafe(expr)` 标记单个表达式。裸指针 `Index` 实现
（`index : … -> *(T)`）是热循环确有测量需求时受支持的零拷贝逃逸通道。
参见 [MEMORY_SAFETY.md](./MEMORY_SAFETY.md)。

## 测试

`tests/ref_binding.test.yo`、`tests/ref_local_binding.test.yo`、
`tests/ref_params.test.yo`、`tests/ref_field_borrow.test.yo`（含所有者
pin 与 ref/own 调用门）、`tests/ref_borrow_invalidation.test.yo`（门矩
阵 + get 句柄模型）、`tests/ref_return_ban.test.yo`、以及
`tests/flowability_comprehensive.test.yo`。
