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
| E0007 把 `{ a, b }`、`{ k : v }` 用作值——裸表达式花括号是块 | 在 `{` 前插入 `.`（记录 `.{ … }`） |
| E0007 `.{ a } := s`、模式中的 `.V(.{ x })`——绑定一侧带了点 | 删掉 `.` |
| E0007 `.{ a; b }`——带点的块 | 删掉 `.` |
| E0618 具名可调用值被裸传入 `Dyn(Fn(...))` 位置 | 按该位置所接受的指针擦除名字：`run(f)` → `run(dyn(Box.new(f)))`（`Rc` 为 `dyn(Rc.new(f))`，引用为 `dyn(&f)`；更长的值只给帮助） |
| E0620 具名普通值上的 `dyn(v)` | 装箱：`dyn(v)` → `dyn(Box.new(v))`（更长的值只给帮助） |
| import 的 kebab-case 写法恰好指向一个模块时的 `Module not found` | 把 import 字符串改写为该写法（`./string_util.yo` → `./string-util.yo`）；只做逐段的 `_` → `-` 与小写化，不做其他猜测。多个匹配，或违反命名规则的路径没有匹配时只给帮助 |

`yo fix <path>... --module-names` 应用模块文件与目录的命名规则（`.yo` 文件、目录与 `[modules]` 键都使用 kebab-case，见 `SYNTAX.md` 的命名规范）。路径下每个名字含 `_` 或大写字母的 `.yo` 文件或目录都会被重命名为其 kebab-case 写法（`_` 写作 `-`，大写转小写，去掉开头或结尾的 `-`：`array_list.yo` → `array-list.yo`，`_fsm.yo` → `fsm.yo`），所有解析到它的位置都会被改写：每个 `import("…")` 字符串按编译器的解析方式解析（因此 `./foo_bar.yo`、`../foo_bar`、`pkg/foo_bar`、std 也在路径中时的 `std/…/foo_bar`，以及目录模块 `foo_bar/index.yo` 都会随之改写），路径之上 `yo.toml` 的 `[modules]` 键与值，以及 `build.yo` 文件中 `root : "…"` 的路径。重命名映射会被打印出来（`fix: rename old -> new`；键则为 `[modules] old -> new`，它会改变下游包使用的导入名），下游包可以据此应用。不再能解析的 import（上游已重命名的 std 或依赖模块）会改为指向其 kebab-case 写法所解析到的唯一模块，也就是该错误的修复所给出的候选；若有多个候选，则列出并保持原样。因此依赖重命名了模块的包只需运行一次 `yo fix . --module-names`。`--dry-run` 只打印映射，不写入任何内容。若某个名字的新写法已经存在（`foo_bar.yo` 与 `foo-bar.yo` 并存：`-` 与 `_` 是不同的名字），或两个名字变成同一个，整次运行会在写入任何内容之前被拒绝。只改大小写的重命名会经过一个临时名字，因此大小写不敏感的文件系统也能看到它。cli-case 夹具、`tests/origins/corpus` 与 `issues/repros` 保持不变；第二次运行不会重命名任何东西。编译器无法识别为模块路径的字符串（注释、shell 脚本或测试字符串字面量中的路径）不会被改写。

模块级或 `thread_local` 运行期绑定是不可变的（Rust 的 `static`），除非它的名字被包在 `mut(...)` 里（`static mut`）。写入不可变的全局变量是 E0917：重新赋值、写入它所持有的值的字段或元素、把该值的位置以 `&mut` 借出，或在它上面调用 `&mut self` 方法。经由全局变量持有的“门”写入（`RefCell` 上的 `r.with_mut(...)`、`std/sync` 的各种门类型）不是对绑定的写入，不需要标记；只有对绑定本身重新赋值才需要。标记写在声明名上：`mut(G) := v`、`(mut(G) : T) = v`、`thread_local(mut(G))`。

把 `mut(...)` 全局变量或它下面的位置借给调用（`&`/`&mut` 实参、借用的接收者、运算符借用的操作数、插值的值）是 E0916，因为被调用者可能按名字触及该全局变量，或在 await 期间被另一个任务写入，借用就会在它之下改变。先把它读到局部变量里（`v := G; f(&v)`），`&mut` 调用之后再写回。`String`、集合或持有它们的值用 `v := G.clone()` 读取：涉及的每个 `Clone` 实现都是派生的或来自 std 的 `clone()`，其接收者是唯一允许的借出，因为这样的 clone 不运行用户代码。未标记的全局变量可以自由借出。全局变量持有的门（`RefCell` 上的 `G.with_mut(...)`、`std/sync` 的门类型）不会把借用带出它的闭包，因此在门被写入时，没有借出能到达它背后的存储。

同一规则也适用于模块级以下：局部变量、模式或解构绑定，以及编译期绑定（`x :: v`、`comptime(x) := v`）都是不可变的，除非名字被包在 `mut(...)` 里。写入未标记的绑定是 E0917，涵盖同样的四种写入（重新赋值；写入其值的字段或元素；以 `&mut` 借出其位置，包括 `y := &mut x`、`&mut` 的 match 被匹配值以及 `&mut` 捕获；在其上调用 `&mut self` 方法），`yo fix <path>` 通过给声明名包上 `mut(...)` 来修复它：`x := v` 改为 `mut(x) := v`，`(x : T) = v` 改为 `(mut(x) : T) = v`，`x :: v` 改为 `mut(x) :: v`，`comptime(x)` 改为 `comptime(mut(x))`，`.Some(v)` 改为 `.Some(mut(v))`，`{ a, b }` 改为 `{ a, mut(b) }`。参数不接受标记：请手工重新绑定（`mut(p_m) := p;`）。`YO_AUDIT_MUT_BINDINGS=1` 会打印对模块级以下绑定的每次写入（`[mut-binding] how=… kind=… marked=yes|no`），而不拒绝它。

经由 `Rc` 句柄的写入是 E0919：对 `h.*` 或其下位置的赋值（`h.n = v`、`h.items(i) = v`）、`&mut` 实参（`bump(&mut h.n)`），或在这样的位置上调用 `self : &mut Self` 方法（`h.items.push(v)`）。`Rc(T)` 就是 Rust 的 `Rc`：句柄的每个副本共享同一个单元，因此它的载荷经由句柄是只读的。需要写入的共享状态应改走“门”，错误信息会列出它们：`Rc(RefCell(T))`，在 `h.with_mut(v => ...)` 中写入（`std/sync/refcell`）；`Rc.get_mut(&mut h)`，没有其他句柄共享单元时为 `.Some(&mut T)`；`Rc.make_mut(&mut h)`，单元被共享时先把 `h` 移到新单元（要求 `T <: Clone`）；`Rc.try_unwrap(h)`，从唯一的句柄中取出载荷；唯一拥有的值或 `Box(T)`；跨线程则用 `Arc(Mutex(T))` 或原子类型。选哪扇门取决于状态为什么被共享，因此没有修复。

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

第二个家族是**模块名**。`check` 与 `compile` 对其求值过的、名字含 `_` 或大写字母的每个 `.yo` 文件或目录警告一次，前提是它属于项目本地：其所在位置或上方有 `yo.toml`，且它不是内容存储中的依赖（检出仓库自身的 `std` 属于项目本地，已安装的 std 不是；cli-case 夹具、`tests/origins/corpus` 与 `issues/repros` 豁免）——

```text
warning: module file name `string_util.yo` is not kebab-case
 --> src/string_util.yo:1:1
help: rename it `string-util.yo`: `yo fix . --module-names` renames every such file and directory under the project and rewrites the imports, `[modules]` entries and `build.yo` roots that reach them
```

它是警告而绝不是错误，`yo fmt` 也不会重命名文件：文件名是仓库层面的事实，因此编译器只指出它，由 `yo fix <root> --module-names`（见上文）完成重命名。

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
error[E0602]: Type P does not implement required trait Display.
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

Yo 经由 C 编译。若不加处理，C 编译器自己的诊断会指向生成的 `yo.c`
的某一行，而那是一个没人阅读的机器生成文件。`yo compile
--line-directives` 为它提供 Yo 位置：生成的 C 携带 `#line` 指令，把每条语句
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
