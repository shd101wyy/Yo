# 模式匹配

`match`：模式的各种形式、守卫、穷尽性检查，以及 `match` 如何接收被匹配值。
枚举与 ADT 见 [DATA_TYPES.md](./DATA_TYPES.md)。

## 概述

编译器会对模式匹配进行穷尽性检查。

```yo
Coin :: enum(
  Penny,
  Nickel,
  Dime,
  Quarter
);

// 参考：
// - https://doc.rust-lang.org/book/ch06-02-match.html
// - https://github.com/tc39/proposal-pattern-matching
value_in_cents :: (fn(coin : Coin) -> u8)(
  match(
    coin,
    .Penny => {
      printf("Lucky penny!\n");
      1
    },
    .Nickel => 5,
    .Dime => 10,
    .Quarter => 25
  )
);

Shape :: enum(
  Circle(r : i32),
  Rectangle(w : i32, h : i32)
);

area :: (fn(shape : Shape) -> i32)(
  match(
    shape,
    .Circle(r) => (i32(3) * (r * r)),
    .Rectangle(w, h) => (w * h)
  )
);
```

## 模式的形式

模式就是普通表达式，编译器读取其形状。由于 Yo 没有运算符优先级，每个中缀模式都要写在自己的括号里。

| 形式 | 示例 | 含义 |
| --- | --- | --- |
| 通配符 | `_ => …` | 匹配任何值，不绑定 |
| 绑定 | `other => (other + 1)` | 匹配任何值并绑定它 |
| 常量 | `0`、`-1`、`true`、`'a'`、`"lit"`、`i32(5)`、`TEN`、`Color.Red` | 用 `==` 比较；作用域中持有字面量或枚举值的 `::` 常量是常量模式，其他标识符都是绑定 |
| 变体 | `.V`、`.V(p, q)`、`.V(label : p)`、`.V({ a, b : p })` | 子模式可以是任意模式，可任意嵌套 |
| 或 | `(.Red \| .Green)`、`(1 \| 2 \| 3)` | 各选项必须绑定相同的名字 |
| 范围 | `(0..10)`、`(10..=19)` | 半开 / 闭区间，边界为编译期常量 |
| 整体绑定 | `(whole := .Some(v))` | 绑定整个值并同时匹配子模式 |
| 守卫 | `(.Some(v) && (v > i32(100)))` | 模式匹配且守卫（可见绑定）为真时执行该分支 |
| 元组 | `(0, y)`、`(_, .Some(v))` | 元素个数必须相同，每个元素一个子模式 |
| 具名结构体 | `Point(x : 0, y)`、`Person(name : "alice")` | 带标签或裸字段名，可部分匹配（未列出的字段匹配任意值） |
| 匿名结构体 | `{x : 0, y}` | 用于结构体位置，与变体的花括号形式相同 |
| 包装 | `Rc(p)`、`Arc(p)`、`Box(p)` | 穿透 `Rc(T)`/`Arc(T)`/`Box(T)` 位置上的单元；`p` 匹配其中的 `T`；`Rc(p)`/`Arc(p)` 内的绑定是借用 |

```yo
classify :: (fn(r : Result(Option(i32), str)) -> i32)(
  match(
    r,
    .Ok(.Some(0)) => i32(0),
    (.Ok(.Some(v)) && (v < i32(0))) => i32(-1),
    .Ok(.Some(v)) => v,
    .Ok(.None) => i32(-2),
    (.Err("timeout") | .Err("closed")) => i32(-3),
    .Err(_) => i32(-4)
  )
);

bucket :: (fn(n : i32) -> str)(
  match(
    n,
    (0 .. 10) => "small",
    (10 ..= 99) => "medium",
    other => cond((other < i32(0)) => "negative", true => "large")
  )
);

command :: (fn(s : String) -> i32)(
  match(s, "compile" => i32(1), ("check" | "fmt") => i32(2), _ => i32(0))
);
```

元组被匹配值按元素逐个接受子模式；结构体被匹配值接受带标签的子模式
（裸字段名即绑定该字段；未列出的字段匹配任意值）。包装模式 `Rc(p)`、
`Arc(p)` 或 `Box(p)` 写出它所穿透的单元，与 Rust 相同：`p` 匹配该位置上
`Rc(T)`/`Arc(T)`/`Box(T)` 内部的 `T`，可任意嵌套，单元内的变体计入穷尽性检查。
`Rc(p)` 或 `Arc(p)` 中的绑定借用载荷，因为其他句柄可能共享该单元；
`(c := Rc(p))` 绑定单元本身。`Rc(T)` 或 `Arc(T)` 位置只接受包装写法：
不写包装的结构化模式是 E0609，其帮助信息给出 `Rc(p)`。缺失的情形
也透过包装打印（`.Node(Rc(.Leaf(_)), _)`）。在唯一的 `Box(T)` 位置上，未写
`Box(…)` 的模式也会被隐式穿透：

```yo
axis :: (fn(t : Tuple(i32, i32)) -> i32)(
  match(
    t,
    (0, y) => y,
    (x, y) => ((x * i32(10)) + y)
  )
);

Point :: struct(x : i32, y : i32);
origin_only :: (fn(p : Point) -> bool)(
  match(
    p,
    Point(x : 0, y : 0) => true,
    _ => false
  )
);

// 穿过 Rc 的递归枚举：`Rc(p)` 匹配内层的 List。
List :: enum(Nil, Cons(head : i32, tail : Rc(Self)));
second :: (fn(l : List) -> i32)(
  match(
    l,
    .Cons(_, Rc(.Cons(h, _))) => h,
    .Cons(h, _) => h,
    .Nil => i32(-1)
  )
);
Tree :: enum(Leaf(n : i32), Node(l : Rc(Self), r : Rc(Self)));
leaves :: (fn(t : Tree) -> i32)(
  match(
    t,
    .Node(Rc(.Leaf(a)), Rc(.Leaf(b))) => (a + b),
    .Node(_, _) => i32(-1),
    .Leaf(n) => n
  )
);
```

元组或结构体位置只有一个构造器，其穷尽性由各元素/字段的子模式共同决定
（缺失的元素/字段会在见证中指名，例如 `(_, 1)` 或 `Point(x : _, y : (101 ..= 149))`）。

分支按源码顺序尝试，首个匹配者胜出。穷尽性按结构检查：`.Some(true), .None` 会被拒绝并报告 `Missing case: .Some(false)`；缺失的变体会连同载荷一起给出（`Missing case: .Circle(_)`）。整数常量和范围按被匹配值类型上的区间处理：单独一个 `(0..=255)` 就覆盖了 `u8`，缺口以范围的形式报告（`Missing case: (101 ..= 149)`）。`usize` 和 `isize` 的取值范围随目标平台而不同，它们以及浮点数和字符串都需要通配符或绑定分支。带守卫的分支不算覆盖其模式；当正是守卫使某个值未被匹配时，错误的 help 行会指出这一点。

永远不会执行的分支在以下情况下是错误（`Unreachable match arm`，E0608）：前面的某一个分支单独就匹配了它能匹配的所有值（重复的 `.Red`、`_` 之后的任何分支、`(0..10)` 之后的 `(5..=7)`）；它自己的或模式中更早的选项已经如此（`(1 | 1)`）；或者被匹配值的类型中没有任何值能匹配它（空范围 `(5..5)`、该类型排除的 GADT 变体）。前面的分支只有合在一起才能覆盖的分支，例如 `.Some(true)` 和 `.Some(false)` 之后的 `.Some(_)`，只给出警告。末尾的 `_` 或绑定分支总是被接受。绑定如何持有被匹配值见下一节。

在会 `await` 的 `io.async` 分支中，所有模式形式均可用：分支的测试与绑定在
状态机的首轮执行中完成，分支体沿用常规的挂起/恢复机制
（`plans/reference/MATCH_PATTERN_MATCHING.md` §4.9）。

## `match` 如何接收被匹配值

`match` 接收被匹配值的方式与参数接收实参的方式相同
（即 Rust 的默认绑定模式）：

| 被匹配值 | 分支中的绑定 |
| --- | --- |
| 类型不可隐式复制的拥有所有权的局部变量、按值参数或临时值 | 被匹配值移动进 `match`：选中分支的绑定拥有各自的部分 |
| `&T` 引用绑定（`x : &T` 参数、`y := &place`、借用式 `match` 的绑定） | 只读借用 |
| `&mut T` 引用绑定（`x : &mut T` 参数、`y := &mut place`） | `mut` 位置：写绑定即写被匹配值 |
| `match(&x, …)` | 只读借用；`x` 之后仍可使用 |
| `match(&mut x, …)` | `mut` 位置；`x` 之后仍可使用 |
| `Copy` 值 | 与按值参数相同：复制 |

```yo
Fd :: struct(n : i32);
impl(Fd, Drop(drop : (fn(self : &mut Self) -> unit)(())));
Two :: enum(Two(a : Fd, b : Fd), Zero);

take :: (fn(f : Fd) -> i32)(f.n);

first :: (fn(p : Two) -> i32)(
  match(
    p,
    .Two(a, _) => take(a), // 进入分支时丢弃 `b`；`a` 被继续移动
    .Zero => i32(0)
  )
);

peek :: (fn(p : &Two) -> i32)(
  match(p, .Two(a, _) => a.n, .Zero => i32(0)) // 借用：没有任何移动
);

main :: (fn() -> unit)({
  p := Two.Two(a : Fd(n : 3), b : Fd(n : 4));
  n := match(&p, .Two(a, _) => a.n, .Zero => i32(0)); // 借用；p 仍可用
  r := first(p); // p 移动进 `first`
  (mut(o) : Option(i32)) = .Some(i32(1));
  match(
    &mut o,
    .Some(v) => {
      v.* = (v.* + i32(1));
    },
    .None => ()
  ); // o 变为 .Some(2)
});
```

消耗式 `match` 的规则：

- 守卫把绑定视为借用；移动发生在分支被选中时，因此守卫失败时载荷留给下一个分支。
- 分支没有绑定的部分（`_`、未列出的字段）在进入分支时被丢弃。分支结束时仍拥有的绑定在
  那里被丢弃；被移走的绑定则不再存在。
- 在引用单元之下（模式透视的 `Rc`/`Arc` 载荷），绑定是借用，句柄一直存活到分支结束。
- 消耗式 `match` 之后再使用被匹配值是 E0901，其提示给出 `match(&x, …)`。按值匹配模块级
  绑定、字段（`x.f`）、元素（`xs(i)`）或解引用（`p.*`）同样是 E0901（Yo 没有部分移动）：
  请写 `match(&x.f, …)`，或先用 `std/mem` 的 `take(&mut x.f)` 或
  `replace(&mut x.f, v)` 把字段移出。
- `(name := p)` 取得整个值，因此 `p` 中的绑定必须是 `Copy`。或模式不能让带有丢弃操作的
  部分保持未绑定（各选项会丢弃不同的部分）：请拆分分支或绑定该部分。

`mut` 位置在存活期间是独占的：分支只能通过它读、写或移动被匹配值（E0911）；`&mut` 需要
可写的位置（`imm` 绑定是 E0908，临时值是错误）。在 `io.async` 函数体中，位置可以跨越
`await`，除非被匹配值经过引用单元或模块级位置：当前任务挂起时，其他任务可能访问到该位置
（E0911，与局部借用的规则相同）。
