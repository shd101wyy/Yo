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
| E0401 名字未找到，且恰好由一个 std 模块导出 | 在第一行非注释代码之上插入 `{ name } :: import("std/…");`（帮助文本会指出模块；若有两个导出模块，或同时存在重命名候选，则只给帮助） |
| E0007 `{ f(x) }`——花括号内只有一个表达式且没有 `;` | 在 `}` 前插入 `;`（两个及以上逗号分隔的项只给消息） |
| E0618 具名可调用值被裸传入 `Dyn(Fn(...))` 位置 | 给名字加上包装：`run(f)` → `run(dyn(f))`（更长的值只给帮助；`--migrate dyn-spelling` 会处理它） |

`yo fix <path> --migrate <name>` 执行的是迁移而非修复，服务于参数约定的变更（VALUES_BY_DEFAULT V3b）和借用写法（决策 42）：

- `--migrate borrow-spelling` 把每个用模式关键字写出的借用改写为符号写法：`imm(x) : T` 改为 `x : &T`，`mut(x) : T` 改为 `x : &mut T`（参数、接收者、闭包参数、`Fn(...)` 槽位），`comptime(imm(x)) : T` 改为 `comptime(x) : &T`，局部借用 `mut(y) := place` 改为 `y := &mut place`，重指向 `mut(cur) = place` 改为 `cur = &mut place`，捕获列表的简写 `{ imm(y), mut(z) }` 改为 `{ &y, &mut z }`，`for(xs, mut(x) => …)` 改为 `for(&mut xs, x => …)`。编译器拒绝模式关键字（E0009），而每个模式关键字的含义恰好就是对应的符号写法。它只解析每个文件，所以也能触及宏实参、`quote(...)` 模板和泛型函数体；任何规则都不覆盖的位置上的模式关键字会连同位置列出并保持原样。`mut` 之前的写法 `inout(x) : T` 同样改为 `x : &mut T`。
- `--migrate modes` 把已删除的 `own(x)` 参数改写为 `sink(x)`（E0009 拒绝 `own`）。它只解析每个文件，所以也能触及求值看不到的代码（宏实参、`quote(...)` 模板、测试体）。
- `--migrate addr-of` 把原本是裸指针取址的 `&x` 改写为 `addr_of(x)`。它会对每个文件求值，因为只有求值器知道哪个 `&x` 是借用（传给 `&T` 参数的 `show(&s)` 保持不变），哪个是取址（绑定、裸指针参数、按值参数或可变参数位置的实参、方法接收者）。求值未触及的位置，或文本已不匹配的位置，会连同位置列出并保持原样。
- `--migrate params` 只处理已能求值的文件：类型不是 `Copy` 的普通参数改为 `&T` 借用（这正是 flip 之前普通参数的含义）。泛型参数改为 `&T` 借用，除非其 `where` 约束使它是 `Copy`。它写出 `x : &T`。
- `--migrate markers` 插入调用处的借用标记：传给 `&T` 参数的裸具名位置（变量、字段路径、元素 `xs(i)`）前加 `&x`，传给 `&mut T` 参数的加 `&mut x`。它会对每个文件求值，因为只有求值器知道参数的模式；方法接收者、临时值、运算符操作数、按值与编译期参数、整体传递的借用绑定，以及幽灵代码（契约谓词、`ghost_fn` 函数体）保持裸写。缺少标记是 E0914，始终生效，包括 std。

语义迁移只触及求值能触及的代码，因此有两个选项扩大其范围。`yo fix ./std ./tests --migrate markers` 在同一会话中对多个路径求值：泛型 `std` 函数体在测试实例化它时被求值，而由于 `std` 也在路径之中，其中的位置会被改写。`--target <triple>` 按该目标求值（同 `compile --target`），因此其他平台的 `cond(platform == ...)` 分支也会被迁移。

它们都不改变程序的行为。无法求值的文件中，求值未触及的部分保持不变，`fix` 以非零退出并指出该文件。

`yo fix <path> --migrate match-scrutinee` 是决策 26 的迁移：在该决策下，`match` 按值接收拥有所有权的被匹配值。它用新规则对每个文件求值，凡是移动会出错的地方就在被匹配值前写上 `&`：在 `match` 之后仍被使用的局部变量（`match(x, …)` → `match(&x, …)`）、模块级绑定、闭包捕获，以及字段、元素或解引用（`match(x.f, …)` → `match(&x.f, …)`）。`comptime_expect_error` 的参数保持不变，因为那个错误正是它要检验的。再运行一次不会再记录任何改写。

`yo fix <path> --migrate drop-trait` 是决策 45 的迁移：该决策把析构 trait `Dispose` 更名为 `Drop`（方法 `dispose` 改为 `drop`），并让显式调用析构函数成为 E0915。`Dispose` 作为标识符出现的地方（`impl` 条目、`<:` 约束或见证、导入）都改为 `Drop`，impl 条目的 `dispose :` 标签和每个解析为析构函数的 `.dispose` 成员改为 `drop`，写明的接收者 `dispose : (fn(self : &Self)` 改为 `drop : (fn(self : &mut Self)`（`Drop.drop` 接收 `&mut Self`，与 Rust 的 `drop(&mut self)` 相同；`Dispose :: trait(...)` 定义中也一样），结束一个具名值的显式调用 `x.dispose()` 或 `(T <: Dispose).dispose(&x)` 改为 `drop(x)`。最后这一条确实会改变程序：`drop(x)` 会把 `x` 移入，因此之后再使用 `x` 是 E0901，`check` 会指出位置。其他显式调用（`self.dispose()`、字段的 `s.f.dispose()`）会被重命名、连同位置列出，留待手工修改：析构函数从不调用字段的析构函数（字段会在它返回后自行 drop），而必须在其他引用仍然存活时释放的资源应提供一个普通方法，例如 `TcpStream.close_sync()`。名称按解析结果改写，但 `.dispose` 成员也可能是固有方法、其他 trait 的方法或字段，因此迁移会先求值每个文件，只改写解析为析构函数的成员；其他 `.dispose` 成员（或求值从未到达的代码中的成员）会被列出并保持原样。名为 `dispose` 的固有方法（`impl(T, dispose : ...)`）也会被列出、留待手工修改：旧编译器会把这个名字的方法当作引用类型的析构函数运行，而现在只有 `Drop` impl 的 `drop` 会运行，因此请把它的函数体移到 `Drop(drop : (fn(self : &mut Self) -> unit)(...))` 条目中。

`yo fix <path> --migrate dyn-spelling` 是决策 44 的迁移：在该决策下，每一次擦除为 `Dyn` 都要写出来。它对每个文件求值，把裸传入 `Dyn(Fn(...))` 绑定、字段、实参或结果的可调用值包上 `dyn(...)`：具名闭包、具名 `fn`、`Impl(Fn(...))` 形参、闭包字面量（`run(f)` → `run(dyn(f))`，`S(cb : f)` → `S(cb : dyn(f))`，以 `g` 结尾的函数体 → `dyn(g)`）。它所替代的拒绝是 E0618。文本已不再在一行内打印为所求值表达式的值，会连同位置列出并保持原样。

`yo fix <path> --migrate mutable-globals` 是决策 47 的迁移：在该决策下，模块级或 `thread_local` 运行期绑定是不可变的（Rust 的 `static`），除非它的名字被包在 `mut(...)` 里（`static mut`）。写入不可变的全局变量是 E0917：重新赋值、写入它所持有的值的字段或元素、把该值的位置以 `&mut` 借出，或在它上面调用 `&mut self` 方法。经由全局变量持有的 `ref` 句柄写入（`ArrayList` 上的 `g.push(x)`、`ref(struct)` 上的 `h.name = …`）不是对绑定的写入，不需要标记；只有对绑定本身重新赋值才需要。迁移对每个文件求值，并给每个这样被写入的全局变量的声明名包上 `mut(...)`：`G := v` 改为 `mut(G) := v`，`(G : T) = v` 改为 `(mut(G) : T) = v`，`thread_local(G)` 改为 `thread_local(mut(G))`。

决策 18 规则 3 读取的正是这个标记：把 `mut(...)` 全局变量或它下面的位置借给调用（`&`/`&mut` 实参、借用的接收者、运算符借用的操作数、插值的值）是 E0916，因为被调用者可能按名字触及该全局变量，或在 await 期间被另一个任务写入，借用就会在它之下改变。先把它读到局部变量里（`v := G; f(&v)`），`&mut` 调用之后再写回。`String`、集合或持有它们的值用 `v := G.clone()` 读取：涉及的每个 `Clone` 实现都是派生的或来自 std 的 `clone()`，其接收者是唯一允许的借出，因为这样的 clone 不运行用户代码。未标记的全局变量可以自由借出。持有 `ref` 句柄的全局变量多出两种冲突，各自报在编译器第二个看到的位置上：当它在任何地方被调用 `&mut self` 方法时，借入它背后存储（`&g(i)`）是 E0916；借出经由它写入过的字段（`h.name = …` 之后的 `&h.name`）同样是 E0916。迁移只标记声明；请检查迁移后的文件，并改写它报告的每个 E0916。这两个错误处处生效，`std` 和编译器自身源码也不例外。

`yo fix <path> --migrate explicit-copy` 为值语义默认计划中的唯一缓冲区（V2b）做准备。一旦 `String` 和标准库集合唯一地拥有自己的缓冲区，源值之后仍被使用的隐式拷贝就是 E0901。这个迁移在树仍然接受这些拷贝的时候运行。它求值每个文件，并在每个源值之后仍被使用的 `String`、集合或持有它们的值的拷贝之后写上 `.clone()`。这包括在之后还会读取 `s` 的 `t := s`、通过借用读取的字段（`p.name`）、被返回的借用参数，以及被存储、按值传递或返回的拷贝。这个拷贝必须是 `.clone()` 能做出的，也就是说其类型实现了 `Clone`。

如今这样的拷贝与源值共享缓冲区；加上 `.clone()` 后它是独立的。恰好在一方被写入、另一方之后又被读取的地方，程序的行为会因此改变：`l := m(k); l.push(x)` 本意是让映射里的列表增长。因此，源值或目标变量在拷贝之后被写入（写入其字段或元素、被调用方可能写入的 `&mut` 参数或接收者、`&mut` 借用）的拷贝会连同位置列出，留待手工修改：写入本应到达源值时用 `&mut`，否则用 `.clone()`。迁移看不到的写入是剩余的风险：拷贝离开函数之后（被存入字段、按值传递或返回）再通过它进行的写入。`--dry-run` 会打印每一处插入及拷贝的方式（`binding`、`return`、`field-store`……），以便逐一审阅。

以下位置也保持原样：

- 闭包捕获产生的拷贝；
- 宏写出的绑定；
- 以两种类型拷贝的位置（泛型函数体）；
- 源码文本与求值后的表达式打印结果不一致的位置。

移动检查器之后发现多余的克隆交由决策 27 的 lint 处理。

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
