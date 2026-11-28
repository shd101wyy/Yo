# 函数

函数的声明与调用：参数模式与引用、命名参数与默认参数、`never`、泛型与约束、偏应用、
类型方法以及 `recur`。闭包见 [CLOSURES.md](./CLOSURES.md)，trait 见
[TRAITS.md](./TRAITS.md#定义与实现-trait)；调用对所有权的影响见
[OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md)。

## 函数声明

函数使用 `::` 运算符进行编译期定义，或使用 `:=` 作为运行时值。

模块级的 `::` 定义、`impl(...)` 注册与 `derive(T, ...)` 语句与顺序无关：函数可以调用文件中稍后定义的函数、以自己的名字递归、或使用 `impl` 或 `derive` 位于其下方的方法。import、`open`、pragma 与运行期全局变量仍保持源码顺序。参见[定义顺序](./MODULES.md#定义顺序)。

```yo
// 带显式类型的函数声明
// 函数类型写作 fn(args...) -> return_type
add :: (fn(x : i32, y : i32) -> i32)(
  x + y // 函数体
);
// 用函数体调用函数类型可以创建一个函数值
// 或者先定义类型，再实现
comptime(add) : (fn(x : i32, y : i32) -> i32);
add = _(x + y); // 这里的 `_` 从 `add` 推断函数类型
// 或者用匿名函数定义函数体
add = ((a, b) -> (a + b)); // 类型从用法推断。可以使用不同的参数名
// 带显式返回类型
multiply :: (fn(x : i32, y : i32) -> i32)({
  return(x * y); // 显式返回
});

// 最后一个表达式即为返回值
divide :: (fn(x : i32, y : i32) -> i32)(x / y);

// 函数可以接受 `comptime` 参数并返回 `comptime` 值，如 Type：
Point :: (fn(comptime(T) : Type) -> comptime(Type))({
  return(
    struct(
      x : T,
      y : T
    )
  );
});
I32Point :: Point(i32);
BoolPoint :: Point(bool);

p1 := I32Point(x : 3, y : 4);
p2 := BoolPoint(x : true, y : false);
```

## 参数模式是函数类型的一部分

`fn(x : &mut i32) -> unit`、`fn(x : &String) -> usize` 和 `fn(x : String) -> usize` 是三个不同的类型：`&mut T` 参数是对调用方位置的独占借用，`&T` 参数是只读（共享）借用，普通参数是**按值**传递。`Copy` 类型的按值参数得到一份副本；显式复制类型（只能移动的值、没有 `Copy` 的纯数据，或 `Rc`/`Arc` 句柄）的按值参数会消耗其实参，调用方的绑定在调用处结束。`sink(x)` 参数，以及闭包或函数实参，总是移动。无论参数类型是否为 `Copy`，模式都是类型的一部分，所以 `fn(x : &i32)` 与 `fn(x : i32)` 也不同。函数值只能放进参数模式相同（隐式 `using(...)` 参数也相同）的位置，无论它经由哪条路径到达：绑定到带类型的名字、作为实参传给 `fn(...)` 或 `Impl(Fn(...))` 参数、存入字段、作为返回值，或由 `dyn(...)` 包装成 `Dyn(Fn(...))`。闭包字面量采用它所在位置的参数模式：

```yo
bump :: (fn(x : &mut i32) -> unit)({
  x.* = (x.* + i32(1));
});
(f : (fn(x : &mut i32) -> unit)) = bump; // 可以
(g : (fn(x : i32) -> unit)) = bump; // 错误：Incompatible types
```

唯一的例外是 `impl` 成员的接收者：trait 中声明为 `self : &mut Self` 的方法可以用 `self : Self` 实现，因为每个调用点都会按 impl 自己的签名适配。

`&T` 与 `&mut T` 是位置所写的借用**模式**：它们加在参数、接收者（`self : &Self`、`self : &mut Self`）、闭包参数（`(v : &T) => ...`）或带标签的 `Fn` 位置（`Fn(v : &T) -> R`；不接受无标签的 `Fn(&T)`）的类型之前。在类型单独出现的任何地方（`T :: &i32`、`ArrayList(&T)`、`Option(&T)`、结构体字段 `f : &T`），借用符号构成**引用类型**（见下文“引用类型”）；`&&T` 是指向引用的引用：对引用绑定 `r` 写 `&r` 借出的是 `r` 本身（`&&T`；对 `mut(r)` 绑定写 `&mut r` 得到 `&mut &T`），因此参数 `a : &mut &(T, p)` 可以让调用者的引用改指向别处。没有任何转换会把 `&&T` 变成 `&T`：对所指值的再借用写作 `&r.*`，方法调用经由 `(&r).m()` 与 `rr.*.m()`（方法探测的解引用步骤）找到所指值的方法；对 `&&T` 绑定直接写 `rr.m()` 不会被解析。借用结果（`-> &T` / `-> &mut T`）是投影：函数体产出用结果符号书写、以借用参数为根的位置，并通过下标（`x(i)`）到达（[TRAITS.md](./TRAITS.md#投影)）。

**Origin**。参数的引用可以写出它的 **origin**，即它可能指向的位置集合：`x : &(T, p)` 与 `x : &mut(T, p)`，其中 `p` 在签名的 `generic(...)` 子句中以种类 `Origin` 声明，就像类型参数以 `Type` 声明一样。多个已声明 origin 的并集写成元组：`&(T, (p, q))`。空 origin 写作 `static`：任何文件都可以写出它，并且它会被检查（E0923）：只有不借用任何位置的值（字面量、对 `static` 类型位置的读取、不可变模块级绑定的 `&G`）才能流入它。第二个参数按其种类解读，必须是 origin：那里出现类型是未编码的错误（Yo 把元组类型写作 `Tuple(A, B)`，所以指向元组的引用是 `&Tuple(A, B)`），未被任何 `generic(p : Origin)` 声明的名字或另一个参数的名字也是如此。origin 参数不是类型参数，所以只对 origin 抽象的函数不是泛型函数，只编译一次。投影的结果类型也可以写出 origin：`-> &(T, p)` 借自 origin 参数，`-> &(T, xs)` 借自引用参数 `xs`，`-> &(T, (p, xs))` 借自两者之一。方法的结果可以写出它所在 impl 的 origin 参数，就像 Rust 的 `Entry<'a, K, V>::or_insert(self) -> &'a mut V`：对 `impl(generic(p : Origin), H(p), get : (fn(self : &Self) -> &(i32, p))(…))`，调用通过匹配接收者的类型绑定 `p`，所以对 `h : H(x)` 调用 `h.get()` 借自 `x`，可以比 `h` 活得更久，并在存活期间冻结 `x`；没有任何参数的类型写出的名字（调用无法绑定它）是未编码的错误。按值参数的位置属于被调函数自己的栈帧，所以对 `v : T` 写 `-> &(T, v)` 是错误 E0912。结果的 origin 会被检查。一次调用只冻结结果 origin 指名的那些实参：`pick` 返回 `-> &(T, a)` 时，`r := pick(&a, &b)` 之后只要 `r` 还活着，`b` 仍然可写；省略的结果 origin 指名每个引用参数，所以省略 origin 的调用发生冲突时，诊断会附带一条说明，指出是哪个参数以及能释放它的写法。函数体产出的位置必须从 origin 指名的参数出发到达：从另一个参数出发是错误 E0923，从局部绑定或按值参数出发是 E0912。impl 的结果 origin 必须包含在它的 trait 方法的结果 origin 之内，引用结果如此，携带 origin 的按值结果（如 `-> Option(&(T, self))`）也如此（更窄可以接受；更宽，或在 trait 写出 origin 时省略，是 E0923），`Dyn` 调用按 trait 的签名映射结果 origin。origin 不属于类型的身份，唯一的例外是它是否为空 `static` 这一位：`Option(&(X, static))` 与 `Option(&X)` 是两个实例，具名 origin 仍然擦除。因此 `fn(generic(p : Origin), v : &(i32, p)) -> i32` 与 `fn(v : &i32) -> i32` 是同一个函数类型，生成的 C 也相同；`-> &(T, xs)` 与 `-> &T` 亦然。闭包 trait 可以返回引用，`Fn(s : &T) -> &U`（它的 origin 按调用计算，即该次调用的引用实参，从不写出）：具名投影，或函数体产出从自身参数出发到达的 `&place` 的闭包字面量，可以填入这个槽位；产出它所捕获位置的闭包是错误 E0923。投影可以通过任何投影类型的值调用：`fn(...) -> &T` 类型的参数或字段、`Impl(Fn(...) -> &T)`、`Dyn(Fn(...) -> &T)`，以及效应操作 `ctl(...) -> &T`，其处理器以自身参数的位置恢复。引用的被指类型（`&mut &(T, p)`）、局部绑定的标注和闭包 trait 的结果不写 origin。`Origin` 与 `Type` 一样是保留的类型名。

**引用类型**。在槽位之外，`&T`、`&mut T`、`&(T, o)` 与 `&mut(T, o)` 表示引用类型：结构体或枚举的字段（`struct(at : &(i32, p), lo : usize)`）、类型实参（`Option(&i32)`、`ArrayList(&(i32, (x, y)))`）或别名（`R :: &i32`）。类型构造器用 `comptime(p) : Origin` 声明 origin 参数，并应用于一个按名字解读的 origin，`View(x)`：绑定的位置（局部绑定、参数、模块级绑定）、作用域中的 origin 参数，或并集 `(x, y)`。不写 origin 的字段 `&T` 得到它自己的新 origin。类型不能把自己的字段当作 origin（`next : &(i32, self.value)` 是错误 E0924）：值内部的每个引用都指向外部，因此移动值不会使引用悬空。origin 不属于类型的身份：`View(x)` 与 `View(y)`、`Option(&(i32, x))` 与 `Option(&(i32, y))` 是同一个类型、同一个 C 结构体。不接受 origin 的位置以错误 E0909 拒绝带 origin 的类型：`extern` 签名（FFI 使用裸指针）和模块级绑定。引用类型之上的**内联复合类型**——值语义的结构体或枚举（包括无字段变体 `Option(&mut i32).None`）、元组、数组——可以构造并按值传递。构造调用借用每个引用字段的位置（`at : &x`、`at : &mut x`），绑定冻结被借用的根（E0911）；返回 origin 指向本函数局部量的值是 E0912。`&T` 字段是 `Copy`（拷贝共享其指针），`&mut T` 字段使持有者只能移动，除非其类型声明 `derive(..., Copy, Clone)`；C 将引用字段_lowering_ 为 `const T*` / `T*`。绑定引用载荷的 `match` 分支（在 `Option(&T)` 或 `Option(&Dyn(Trait))` 上的 `.Some(r)`）把 `r` 绑定为引用，与 `r := &x` 相同。`r.f`、`r.m()` 与 `r.*` 经由它读取，`f(r)` 把它直接借给 `&T` 参数，而通过 `&` 载荷写入是 E0908。`r` 存活期间，被匹配值中的引用所指向的位置被冻结（E0911）。结果类型携带 origin 的函数，其 `&T` 参数按指针传递，与投影相同，因此由该参数构造的 `.Some(r)` 指向调用者的位置。`match(&x, …)` 的绑定同样是指向 `x` 所在位置的引用，因此作为 `Option(&T)` 返回的 `match(&h.v, .Some(s) => .Some(s), .None => .None)` 指向 `h` 内部。引用类型的字段用 `.*` 读取（`h.f.*`），用一次存储让它重新指向：`h.f = &y` 存入一次借出，`h.f = r` 存入引用 `r`，这次存储按整个持有者的存储 `h = H(f : &y, …)` 检查（持有者需要 `mut(h)` 或一条 `&mut` 路径；`h` 以及经由 `h.f` 到达的位置都不能有存活的借用；持有者保留原先持有的，并且现在也持有 `y`，`y` 必须比它活得久，E0911；字段声明的 origin 必须包含 `y` 的，E0923）。`v` 是值时 `h.f = v` 是 E0926：字段所指向的位置经由 `&mut` 字段用 `h.f.* = v` 写入。对 `&` 字段写 `&mut h.f` 借出字段本身，即 `&mut &(T, p)`，于是被调用方可以让它重新指向。容器或单元（`ArrayList(&T)`、`Rc`、`RefCell`）内部的引用是错误。

**`Escapable` 与经由句柄的借用**。prelude 的标记 trait `Escapable` 对不携带 origin 的类型成立：引用、任何持有引用的类型、带借用捕获的闭包以及借用的 future 都不是 `Escapable`；其他所有类型都是。它像 `Send` 一样由类型的结构推导，从不手写实现（`impl(T, Escapable())` 是错误）。泛型函数用 `where(T <: Escapable)` 声明它，把 `T` 绑定为带 origin 的类型的调用在该调用处报错误 E0909。`Rc(V)` 与 `Arc(V)` 只接受 `Escapable` 的载荷，因此对持有引用的 `v` 调用 `Rc.new(v)` 以同样的消息报 E0909：计数单元的载荷在最后一个句柄消失时才释放，那个时刻无法与任何借用对照检查。共享借用可以穿过句柄的解引用：`r := &h.*.x` 与捕获 `{ x : &h.*.x }` 借用载荷，以句柄的位置为 origin，因此借用存活期间 `h` 被冻结（丢弃、移动或重新赋值它是 E0911；另一个句柄的丢弃没有问题，因为被冻结的 `h` 仍持有载荷）。经由句柄的载荷是只读的，所以 `&mut h.*.x` 仍是错误 E0919。

**用 `.*` 读引用**。引用绑定（`&T` 或 `&mut T` 参数、局部借用 `y := &place`、捕获列表中的借用、`for(&xs, x => …)` 的元素、`match(&x, …)` 或 `match(&mut x, …)` 的绑定）用 `.*` 读写它所引用的值：`n : &i32` 时写 `n.* + 1`，`r : &mut T` 时写 `r.* = v`，`x := r.*`（复制，与 `t := s` 的复制相同）。把裸名字当作整个值使用是错误 E0926：运算数（`n + 1`；运算符从不自动解引用）、按值传递的实参、初始化式、返回值、写入 `r = v`，以及借用 `&r`（应写作 `&r.*`，即被引用的值）。裸名字的四种用法不是整值读取，保持原样：接收者经由引用读取（`r.field`、`r.method()`、`r(i)`）；把名字传给引用参数（`f(r)` 传递 `r` 所借用的）；重新指向 `r = &place`；以及 `match(r, …)` 的被匹配值，它经由引用匹配，因此其绑定借用被引用值的载荷（经由 `&mut` 引用时还能写入）。对引用写 `match(&r, …)` 是 E0926，因为这个标记是多余的；`match(r.*, …)` 匹配被引用值的一份副本。对指向 `Box`、`Rc` 或指针的引用，`r.*` 是引用自身的解引用，`r.*.*` 才是载荷。该规则适用于所有文件，包括标准库和获取的依赖。

```yo
first :: (fn(generic(p : Origin), v : &(i32, p)) -> i32)(v.*);
sum :: (fn(generic(p : Origin, q : Origin), a : &(i32, (p, q)), b : &(i32, q)) -> i32)(a.* + b.*);
Pair :: struct(a : i32, b : i32);
first_of :: (fn(generic(p : Origin), s : &(Pair, p)) -> &(i32, p))(&s.a);
second_of :: (fn(s : &mut Pair) -> &mut(i32, s))(&mut s.b);
```

**引用上的 impl**。impl 的接收者可以是引用：`impl(&C, Tr(...))`、`impl(&mut C, Tr(...))`、`impl(generic(p : Origin), &(C, p), Tr(...))`，或通用实现 `impl(generic(T), where(T <: Tr), &T, Tr(...))`。其中 `Self` 就是该引用，所以 `self : Self` 以 `&C` 接收接收者。`impl(C, Tr)`、`impl(&C, Tr)` 与 `impl(&mut C, Tr)` 是三个不同的接收者；origin 不属于接收者，因此 `impl(&(C, p), Tr)` 与 `impl(&C, Tr)` 并存是错误 E0612，裸类型变量的通用实现 `impl(generic(T), T, Tr)` 与二者之一并存也是（它同样覆盖 `&C`）。方法调用按**接收者槽位类型**解析：方法的槽位是其第一个参数代入 `Self` 后的类型（`impl(&C, …)` 上的 `self : Self` 与 `impl(C, …)` 上的 `self : &Self` 槽位都是 `&C`）。对类型为 `R` 的接收者，探测依次尝试 `R`，然后 `&R` 与 `&mut R`，再对 `R` 解引用一次并尝试其借用，第一个有方法适用的步骤胜出；同一步骤中固有方法优先于 trait 方法，同一步骤中两个 trait 方法是错误 E0616，其消息列出每个 impl 以及它们共享的槽位。因此拥有所有权的 `c` 优先采用 `C` 上按值的 `self`（`xs.into_iter()` 消耗它），只有没有按值方法时才借用；`(&c).m()` 与 `(&mut c).m()` 是显式借用，探测从 `&C` 开始（`(&xs).into_iter()` 借用）。显式借用绝不会把值从 `c` 中移出（对非 `Copy` 类型按值的 `self` 是 E0901），`(&c)` 也到达不了 `&mut Self` 方法（E0908）。引用接收者上找不到方法时，消息列出探测过的槽位类型。接收者槽位 `&&C`（`impl(&C, …)` 上的 `self : &Self`，接收 `&Self` 的 trait 会强制出现）被接受：引用绑定 `r : &C` 作为接收者时借出自身的存储，与 `(&r).m()` 相同；自有的值、调用结果或显式的 `(&c)` 没有可借出的存储，调用报错并提示先把引用绑定到局部变量。类型为引用 `&U` 的接收者（绑定、字段、调用结果、`rr.*`）首先探测槽位 `&U`：`impl(U, …)` 中 `self : &Self` 的方法与 `impl(&U, …)` 中 `self : Self` 的方法占据这个槽位，引用本身就是实参。只有没有任何方法占据该槽位时，探测才会到达 `&&U`：引用绑定借出自身的存储来填充它，其他接收者则不能（E0610）。引用上的 impl（包括 `&T` 上的通用实现）绝不会遮蔽被指类型自身的方法。中缀运算符按同一规则选择：作为引用绑定的操作数以其引用类型参与选择，所以 `ra, rb : &C` 上的 `ra == rb` 是 `&C` 上的 impl（Rust 的 `impl PartialEq<&B> for &A`），其 `lhs : &Self` 与 `rhs : &Rhs` 槽位由两个绑定自身的存储填充；它绝不是解引用。没有 `&C` 上的 impl 接受这些操作数时（`c : C` 时的 `ra == c`、`ra + 1`，或 `C` 没有这样的 impl），该操作数是整值读取，E0926 要求写 `ra.*`。prelude 为每个具有 `Eq(T)` / `Ord(T)` 的定长 `T` 提供 `Eq(&T)` 与 `Ord(&T)`（Rust 的 `impl PartialEq<&B> for &A`）：两个引用按其所指的值比较与排序，因此 `ra == rb`、`ra < rb` 以及 `T := &U` 处的泛型代码（`max`、约束 `where(T <: Ord(T))`）都可用；与之并存的用户 `impl(&C, Eq(&C))` 是 E0612。prelude 还为每个具有 `Hash(T)` 的定长 `T` 提供 `Hash(&T)`，`std/fmt` 为每个具有 `Display(T)` / `Debug(T)` 的定长 `T` 提供 `Display(&T)` 与 `Debug(&T)`：引用的哈希与渲染就是其引用物的哈希与渲染；与之并存的用户 `impl(&C, Hash(&C))` 是 E0612。

运算符 trait 也以同样方式写出操作数的模式，每个 impl 都必须完全照写这些模式。比较 trait `Eq` 与 `Ord` 借用操作数，即 `(==) : (fn(lhs : &Self, rhs : &Rhs) -> bool)`，因此 `a == b` 之后两个操作数都仍可使用。算术、位运算与一元 trait（`Add` 到 `Shr`、`Neg`、`LogicalNot`、`BitNot` 及其 `Comptime*` 对应版本）与 Rust 一样按值接收操作数：`(+) : (fn(lhs : Self, rhs : Rhs) -> Self.Output)`。按值操作数遵循上面的参数规则：`Copy` 操作数被复制，`String` 被共享，仅可移动的操作数被移动进运算符。trait 按值接收而 impl 借用的操作数（反之亦然）会以 "as written" 被拒绝。`Dyn` 没有可交给按值操作数的值，所以方法按值接收 `self` 的 trait（`LogicalNot`、`Neg`、`Add` 等）无论载荷是什么都不能放到 `Dyn` 后面（E0614）。

```yo
Money :: struct(cents : i64);
derive(Money, Copy, Clone);
impl(Money, Add(Money)(Output : Money, (+) : (fn(lhs : Self, rhs : Self) -> Self.Output)(Money(cents : (lhs.cents + rhs.cents)))));
impl(Money, Eq(Money)((==) : (fn(lhs : &Self, rhs : &Self) -> bool)(lhs.cents == rhs.cents)));
```

## 调用处的借用标记

被借出的实参在调用处也要标记，这样 `show(&s)`（借用）与 `take(s)`（移动）读起来就不一样：`&x` 把 `x` 借给 `&T` 参数，`&mut x` 把位置 `x` 借给 `&mut T` 参数。方法接收者直接书写（`s.len()`），继续传递的借用参数或局部借用也直接书写（它本身已持有借用）。

```yo
swap(&mut x, &mut y);
show(&s); // s 仍可使用
take(s); // 被移动
```

`&x` 只有这一种含义。类型由类型绑定变量给出的按值参数也接受它，并且该绑定变量就是这个引用：对于 `id :: (fn(generic(T : Type), v : T) -> T)(v)`，`id(&x)` 使 `T` 为 `&X`，借出 `x`，并返回一个借用 `x` 的引用，与 `r := &x; id(r)` 完全相同。传给其他按值参数，或者传给已被另一个实参确定为值类型的绑定变量时，`&x` 会报错并给出 `x` 和 `x.clone()`；传给裸指针参数，或写在其他任何位置（字段写入、接收者 `(&x).m()`、C 可变参数），会报错并给出 `addr_of(x)`，即不安全代码中的裸指针取址。借用符号可以出现的其他位置是局部借用绑定（`y := &place`、`y := &mut place`，见 [OWNERSHIP_AND_BORROWING.md](./OWNERSHIP_AND_BORROWING.md#局部借用)）、捕获列表条目，以及借用式 `for` 的来源（`for(&mut xs, x => ...)`）。裸的具名位置传给 `&T` 或 `&mut T` 参数是 E0914，并给出 `&x` 或 `&mut x`，对所有代码生效，包括 std；临时值、字面量、闭包和运算符操作数不需要标记。

## 命名参数

Yo 中的命名参数必须按照函数签名中定义的顺序提供：

```yo
add :: (fn(x : i32, y : i32) -> i32)(x + y);

add(3, 4); // OK：位置参数
add(x : 3, y : 4); // OK：正确顺序的命名参数
add(3, y : 4); // OK：混合使用（先位置后命名）
add(y : 4, x : 3); // 错误：命名参数必须按顺序（x 在 y 之前）
```

## `never` 类型

`never` 是不会正常结束的表达式的类型：`__yo_panic(...)`，或调用一个声明为 `-> never` 的函数。它可以流入任何类型，因此一个发散的分支适配其他分支产生的任何类型；除 `never` 本身外，没有类型能流入 `never`：

```yo
die :: (fn(msg : str) -> never)(__yo_panic(msg));

pick :: (fn(flag : bool) -> i64)({
  x := cond(flag => i32(3), true => die("unreachable")); // x : i32
  i64(x)
});
```

函数体可能正常结束的 `-> never` 函数会被拒绝（`Function body has type unit, but the declared result type is never`）。

标准库的终止函数都是 `-> never`：`std/assert` 的 `panic`、`std/process` 的 `exit`，以及 libc 的 `exit`、`_Exit`、`quick_exit` 和 `abort`。因此 `.None => panic("no value")` 可以放在必须产生值的分支里。

## 默认参数值

默认参数值可以使用 `?=` 语法定义：

```yo
create_user :: (fn(name : String, (age : i32) ?= i32(18)) -> User)(
  User(name : name, age : age)
);

create_user(name : `Alice`); // 使用默认值：age=18
create_user(name : `Bob`, age : i32(30)); // 显式指定 age
```

默认值必须是**编译期已知的值**：编译器在函数定义处记录一次，每当调用省略该参数时就传入这个值。判断标准是整个值是否已知，而不是参数的类型是什么：

```yo ignore
(n : i32) ?= i32(18)                    // ✅ 字面量
(alloc : Option(Allocator)) ?= .None    // ✅ 无负载的变体：只有标签，是常量
(alloc : Allocator) ?= Allocator.global() // ❌ 含有全局变量的地址，链接时才确定
(x : i32) ?= seven()                    // ❌ 需要一次调用：在定义处报错 E1105
```

默认值中的名字在函数定义处解析，而不是在调用处：即使调用方有自己的 `K`，默认值 `K` 读到的也是定义模块的 `K`。

如果自然的默认值需要运行时计算，就把默认值设为 `.None`，在函数体里再决定。这样省略的参数读作“未提供”，而不是某个哨兵值：

```yo
greet :: (fn(name : str, (greeting : Option(String)) ?= .None) -> String)(
  match(
    greeting,
    .Some(g) => `${g}, ${name}`,
    .None => `Hello, ${name}`
  )
);

greet("Ada"); // "Hello, Ada"
greet("Ada", greeting : .Some(String.from("Hi"))); // "Hi, Ada"
```

调用方要显式写 `.Some(...)`：`T` 不会被自动包装成 `Option(T)`。

## 泛型函数

你可以使用 `generic` 来定义泛型函数：

```yo
identity :: (fn(generic(T : Type), arg : T) -> T)(arg);

x := identity(12); // 类型推断：x: i32
y := identity(true); // 类型推断：y: bool
```

泛型函数体在特化时做类型检查：每个实例化处，函数体的结果都必须与声明的返回类型一致
（`(fn(generic(T : Type), x : T) -> i32)(true)` 在第一次调用处报 E0604）。

在一次调用中，一个类型参数只代表**一个**类型，由调用的实参共同决定，与实参顺序无关：

```yo
pair_same :: (fn(generic(A : Type), x : A, y : A) -> A)(x);
pair_same(i32(3), i32(4)); // A = i32
pair_same(String.from("a"), i32(2)); // E0601：A 由实参 1 得到 String，由实参 2 得到 i32

apply :: (fn(generic(T : Type), f : Impl(Fn(x : T) -> T), v : T) -> T)(f(v));
apply(x => (x + i32(1)), i32(3)); // 4 —— 闭包在 `v` 确定 T = i32 之后才检查
apply(x => true, i32(3)); // E0604：闭包体是 bool，而 T 是 i32
```

闭包（`=>`）或函数字面量（`->`）实参最后检查，对照的是其他实参已经解出的参数类型。只出现在结果中的类型参数由期望类型确定；没有期望类型时报 E0613：

```yo
mk :: (fn(generic(T : Type)) -> Option(T))(.None);
(x : Option(i32)) = mk(); // 由类型标注得到 T = i32
y := mk(generic(bool)); // 显式给出 T = bool
z := mk(); // E0613：无法推断 T
```

`comptime(x) : T` 参数按其**值**特化，因此实参必须在编译期已知——字面量、`::` 常量或 comptime 函数的结果。
运行时值是错误：

```yo
scale :: (fn(comptime(factor) : i32, x : i32) -> i32)(factor * x);
scale(3, n); // 正确
scale(i32.default(), n); // error[E1101]: Parameter `factor` is `comptime` and requires a compile-time argument
```

## 类型约束

你可以使用 `where` 子句在泛型参数上添加类型约束：

```yo
add :: (fn(generic(T : Type), x : T, y : T, where(T <: Add(T))) -> T)(x + y);
```

`where` 子句可以指定多个约束：

```yo
compare_and_add :: (
  fn(
    generic(T : Type),
    x : T,
    y : T,
    z : T,
    where(T <: (Add(T), Eq(T)))
  ) -> T
)(
  cond(
    (x == y) => (x + z),
    true => (y + z)
  )
);
```

约束中的关联类型绑定会绑定泛型参数：下面的 `A` 由实参的 `Iterator` impl 确定，函数体可以使用它，
也可以在该参数上调用 blanket 组合子（`fold`、`map`、`collect` 等）。约束可以提到它所约束的参数本身
（`A <: Add(A)`），这个约束会在 `A` 绑定之后检查：

```yo
sum :: (fn(generic(I : Type, A : Type), it : I, zero : A, where(I <: Iterator(Item := A), A <: Add(A))) -> A)(
  it.fold(zero, (acc, x) => (acc + x))
);
total := sum(list.into_iter(), i32(0)); // A = i32
```

只由 `Fn` 约束的结果确定的参数（`where(F <: (Fn(item : A) -> J))` 中的 `J`）从闭包实参的函数体类型绑定。
关联类型不匹配时，错误会指出是哪一个：`Type ArrayListIter(String) does not implement required trait
Iterator: its associated type Item is String, not i32.`

## 使用 `_` 进行偏应用（Partial Application）

多参数类型构造器可以使用 `_` 作为占位符进行偏应用。这会创建一个参数更少的新类型构造器：

```yo
// Result 的 kind 是：(Type, Type) -> Type
// 偏应用固定一个参数：
IntResult :: Result(_, i32); // kind: Type -> Type
StrOkResult :: Result(str, _); // kind: Type -> Type
// 像任何类型构造器一样使用：
(r : IntResult(bool)) = .Ok(true); // = Result(bool, i32)
(r2 : StrOkResult(i32)) = .Err(i32(404)); // = Result(str, i32)
```

偏应用**仅**适用于编译期函数（返回类型为 `comptime` 的函数），不能用于运行时函数。

```yo
// 类型构造器（返回 comptime(Type)）：
IntResult :: Result(_, i32); // kind: Type -> Type
// 编译期值函数（返回 comptime(i32)、comptime(bool) 等）：
add :: (fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32))(x + y);
add1 :: add(i32(1), _); // fn(comptime(y) : i32) -> comptime(i32)
result :: add1(i32(2)); // 3
```

偏应用的类型构造器可以作为 HKT generic 参数使用：

```yo
IntResult :: Result(_, i32);
// IntResult 的 kind 是 Type -> Type，所以可以传递给 F : (Type -> Type)
```

## 类型方法

Yo 支持**类型方法** —— 在类型 trait 中定义的方法。

**方法调用仅适用于：**

1. 在类型自身 trait 中定义的方法
2. 来自已实现 trait 的方法

```yo
// 定义一个带方法的类型
Point :: struct(
  x : i32,
  y : i32
);
impl(
  Point,
  // 类型方法在结构体 trait 中定义
  distance_from_origin : (fn(self : Self) -> f64)(
    f64(
      sqrt(
        (self.x * self.x) +
          (self.y * self.y)
      )
    )
  ),
  move_by : (fn(self : &mut Self, dx : i32, dy : i32) -> unit)({
    self.x = (self.x + dx);
    self.y = (self.y + dy);
  })
);

p := Point(x : 3, y : 4);
d := p.distance_from_origin(); // 类型方法调用 - OK
p2 := Point(x : 0, y : 0);
p2.move_by(5, 10); // `self : &mut Self` 在 C 中降为 `Self*` — 编译器自动取接收者的地址
// p2 现在是 Point(5, 10)
```

**`&mut` 的自动指针转换：**

`name : &mut T` 参数在 C 中降为 `T*`。编译器自己传递被借出位置的地址，
所以接收者直接书写，实参用 `&mut x` 借出：

```yo
Point :: struct(x : i32, y : i32);
impl(
  Point,
  set_x : (fn(self : &mut Self, new_x : i32) -> unit)({
    self.x = new_x;
  })
);

p := Point(x : 3, y : 4);
p.set_x(10); // 无需写 `addr_of(p)` — 编译器自动插入
```

### 通过类型调用方法

方法也可以在它的类型上调用，此时接收者作为第一个实参：`Point.distance_from_origin(p)` 就是 `p.distance_from_origin()`。泛型类型也可以这样调用，既可以写出类型实参（`Rc(i32).clone(b)`），也可以省略（`Rc.clone(b)`）。省略时，类型实参从第一个实参推断，而它本身必须是该类型构造器的一个实例，就像 Rust 推断 `Rc::clone(&w)` 的 `T` 一样。这对任何泛型 struct 或 enum 都适用，不限于 prelude 的包装类型。

静态方法（第一个参数不是 `Self` 的方法）则从它的实参推断：凡是参数的声明类型提到了 impl 的类型参数的实参，都会绑定它们，所以 `Pair.make(i32(1), true)` 就是 `Pair(i32, bool).make(i32(1), true)`，`Rc.new(x)` 就是 `Rc(X).new(x)`。嵌套也可以（参数 `xs : ArrayList(T)` 收到 `ArrayList(String)` 时绑定 `T := String`），字面量绑定它的默认类型（`Rc.new(42)` 是 `Rc(i32)`）。闭包字面量、枚举简写 `.X`、`dyn(...)` 值和取默认值的实参不绑定任何东西，调用结果被期望的类型也从不提供它们：`Rc.new(.None)`、没有实参的调用（`ArrayList.new()`）以及没有实参提到的类型参数都会报 E0613，其帮助信息是写出类型实参（`Rc(Option(i32)).new(.None)`）。两个实参把同一个参数绑定到不同类型会报 E0601，实参同时适配两个 impl 会报有歧义的 E0613。对于第一个参数是 `Self` 的方法（`self : &Self`、`lhs : &Self`），第一个实参不是该构造器的实例会报 E0613，错误信息会给出该实参的类型。

接收者可以像其他实参一样带标签（`Pair.first(self : p)`），构造器也可以带模块限定（`m.Pair.first(p)`）。匹配依据的是构造器的身份，所以函数体应用了另一个构造器的构造器是一个独立的构造器：对于别名 `IntPair :: (fn(comptime(B) : Type) -> comptime(Type))(Pair(i32, B))` 或偏应用 `Pair(i32, _)`，以 `IntPair(u8)` 构造的值是 `Pair(i32, u8)`，`Pair.first(q)` 和 `IntPair(u8).first(q)` 都接受它，而 `IntPair.first(q)` 会报 E0613。

```yo
Pair :: (fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(a : A, b : B)
);
impl(
  generic(A : Type, B : Type),
  Pair(A, B),
  first : (fn(self : Self) -> A)(self.a),
  make : (fn(a : A, b : B) -> Self)(Self(a : a, b : b))
);

p := Pair.make(i32(1), true); // 静态方法：从实参推断 A := i32、B := bool
a := Pair.first(p); // 从接收者 `p` 推断 A := i32、B := bool
w := Rc.new(i32(5));
c := Rc.clone(w); // 即 Rc(i32).clone(w)
```

### 关联常量

`impl` 里除了方法，还可以声明普通的值成员。它可以直接从类型上读取，泛型函数体也可以从类型参数上读取。整数类型的 `MIN`、`MAX` 和 `BITS` 就是这样提供的（`u8.MAX`、`i16.MIN`、`u64.BITS`）。

声明为 **trait 成员**的常量还可以出现在签名的类型位置，例如作为 `Array` 的长度，无论是直接投影还是参与计算；这个投影会针对每次实例化分别求值。固有（inherent）常量目前还不能用在这个位置（`issues/an-inherent-associated-constant-does-not-resolve-as-an-array-length.md`），所以 prelude 把 `to_be_bytes` 所用的长度 `BYTES` 放在 `ByteWidth` trait 里声明。

```yo
{ println } :: import("std/fmt");

Grid :: struct(w : i32, h : i32);
impl(Grid, CELL_PX : i32(16)); // 与方法并列的值成员

// 泛型函数体从类型参数上读取常量。
bits_of :: (fn(generic(T : Type), x : T, where(T <: Integer)) -> u32)(T.BITS);

// 通过 trait 声明的常量还可以决定 `Array` 的长度。
Width :: trait(WIDTH : usize);
impl(u8, Width(WIDTH : usize(1)));
impl(u32, Width(WIDTH : usize(4)));
pad :: (fn(generic(T : Type), x : T, where(T <: Width)) -> Array(u8, T.WIDTH * usize(2)))(
  Array(u8, T.WIDTH * usize(2)).fill(u8(0))
);

main :: (fn() -> unit)({
  println(Grid.CELL_PX); // 16
  println(`${u8.MAX} ${i16.MIN} ${bits_of(u64(0))}`); // 255 -32768 64
  println(pad(u32(7)).len()); // 8
});
export(main);
```

## recur

`::` 函数按名字调用自身或同一模块的其他函数，这就是普通递归，不需要特殊形式：

```yo
fact :: (fn(n : i32) -> i32)(
  cond(
    (n <= i32(1)) => i32(1),
    true => (n * fact(n - i32(1)))
  )
);
```

`recur` 指代外层的函数字面量本身，用于没有名字可调用的匿名函数。在 `io.async`
lambda 中，`recur` 指代该 lambda，而不是外层函数。`recur` 是一次普通调用，
不做尾调用优化。

```yo
(fn(x : u32, acc : u32) -> u32)(
  if(
    x == 1,
    then : acc,
    else :
      recur(x - 1, acc * x)
  )
);
```
