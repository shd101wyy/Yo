# 字符串：字节索引契约

Yo 的字符串是 UTF-8 编码的，**每一个字符串索引都是字节偏移** —— 与 Rust 和
Go 的模型相同。这条规则贯穿日常代码里会遇到的所有字符串类型，并且在编译期同样
成立：

| 类型 | `len()` | 切片 | 元素访问 |
| --- | --- | --- | --- |
| `String`（`std/string`） | 字节数，O(1) | `substring(a, b)` —— 字节 | `byte_at(i)` → `u8`，`get_byte(i)` → `Option(u8)`，`at(i)` → `Option(rune)` |
| `&str`（prelude；字符串字面量为 `&(str, static)`） | 字节数 | `s(a..b)` —— 零拷贝字节窗口 | `bytes(i)` → `u8`（越界即中止） |
| `StringBuilder`（`std/string`） | 字节数 | — | — |
| `comptime_str`（编译期） | 字节数 | `slice(a, b)` / `s(a..b)` —— 字节 | `s(i)` → 单 rune 的 `comptime_str` |

它们都以字节为基准，编译期字符串也是如此。字符串索引只有一个故事。

## 唯一的规则

字符串索引命名的是一个**字节**，并且字符串方法接受或返回的每个索引都必须落在
**UTF-8 字符边界**上（某个 rune 的首字节，或 `len()`）。ASCII 文本不受影响
—— 它的每个字节都是边界。

```yo
{ String } :: import("std/string");

//        a=1B @0   é=2B @1   中=3B @3   𝄞=4B @6   —— 共 10 字节，4 个 rune
s := String.from("aé中𝄞");
s.len(); // usize(10) —— 字节数，O(1)
s.chars().count(); // usize(4)  —— rune 数量，O(n)
s.substring(usize(3), usize(6)); // "中" —— 字节区间 [3, 6)
s.find(String.from("中")); // .Some(usize(3)) —— 字节偏移，
//   可直接回喂给 substring
```

`find`、`rfind`、`s(a..b)` / `s(a..=b)` 区间语法糖，以及
`contains` / `starts_with` / `ends_with` 的可选位置参数，全部使用同一单位。
`Pattern` trait 的各个方法也是。

## 边界策略

在 `substring` 上陈述一次，同样适用于 `s(a..b)` 语法糖：

- **越界会被钳制（CLAMP）。** 超过 `len()` 的端点被拉回到 `len()`，
  `start >= end` 得到空字符串。该钳制是有意设计、经过测试的行为 —— 不是待
  "修复" 的意外（safe-mode D5）。
- **非边界索引会 PANIC。** 落在 rune 内部的端点是程序员错误 —— 一个来自错误
  基准的字节偏移 —— 而不是范围问题；迁就它会交出非法的 UTF-8。
- **`try_substring(a, b)`** 是不 panic 的形式：对 `a > b`、`b > len()` 或
  rune 内部的端点返回 `.None`（对应 Rust 的 `s.get(a..b)`）。
- **`floor_char_boundary(i)` / `ceil_char_boundary(i)`** 把任意字节偏移向
  前/向后吸附到边界上（钳制到 `len()`），供做字节运算的调用者使用。
- **`is_char_boundary(i)`** 直接回答这个问题：`0` 和 `len()` 永远是边界；
  超出末尾的索引永远不是。

```yo
s := String.from("aé中𝄞");
s.substring(usize(1), usize(2)); // PANIC —— 字节 2 在 é 内部
s.try_substring(usize(1), usize(2)); // .None —— 同一区间，礼貌地拒绝
s.floor_char_boundary(usize(2)); // usize(1) —— 吸附回 é 的起点
s.substring(usize(0), usize(99)); // "aé中𝄞" —— 越界钳制
```

`at(i)` 解码**从**字节 `i` 开始的 rune，对字节偏移无法命名 rune 的三种情况
返回 `.None`：达到或超过 `len()`、落在续延字节上、或字节无法解码。因此
`while(i < s.len())` 里逐字节调用 `at(i)` 会经过续延字节 —— 遍历 rune 请改用
`chars()` / `char_indices()`。

## 搜索方法从不 panic —— 但有一个被钉住的例外

`find` / `rfind` / `contains` / `starts_with` / `ends_with` 有意
不对位置参数做边界检查：UTF-8 是自同步编码，合法 UTF-8 的 needle 不可能从
续延字节处开始匹配。落在 rune 中间的 `from_index` / `position` 无法凭空制造
命中，只会得到 `false` / `.None`。对非空 needle，这些方法返回的每个索引都是
rune 边界。

**空 needle 是例外，其行为已被钉住：**

- `find("", i)` **原样返回 `.Some(i)`，不做任何校验** —— 包括落在 rune
  内部的 `i` 和超过 `len()` 的 `i`。（JavaScript 的 `indexOf("")` 会钳制到
  长度；这里不钳制。）
- `rfind("", i)` 无视 `i`，一律返回 `len()`（Rust `rfind("")` 的
  形状），因此这是结果可能超过调用者所给上限的唯一情形。

超出末尾的偏移在下游是无害的，因为 `substring` 会钳制；但 rune 中间的偏移会
让 `substring` panic。既把搜索结果直接回喂给切片、又可能拿到空 needle 的调用
者，应该改走 `try_substring`，或先用 `floor_char_boundary` 吸附。

## rune 操作：用迭代器，而不是字符索引

API 中没有按字符索引的切片。rune 操作由 `chars()` / `char_indices()` 与迭代
器方法组合完成：

```yo
s := String.from("aé中𝄞");

// rune 数量。O(n) —— 迭代器写法让这份开销在调用处可见（std 里的 `len()`
// 处处都是 O(1)；Rust 把 `len()` 留给 ExactSizeIterator，而 chars 迭代器
// 不是）。
n := s.chars().count(); // usize(4)
// 携带字节偏移遍历 rune：p._0 = 字节偏移，p._1 = rune。
for(s.char_indices(), p => { ... });

// 截断到至多 n 个 rune：第 n 个 rune 的起始字节偏移就是切点；
// 不足 n+1 个 rune 时保留整个字符串。
cut := match(
  s.char_indices().nth(usize(2)),
  .Some(p) => s.substring(usize(0), p._0),
  .None => s
); // "aé"
// 第一个 rune + 其余部分。
first := s.chars().next(); // Option(rune)
```

`chars()` 与 `char_indices()` 建立在 `std/encoding/utf8` 之上，继承其对畸形
输入的行为：在第一个无法解码的序列处停止。

## 元素访问：`s(i)` 与 `byte_at(i)`

`byte_at(i)` 返回偏移 `i` 处的**字节**（`u8`）—— 对 UTF-8 缓冲区的字节级访问，
没有边界要求 —— 越界时 panic。`get_byte(i)` 是带检查的形式：越界返回 `.None`
（对应 Rust 的 `s.as_bytes().get(i)`）。两者都就地读取字符串。解码用 `at(i)`。

`s(i)` 读取同一个字节：`String` 实现 `Output : u8` 的 `Index(usize)`，且不实现
`IndexMut`。`s(i) = b` 是编译错误：按字节写入可能留下非法的 UTF-8。区间语法糖 `s(a..b)` 构建一个新字符串。

```yo
{ String } :: import("std/string");

s := String.from("aé中");
s.byte_at(usize(0)); // u8(97)
s.get_byte(usize(9)); // .None —— 越界
s(usize(1) .. usize(3)); // "é" —— 一个新的 String
```

## `str` 与 `&str`

`str` 是**非定长**（unsized）的 UTF-8 字节序列，与 `[u8]`
一样只能放在指针之后：`&str` 是胖引用（字节的地址与长度，两个字，按值复制）。字符串字面量的类型是
`&(str, static)`，即指向静态字节的引用，因此它能填入任何 `&str` 位置。

```yo
count :: (fn(s : &str) -> usize)(s.len());

main :: (fn() -> unit)({
  s := "hello"; // `&(str, static)`
  _ := (count(s), count("abc"), s.len()); // 绑定、字面量、接收者
});
export(main);
```

`&str` 参数接收其实参所指向的 `str`，就像 `(x : &T)` 接收一个 `T`：字面量、`&str`
绑定或字段、`impl(str, ...)` 方法的接收者都可以直接传入。闭包按值捕获 `&str` 绑定（`{ s }`）时捕获的是该引用。

**值写法。** 在持有值的位置（按值参数、返回值、带类型的局部变量、结构体字段、数组元素、类型实参如
`ArrayList(str)`）写出的 `str` 表示 `&(str, static)`：静态字节的视图。
`&str` 与 `String` 或 `str` 的比较（`name == "lit"`、`"lit" == name`）两个方向都可用。

## 副本、克隆与字节列表

每个修改方法（`push_str`、`push_string`、`push_byte`、`push`、`reserve`、
`clear`、`truncate`、`insert_str`、`insert`、`remove`、`pop`）都接受
`self : &mut Self` 并就地写入。`String` 独占自己的字节：它是一个值
（`newtype(_bytes : ArrayList(u8))`），从不共享。`t := s` 会**移动**字符串，之后再使用
`s` 是 E0901，其帮助信息会给出 `s.clone()`。`clone()` 把字节复制（O(n)）到一个独立的
新字符串。`&String` 参数、`match(&s, ...)` 的绑定以及 `for(&xs, ...)` 的元素都借用字符串而
不复制；要保留它就 `.clone()`。字符串是 `Send` 与 `Sync` 的，因此可以移入
`Thread(...).spawn`，也可以经由 `Channel(String)` 传递。

模板字符串以借用方式追加 `String` 部分：`` `a${s}b` `` 只构建一个新字符串，并把 `s`
的字节复制进去一次。只有当模板的**第一个**部分是该 `String` 时，才会通过
`to_string()`（即 `clone()`）渲染它。

`String` 之外的任何东西都不能写它的缓冲区，所以字节列表只会被复制或移动，不会出借：

| 方法 | 结果 |
| --- | --- |
| `to_bytes()` | 一个新的、独立的 `ArrayList(u8)`，O(n) |
| `into_bytes()` | 消耗字符串并把缓冲区移出，O(1) |
| `String.from_bytes(sink(bytes))` | 接管列表，不检查 |
| `String.from_utf8(sink(bytes))` | 校验后接管列表；否则返回 `Err(.InvalidUtf8(...))` |
| `to_cstr_checked()` | 字节加上结尾的 `\0`，用于 C 边界；字符串含 NUL 字节时返回 `Err(.InteriorNul(index))` |
| `to_cstr()` | 字节加上结尾的 `\0`，不检查：遇到内部 NUL 时 C 只看到它之前的前缀 |

读取字节用 `len()`、`byte_at(i)`、`get_byte(i)` 或 `bytes()` 迭代器，它们都不复制。

std 中暴露值内部所存字符串的 getter 返回它的借用（投影，`-> &String` 或
`-> &Option(String)`），而不是副本：`Url.scheme`、`path`、`host`、`query`、
`fragment` 和 `userinfo`；`Regex.source`；`RegexMatch.value` 和 `input`；
`ParsedArgs.get_subcommand`；以及 `UnixListener.local_path`。读取结果（比较、插值、
传给 `&String` 参数）不复制任何东西。要保留或修改它，就复制一份：
`mut(p) := url.path().clone();`。借用位于接收者内部，所以在临时值上调用这些 getter
并绑定结果是错误（“…… a temporary that ends with this statement”）：先把接收者绑定到
局部变量，或对结果调用 `.clone()`。

在 C 边界上用来指名的字符串（路径、主机名、环境变量、程序参数）要经过
`to_cstr_checked()`。C 在第一个 NUL 处结束字符串，所以 `"/tmp/a\0/etc"`
否则会作用于 `/tmp/a`。std 的文件系统、网络、环境变量和进程 API 都这样做：这样的
路径或名字会抛出 `IoError.InvalidInput`（`exists`、`is_file`、`is_dir` 返回
`false`，`env.get` 返回 `.None`），永远不会落到前缀上。

## 编译期字符串共享同一基准

`comptime_str` 的操作同样以字节为基准：

```yo
s :: "aé中𝄞";
comptime_assert(s.len() == 10); // 字节数，与运行期 len() 一致
comptime_assert(s.slice(3, 6) == "中"); // 字节偏移，与 substring 一致
comptime_assert(s(1) == "é"); // 从字节 1 开始的那个 rune
comptime_assert(s(3 .. 6) == "中"); // 字节区间
```

两个编译期特有的要点：

- **rune 中间的偏移是编译错误**，不是 panic —— 对上面的字符串，编译器会拒绝
  `s(2)`（"not on a UTF-8 character boundary"）而不是中止进程。越界索引同样
  是编译错误；`slice` 对越界钳制。
- **`s(i)` 产出的是单 rune 的 `comptime_str`，不是字节。** 编译期字符串是
  文本，不是字节缓冲区，所以编译期 `s(i)` 对应运行期的 `at(i)`（从字节 `i`
  开始的 rune），而不是运行期的 `byte_at(i)`（`u8`）；运行期的 `String` 根本没有
  `s(i)`。这个结果类型上的差异是有意的。

## 实用规则

- 字节循环用 `len()` 做上界、用 `byte_at(i)` 读取 —— 两个基准现在天然一致。
- `find` 返回什么就直接喂回 `substring`（空 needle 除外 —— 见上文）。
- 永远不要在字节上做"索引 + 1 个 rune"这类算术；用 `char_indices()` 或
  `ceil_char_boundary`。
- 想表达"有多少个字符"时，写 `s.chars().count()`；想表达"缓冲区多大"时，写
  `s.len()`。
- `Content-Length` 这类协议字段数的是字节；如今 `len()` 默认就是正确答案。

## 字符串字面量作为 `str` 或 C 字符串指针

```yo
s := "Hello"; // s : str —— 字符串字面量就是内建的静态字符串视图 `str`。
(s2 : *u8) = "Hi"; // 可以显式声明一个 C 字符串指针。
s3 := (*u8)("Hi"); // 或使用指针类型转换获取 C 字符串指针。
```

## String（可增长字符串）

堆分配的可增长 UTF-8 字符串，与 Rust 的 `String` 形态一致。它**不是**不可变的：
`push_str`、`push_string`、`push_byte`、`push`、`reserve`、`clear`、
`truncate`、`insert_str`、`insert`、`remove` 和 `pop` 接受 `self : &mut Self`
并就地修改；而 `+` 之类的运算符仍然产生新字符串。

增量拼接请使用 `StringBuilder`：它是一个拥有自己字节缓冲区的值
——`b2 := b` 是移动，`b.clone()` 是独立副本，
`into_string()` 把缓冲区直接交还为 `String`，不新分配。需要多个所有者
共享的构建器写作 `Rc(RefCell(StringBuilder))`。

```yo
s := String.new();
s2 := String.from("Hello World!");
s3 := (s + s2); // 创建一个新字符串。
```

### 通过 `String` 的副本写入

`clone()` 才是独立的副本：它复制字节（O(n)），所以对克隆所做的任何事都不会通过原值
看到，反之亦然，无论原值是否为空。每个修改方法都接受 `self : &mut Self` 并就地写入，空
`String` 在第一次写入之前不分配任何内存。

`String` 唯一地拥有自己的字节（`newtype(_bytes : ArrayList(u8))`，而 `ArrayList`
是值类型）。因此普通的复制就是移动：`t := s`、用 `s` 构造结构体、按值传递 `s`，都会把
字符串交出去，之后再使用 `s` 是 E0901，其帮助信息会给出 `s.clone()`。从集合中读出的值
要么就地借用，要么克隆（`xs.get_cloned(i)`）。没有任何缓冲区是共享的，所以写入不会经由
另一个名字影响到字符串
（`issues/fixed/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md`，
由此修复）。

写入落在被写的位置上：

- **`&T` 参数** `fn(out : &String)` 借用调用方的值。写入它
  （`out.push_str("!")`，或把它传给 `&mut T` 形参）是 E0908。要修改调用方的字符串，
  请接受 `out : &mut String`；要产生新字符串，请按值接受 `out`（普通的
  `out : String` 拥有其实参，可以写入）并返回它。
- **`for` 或 `match` 的绑定**同样是借用：`for(xs, s => s.push_str("!"))` 是
  E0908。`for(&mut xs, s => s.push_str("!"))` 会就地写入每个元素，
  `xs(i).push_str("!")` 也一样。
- **结构体字段**通过它的位置写入：在 `p : &mut T` 形参或局部变量上写
  `p.name.push_str("!")`。

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array-list");

// `&mut T` 参数传入的是调用方的变量本身。
append_mut :: (fn(out : &mut String) -> unit)({
  out.push_str("!");
});

// `&T` 参数是借用的：写一个局部克隆并返回它。
with_bang :: (fn(s : &String) -> String)({
  mut(t) := s.clone();
  t.push_str("!");
  t
});

main :: (fn() -> unit)({
  a := String.from("hi");
  mut(b) := a.clone(); // b 拥有自己的一份字节
  b.push_str("?"); // a 不受影响
  println(`"${a}" "${b}"`); // "hi" "hi?"

  e := String.new();
  mut(f) := e.clone();
  f.push_str("x"); // 无论是否为空，克隆都是独立的
  println(`"${e}" "${f}"`); // "" "x"

  mut(c) := String.new();
  append_mut(&mut c);
  d := with_bang(&a);
  println(`"${c}" "${a}" "${d}"`); // "!" "hi" "hi!"

  mut(names) := ArrayList(String).new();
  names.push(String.new());
  names.push(String.from("n"));
  for(&mut names, s => {
    s.push_str("!"); // 就地写入元素
  });
  println(`"${names(usize(0))}" "${names(usize(1))}"`); // "!" "n!"
});
export(main);
```

由于 `String` 之外的任何东西都不能写它的缓冲区，字节 API 只复制或移动，不出借：
`to_bytes()` 返回一个独立的 `ArrayList(u8)`；`into_bytes()` 消耗字符串并把缓冲区
移出（没有其他副本共享时不复制）；`from_bytes(sink(bytes))` / `from_utf8(sink(bytes))`
接管传入的列表。就地读取字节用 `len()`、`byte_at(i)`、`get_byte(i)` 和 `bytes()`；
运行期的 `String` 没有 `s(i)`（见[元素访问](#元素访问si-与-byte_ati)）。

### 使用 `${}` 语法的模板字符串插值：

模板字符串的工作方式类似于 JavaScript 的模板字面量，允许你使用 `${}` 语法在字符串中嵌入表达式。`${}` 内的值必须实现 `Display` trait（`std/fmt`）。

```yo
name := "Alice";
age := 16;
greeting := `Hello, ${name}!, age: ${age}`;
// greeting: String
// 值为 "Hello, Alice!, age: 16"
```

含两个或更多部分的模板就是一个 `Formatter`：字面量部分用 `write_str` 写入，插值部分由它自己的 `Display.fmt(self, f : &mut Formatter)` 写入，模板的值是该 formatter 的 `finish()`。每个部分都把文本直接写进同一个结果，因此 `String` 部分不会先被复制一次。只有一个部分的模板（`${s}`）就是 `s.to_string()`，即 `Display` 的默认（provided）方法：它在一个新的 formatter 中运行 `fmt`（`String` 和 `str` 重写了它，直接复制自己的字节）。

自定义类型实现 `Display` 后即可被打印和插值。它的 `fmt` 用 `write_str`（一个 `str`）、`write_rune`、`write`（任意 `Display` 值）和 `write_debug`（任意 `Debug` 值）写入 formatter：

```yo
{ Display, Formatter } :: import("std/fmt");
Point :: struct(x : i32, y : i32);
impl(
  Point,
  Display(
    fmt : (fn(self : &Self, f : &mut Formatter) -> unit)({
      f.write_str("(");
      f.write(&self.x);
      f.write_str(", ");
      f.write(&self.y);
      f.write_str(")");
    })
  )
);
// `${Point(x : i32(1), y : i32(2))}` 的值是 "(1, 2)"
```

`Debug` 是与之并列的结构化通道：`derive(T, Debug)` 通过 `debug_fmt` 写出 `T(field1, field2)`，`debug_string()` 返回这段文本。

#### 格式说明符 —— `${value:spec}`

插值可以在冒号后带一个格式说明符，语法与 Rust、Python 一致（不支持动态宽度与精度）：

```text
spec  := [[fill]align][+][#][0][width][.precision][kind]
align := "<" | ">" | "^"
kind  := "x" | "X" | "b" | "o"
```

```yo
name := `ada`;
n := i32(255);
pi := f64(3.14159);

`[${name:>8}]`; // "[     ada]"   右对齐至宽度 8
`[${name:<6}]`; // "[ada   ]"     左对齐
`[${name:^7}]`; // "[  ada  ]"    居中
`[${name:*>6}]`; // "[***ada]"     自定义填充字符
`${n:x}`; // "ff"           小写十六进制
`${n:#06x}`; // "0x00ff"       替代形式并补零
`${pi:.2}`; // "3.14"         保留两位小数
`${pi:>8.3}`; // "   3.142"     宽度在精度之后生效
```

宽度以**字符**计。数字补零时，零位于符号或进制前缀与数字之间——`${i32(-(42)):08}`
得到 `-0000042`，而非 `000-0042`。

数字支持全部部分：符号、进制与补零，以及宽度、填充、对齐与截断。文本、`bool`、`Option`、`Result`、`ArrayList` 以及其他实现了 `Display` 的 std 类型通过 `Format` 的默认成员支持宽度、填充、对齐与截断。由于没有一揽子 impl（见上文“一致性”），自定义类型用一行代码接入：

```yo
impl(Point, Display(fmt : ((self, f) -> f.write(&`(${self.x}, ${self.y})`))));
impl(Point, Format());
`[${Point(x : i32(1), y : i32(2)):>8}]` // "[  (1, 2)]"
```

说明符与表达式之间以冒号分隔，且**冒号前不能有空格**。带空格的冒号不会被拆分，因此插值中
普通的冒号对保持原义；位于调用参数或字符串字面量内部的冒号——如 `${parts.join(":")}`
——也绝不会被误判为分隔符。
