# 错误诊断 —— 错误码、`yo explain` 与机器可读输出

Yo 的错误通道同时面向人类与依赖编译器反馈反复迭代的智能体。编译器报告的每一个错误都是结构化诊断：严重级别、消息、精确的源码区间、可选的错误码，以及可选的帮助提示 —— 并按使用方指定的格式渲染。

## 渲染格式

默认（human）格式采用 rustc 风格 —— 每个条目一个块，第 0 条是主错误，其余条目是附注：

```bash
$ yo check ./src
error[E0401]: Variable "undefined_fn_xyz" not found.
 --> src/main.yo:12:5
  |
1 |   undefined_fn_xyz();
  |   ^^^^^^^^^^^^^^^^^^
help: run `yo explain E0401` for more information
```

`--error-format` 选择渲染方式。它是一个**全局**标志 —— 放在子命令之前 —— `YO_ERROR_FORMAT` 环境变量以更低的优先级设置同样的内容：

```bash
yo --error-format short check ./src     # 每个条目一行
yo --error-format json compile app.yo   # 机器可读
YO_ERROR_FORMAT=json yo build           # 通过环境变量设置
```

- `human`（默认）—— 上面的块状渲染。
- `short` —— `path:row:col: error[CODE]: message`，便于 grep。
- `json` —— 每条诊断一个 JSON 对象，位置从 0 开始计数，并附带 human 渲染文本（`rendered`），使用方可以直接展示任一形式：

```json
{
  "severity": "error",
  "code": "E0401",
  "message": "Variable \"undefined_fn_xyz\" not found.",
  "span": { "file": "src/main.yo", "row": 11, "col": 2, "end_col": 19 },
  "rendered": "error[E0401]: ..."
}
```

- `sarif` —— 将整组诊断作为一份 [SARIF](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) 2.1.0 日志输出到 stdout：错误码成为 driver 规则，位置按 SARIF 规范从 1 开始计数，机械修复成为 `fixes` 条目 —— 这是 GitHub code scanning 与大多数 CI lint 流水线摄取的字段。无论 `--color` 如何设置都不着色。

`--json-summary`（由 test/check 驱动接受）额外把最终的 `N passed / M failed` 式页脚输出为一行机器可读的摘要，测试工具无需抓取正文即可解析结果。

### 颜色

human 渲染在写入终端时会着色：严重级别头部与其插入符携带级别对应的颜色（红/黄/青），`-->` 锚点与边栏为蓝色，`help:` 标签为洋红色。它与 `--error-format` 一样是一个**全局**标志，`YO_COLOR` 环境变量以更低的优先级设置同样的内容：

```bash
yo --color always check ./src    # 即使输出到管道也强制着色
yo --color never check ./src     # 强制纯文本
YO_COLOR=always yo build         # 通过环境变量设置
```

`auto`（默认）仅当 stderr 是终端、`NO_COLOR` 未设置（https://no-color.org）且 `TERM` 不为 `dumb` 时着色；显式的 `--color always` 覆盖这三者。`short` 输出保持纯文本 —— 它本就是为 grep 而生 —— `json` 输出则永不携带 ANSI 转义序列，包括其 `rendered` 字段内嵌的 human 文本，因此机器使用方无论 `--color` 如何设置，得到的都是字节一致的负载。`yo lsp` 忽略该标志：协议帧是数据通道。

### 修复与 `yo fix`

只有当恰好存在唯一一种修改能修复该诊断时，诊断才会携带 `repair`；编译器从不在多种候选之间猜测，因此一条列出两种可能修法的消息不带修复。JSON 渲染中该字段为 `{ "file", "row", "col", "end_col", "replacement", "description" }`（0 起始，按 rune 计列；`col == end_col` 表示插入）——`yo fix <path>` 应用的正是同一修改，它会格式化每个改写过的文件并反复运行直到某一轮没有改动。`yo fix --dry-run` 只打印修复，不写入。

编译器目前会算出的修复：

| 诊断 | 修复 |
| --- | --- |
| E0401 名字未找到，作用域内有一个接近的候选 | 重命名该标记（`countr` → `counter`） |
| E0401 指向 `rc`/`box`/`arc`，即静态实参推断 B3 删除的 prelude 内建函数 | 把名字改写为句柄的构造函数（`rc` → `Rc.new`、`box` → `Box.new`、`arc` → `Arc.new`）；闭包或 `.None` 实参随后需要写出类型，即 E0613 |
| E0401 名字未找到，且恰好由一个 std 模块导出 | 在第一行非注释代码之上插入 `{ name } :: import("std/…");`（帮助文本会指出模块；若有两个导出模块，或同时存在重命名候选，则只给帮助） |
| E0007 `{ f(x) }`——花括号内只有一个表达式且没有 `;` | 在 `}` 前插入 `;`（两个及以上逗号分隔的项只给消息） |
| E0618 具名可调用值被裸传入 `Dyn(Fn(...))` 位置 | 给名字加上包装：`run(f)` → `run(dyn(f))`（更长的值只给帮助） |

`yo fix <path> --migrate deref` 执行的是迁移而非修复，服务于决策 43 第 2 步（N1e-1）：在标准库和编译器自身源码以外，引用绑定用 `.*` 读写它所引用的值。它在 E0926 记录而不拒绝的模式下对每个文件求值：整体读写引用的地方追加 `.*`（`n + 1` → `n.* + 1`，`r = v` → `r.* = v`，`&r` → `&r.*`）；经由引用表示 `Box`/`Rc`/指针解引用的 `v.*` 改为 `v.*.*`；给捕获列表中的简写加上标签（`{ r }` → `{ r : r.* }`）；删掉 `match(&r, …)` 中多余的标记。源文本在一行内已不再打印为求值得到的表达式的位置，以及被引用值不能隐式复制的拷贝（那里的 `r.*` 会是 E0901），会连同位置列出并保持原样。第二次运行不会记录任何内容。

迁移只触及求值能触及的代码，因此有两个选项扩大其范围。`yo fix ./std ./tests --migrate deref` 在同一会话中对多个路径求值：泛型 `std` 函数体在测试实例化它时被求值。不加 `--target` 时，若文件中按平台分支的 `cond` 留下主机不会求值的分支，就针对其他每种受支持的架构和操作系统再求值一次，两个目标读法不同的位置会被列出并保持原样；`--target <triple>` 只针对该目标求值，同 `compile --target`。无法求值的文件中，求值未触及的部分保持不变，`fix` 以非零退出并指出该文件。

`yo fix <path> --migrate record-literal` 是花括号组规则（`plans/backlog/BRACE_BLOCKS.md`，第 A 代）的迁移：解析器接受在左花括号前加一个点的记录值写法，迁移会在表达式位置、如今即为记录的每个花括号组前写上这个点，单字段简写组和空组也包括在内。它读取解析结果而不求值，因此不需要 prelude，能触及每个文件。它不触及任何绑定位置：`:=`、`=`、`::` 的左侧（解构、导入、通配）、`match` 模式与子模式、`for` 元素模式、闭包捕获列表和参数，以及代码块都保持原有花括号。已经带点的组保持原样，所以第二次运行不会改动任何内容；无法解析的文件会被点名，`fix` 以非零退出。

`yo fix <path> --migrate unsized` 是决策 49（`plans/VALUES_BY_DEFAULT.md`）的迁移：`Dyn(...)` 是非定长类型，只能位于指针之后，因此 v0.2.77 中裸 `Dyn(...)` 值类型所指的拥有型 trait 对象写作 `Box(Dyn(...))`。迁移把每个裸 `Dyn(...)` 类型写法改写为 `Box(Dyn(...))`：绑定、形参、字段、元素或结果的类型，类型别名的定义体，`Type.impls`/`Type.eq`/`size_of` 的实参，以及指向拥有型盒子的 `*Dyn(...)`/`?*Dyn(...)`。作为 `Box`、`Rc`、`Arc`、`Weak`、`ArcWeak`、`&` 或 `&mut`（带或不带 origin）直接实参的 `Dyn(...)` 已经指非定长对象，保持不变，`upcast` 的目标也一样，所以第二次运行不会改动任何内容。在 v0.2.77 中两种写法是同一个类型，因此 `yo check` 的结论不变。类型写法读取自解析结果，因此能触及每个平台分支。迁移还会像 `yo check` 一样对每个文件求值，并打开记录器：普通值上的 `dyn(v)` 改写为 `dyn(Box.new(v))`，在拥有型 `Dyn` 位置上求值的 `dyn(Rc.new(e))`/`dyn(Arc.new(e))` 改写为 `dyn(Box.new(e))`（`alloc` 照原样保留）。以下位置会连同其位置一起列出而不改写：无法在一行内打印回来的写法；`Rc(Dyn(T)).new(...)`（一个共享对象写 `dyn(Rc.new(v))`，或用 `Rc(Box(Dyn(T))).new(...)` 保留盒子）；`impl(Dyn(...), ...)`（如今是拥有型的值，v0.2.78 起是非定长对象）；原始指针上的 `dyn(p)`（如今为指针装箱，v0.2.78 起把它非定长化）；具名 `Rc`/`Arc` 句柄上的 `dyn(h)`；对拥有型 `Dyn` 的 `downcast`（其拥有型形式在 v0.2.78 到来）；以及含有当前目标不求值的平台 `cond` 分支的文件（用 `--target` 再运行一次）。无法求值的文件会被点名，`fix` 以非零退出。

模块级或 `thread_local` 运行期绑定是不可变的（Rust 的 `static`），除非它的名字被包在 `mut(...)` 里（`static mut`，决策 47）。写入不可变的全局变量是 E0917：重新赋值、写入它所持有的值的字段或元素、把该值的位置以 `&mut` 借出，或在它上面调用 `&mut self` 方法。经由全局变量持有的 `ref` 句柄写入（`ArrayList` 上的 `g.push(x)`、`ref(struct)` 上的 `h.name = …`）不是对绑定的写入，不需要标记；只有对绑定本身重新赋值才需要。标记写在声明名上：`mut(G) := v`、`(mut(G) : T) = v`、`thread_local(mut(G))`。

决策 18 规则 3 读取的正是这个标记：把 `mut(...)` 全局变量或它下面的位置借给调用（`&`/`&mut` 实参、借用的接收者、运算符借用的操作数、插值的值）是 E0916，因为被调用者可能按名字触及该全局变量，或在 await 期间被另一个任务写入，借用就会在它之下改变。先把它读到局部变量里（`v := G; f(&v)`），`&mut` 调用之后再写回。`String`、集合或持有它们的值用 `v := G.clone()` 读取：涉及的每个 `Clone` 实现都是派生的或来自 std 的 `clone()`，其接收者是唯一允许的借出，因为这样的 clone 不运行用户代码。未标记的全局变量可以自由借出。持有 `ref` 句柄的全局变量多出两种冲突，各自报在编译器第二个看到的位置上：当它在任何地方被调用 `&mut self` 方法时，借入它背后存储（`&g(i)`）是 E0916；借出经由它写入过的字段（`h.name = …` 之后的 `&h.name`）同样是 E0916。这两个错误处处生效，`std` 和编译器自身源码也不例外。

决策 47 第二步把同一规则应用到模块级以下：局部变量、模式或解构绑定，以及编译期绑定（`x :: v`、`comptime(x) := v`）都是不可变的，除非名字被包在 `mut(...)` 里。写入未标记的绑定是 E0917，涵盖同样的四种写入（重新赋值；写入其值的字段或元素；以 `&mut` 借出其位置，包括 `y := &mut x`、`&mut` 的 match 被匹配值以及 `&mut` 捕获；在其上调用 `&mut self` 方法），`yo fix <path>` 通过给声明名包上 `mut(...)` 来修复它：`x := v` 改为 `mut(x) := v`，`(x : T) = v` 改为 `(mut(x) : T) = v`，`x :: v` 改为 `mut(x) :: v`，`comptime(x)` 改为 `comptime(mut(x))`，`.Some(v)` 改为 `.Some(mut(v))`，`{ a, b }` 改为 `{ a, mut(b) }`。参数不接受标记：请手工重新绑定（`mut(p_m) := p;`）。`YO_AUDIT_MUT_BINDINGS=1` 会打印对模块级以下绑定的每次写入（`[mut-binding] how=… kind=… marked=yes|no`），而不拒绝它。

经由 `Rc` 句柄的写入是 E0919：对 `h.*` 或其下位置的赋值（`h.n = v`、`h.items(i) = v`）、`&mut` 实参（`bump(&mut h.n)`），或在这样的位置上调用 `self : &mut Self` 方法（`h.items.push(v)`）。`Rc(T)` 就是 Rust 的 `Rc`：句柄的每个副本共享同一个单元，因此它的载荷经由句柄是只读的（决策 46）。需要写入的共享状态应改走“门”，错误信息会列出它们：`Rc(RefCell(T))`，在 `h.with_mut(v => ...)` 中写入（`std/sync/refcell`）；`Rc.get_mut(&mut h)`，没有其他句柄共享单元时为 `.Some(&mut T)`；`Rc.make_mut(&mut h)`，单元被共享时先把 `h` 移到新单元（要求 `T <: Clone`）；`Rc.try_unwrap(h)`，从唯一的句柄中取出载荷；唯一拥有的值或 `Box(T)`；跨线程则用 `Arc(Mutex(T))` 或原子类型。选哪扇门取决于状态为什么被共享，因此没有修复。

#### 已退役的迁移

每个 `yo fix --migrate <name>` 都是为了把代码带过语言的一次变更，一旦我们拥有的代码都已过渡，它就退役。相应的错误仍是硬错误，帮助信息会给出修复方法，上文的逐诊断修复也保留。要升级在某次变更之前编写的代码，请安装最后携带其迁移的版本，在那里运行迁移，然后升级到下一个版本：

```sh
yo version install 0.2.76
yo fix <path> --migrate borrow-spelling
```

| 迁移 | 改写的内容 | 对应的错误 | 最后携带的版本 |
| --- | --- | --- | --- |
| `explicit-copy`（连同 `YO_AUDIT_IMPLICIT_COPY` 列表） | 源值之后仍被使用的 `String`、集合或持有它们的值的拷贝，改写为 `.clone()` | E0901 | v0.2.73 |
| `cloned-accessors`（连同 `YO_AUDIT_COPYING_ACCESSOR` 列表和 `--hot-path`） | 结果持有 `String` 或集合的拷贝式访问器调用，`r.get(i)` 改写为 `r.get_cloned(i)` | E0901 | v0.2.73 |
| `handle-ctors` | prelude 的 `rc(x)`/`box(x)`/`arc(x)` 改写为 `Rc.new(x)`/`Box.new(x)`/`Arc.new(x)`，并为闭包或 `.None` 实参写出所需的类型实参 | E0401（其修复会改写名字） | v0.2.73（之后的版本仍带有该模式，但 v0.2.74 删除了这些内建函数，只有 v0.2.73 能为旧调用定型） |
| `modes` | 已删除的 `own(x)` 参数改写为 `sink(x)` | E0009 | v0.2.76 |
| `params` | 类型不是 `Copy` 的普通参数改写为 `x : &T`，即按值切换之前它的含义 | E0901 | v0.2.76 |
| `addr-of` | 原本是裸指针取址的 `&x` 改写为 `addr_of(x)` | E0914 | v0.2.76 |
| `markers` | 传给 `&T`/`&mut T` 参数的裸具名位置加上 `&x`/`&mut x` | E0914 | v0.2.76 |
| `match-scrutinee` | 移动被匹配值会出错之处，`match(x, …)` 改写为 `match(&x, …)`（决策 26） | E0901 | v0.2.76 |
| `borrow-spelling` | 模式关键字改写为符号：`imm(x) : T` 改为 `x : &T`，`mut(x) : T` 改为 `x : &mut T`，`mut(y) := p` 改为 `y := &mut p`，`for(xs, mut(x) => …)` 改为 `for(&mut xs, x => …)`（决策 42） | E0009 | v0.2.76 |
| `drop-trait` | `Dispose`/`dispose` 改写为 `Drop`/`drop`，`x.dispose()` 改写为 `drop(x)`（决策 45） | E0915 | v0.2.76 |
| `rc-pattern` | `Rc(T)` 位置上的模式 `p` 改写为 `Rc(p)`（决策 31） | E0609 | v0.2.76 |
| `dyn-spelling` | 裸传入 `Dyn(Fn(...))` 位置的可调用值改写为 `dyn(f)`（决策 44） | E0618 | v0.2.76 |
| `mutable-globals` | 给程序写入的每个模块级绑定加上 `mut(G)`（决策 47） | E0917 | v0.2.76 |
| `mut-bindings` | 给程序写入的每个局部、模式和编译期绑定加上 `mut(x)`（决策 47 第二步） | E0917 | v0.2.76 |
| `rc-clone` | 源值之后仍被使用的计数句柄隐式拷贝改写为 `Rc.clone(h)`/`Arc.clone(h)`/`e.clone()`，捕获句柄的闭包加上捕获列表（决策 17） | E0901 | v0.2.76 |

请按阶段顺序运行它们。早于决策 42 的代码要先运行 `borrow-spelling`，再运行 `mut-bindings`：这类代码中的 `mut(z) := x` 是已删除的局部借用写法，`mut-bindings` 会把它当作可变局部变量。绝不要在已经使用决策 47 的 `mut(x) := v` 写法的代码上运行 `borrow-spelling`。拷贝迁移在 v0.2.73 上按各自的顺序运行：`explicit-copy`、`cloned-accessors`，然后 `rc-clone`，之后再固定到 v0.2.74。`yo fix --migrate deref` 和 `yo fix --migrate record-literal` 是本版本携带的两个模式。

## 警告

`check`、`compile` 与 `build` 还会携带警告级别的诊断，针对能编译但看起来有问题的代码。第一个家族是**未使用的变量**：已初始化但没有任何读取的局部变量，会在其作用域结束时警告一次：

```text
warning: unused variable `x`
 --> src/main.yo:3:3
  |
3 |   x := i32(7);
  |   ^
help: prefix the name with `_` to silence this warning
```

读取变量即视为使用；仅赋值不算（`x := 1; x = 2;` 仍会警告 —— 该值从未影响任何东西）。名称加 `_` 前缀可消除警告；参数与模块级绑定从不警告；警告绝不改变退出码。在 `json` 渲染中它们以 `"severity":"warning"` 的 JSON Lines 出现，`short` 中则是 `warning:` 行。

## 错误码与 `yo explain`

属于已知家族的错误会在头部携带稳定的 `EXXXX` 错误码，并在 `help:` 尾行指向解释器。错误码属于错误本身，而不属于措辞：报告错误的位置会指明它的家族，因此同一个底层错误无论由哪个阶段报告都得到相同的错误码（类型不对的实参无论是函数实参还是变体载荷都是 E0601），改写消息也不会改变它的错误码。没有家族的错误不带错误码。

错误码按波段分配：E00xx–E02xx 语法，E03xx–E05xx 名称/作用域/模块解析，E06xx–E08xx 类型与 trait，E09xx–E10xx 所有权与异步，E11xx–E12xx 编译期，E13xx 内部代码生成，E15xx CLI/构建/依赖工具链。其中两个波段命中的失败没有源码区间。`E1301` 是编译器内部错误（ICE）的包裹层 —— 那是编译器的缺陷，应当报告而不是在你的程序里找原因。E15xx 家族则来自 `yo install` / `yo add` / `yo update` —— 智能体在全新克隆上最先撞到的获取、清单与锁的失败：

| 错误码 | 失败 |
| --- | --- |
| E1501 | 依赖无法获取（`--offline` 且缓存为空、仓库不可达、clone 失败） |
| E1502 | 工作目录及其上级目录中没有 `yo.toml` |
| E1503 | `yo.lock` 与 `yo.toml` 不一致（`--locked` 下过期、缺失或不可用） |
| E1504 | 获取到的依赖树哈希与 `yo.lock` 记录不符 |
| E1505 | 依赖没有任何标签能满足对它的全部要求 |
| E1506 | 包名（`[package] name`、依赖键、`yo add --name`）不在 `[A-Za-z0-9_-]+` 之内 |

它们与其他错误一样带错误码和 `explain` 尾行渲染，`--error-format json` 也会携带错误码，因此错误路由可以按家族分支，而不必对散文做字符串匹配。

```bash
$ yo explain E0401
E0401 — name not found

A name lookup failed: the identifier is not defined in this scope.

...

Example — this fails:
    undefined_fn_xyz();
```

- `yo explain --list` —— 列出所有已注册的错误码及其一行标题。
- `yo explain E0401 --format json` —— 以 JSON 输出完整条目（供工具使用）。
- `yo explain E0401 --lang zh` —— 该条目的中文版本；`YO_LANG` 环境变量可为 `explain` 及默认输出选择语言。

输错了码？`yo explain` 会给出最接近的已注册码 —— 与编译器为拼错的名称、枚举变体提供 "did you mean" 提示的是同一套编辑距离引擎。

## 错误报告在哪里

错误指向引起它的代码：与形参不符的那个实参、构造器调用缺少的那个字段。在检查你写的调用时于标准库内部引发的错误，会报告在那个调用处，并以 note 给出标准库中的位置：

```
error[E0602]: Type P does not implement required trait ToString.
  --> main.yo:5:3
  |
5 |   println(p);
  |   ^^^^^^^
note: raised here, inside the standard library
  --> /…/std/fmt/index.yo:63:50
```

## 诊断出现的位置

- `yo check`、`yo compile`、`yo build`、`yo test`、`yo install` —— 每个 CLI 出口都按所选格式、且只打印一次每条诊断。
- `yo lsp` —— 语言服务器通过结构化通道接收诊断（精确区间，无需重新解析文本），即使错误源于被导入的文件，编辑器也能得到精确的波浪线。
- 运行时 panic 携带调用点位置后缀：`panic: <message> (at file://…/app.yo:3:17)`。

## C 编译器诊断（`--line-directives`）

Yo 经由 C 编译，而 C 编译器自己的诊断曾是唯一没有 Yo 位置的通道：生成
`yo.c` 里的错误指向一个没人阅读的机器生成文件的某一行。`yo compile
--line-directives` 补上了这个缺口。生成的 C 携带 `#line` 指令，把每条语句
映射回它的 `.yo` 源码；恢复指令则让编译器生成的代码（drop、异步状态机、
运行时脚手架）保持真实的 C 行号：

```c
#line 42 "app.yo"
  len := __yo_strlen(...);
#line 2603630 "out.c"
```

开启该标志后：

- C 调试器（编译产物上的 lldb/gdb，建议配合 `-g`）可以单步调试 `.yo`
  文件 —— 在 Yo 的行和文件上打断点都是有效的；
- 来自 Yo 代码的 C 编译器诊断报告 `.yo` 位置，并且编译失败时会把它们
  重新渲染为所选 `--error-format` 下的常规结构化诊断 ——
  `error: incompatible pointer types` 会像任何 Yo 错误一样带
  `--> app.yo:12:9` 锚点；
- `--emit-chunks` 同样支持：每个翻译单元的恢复指令指向该单元自己的
  chunk 文件。

该标志默认关闭（它会增大生成的 C，属于调试辅助）；想要源码级调试会话时
请与 `-g` 一起使用。

## 退出码

任何格式下，错误退出码为 `1`，成功为 `0`。机器使用方应以退出码判断结果、以 JSON 输出获取细节，而不是解析正文。
