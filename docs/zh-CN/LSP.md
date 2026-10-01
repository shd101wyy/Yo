# 语言服务器协议 (LSP) 支持

`yo lsp` 是内置在 `yo` 二进制中的语言服务器。它通过 stdio 使用 LSP 通信，并复用
Yo 求值器而不是另写一个解析器，因此它报告的类型和值与编译器完全一致。VS Code 扩展
内置了它的客户端；任何支持 LSP 的编辑器都可以直接启动 `yo lsp`。

## 架构

```
编辑器（VS Code 扩展，或任意 LSP 客户端）
  ↕ stdio JSON-RPC
yo lsp（src/lsp/，每个功能一个模块）
  ↕ 直接函数调用
Yo 求值器（module_manager：缓存的 prelude、按需加载的 import）
```

服务器用 Yo 编写，位于 `src/lsp/`。VS Code 扩展是一个轻量的 `LanguageClient`
包装（`vscode-extension/extension.js`，纯 JavaScript，无构建步骤）。所有智能逻辑
都在服务器中。

## 设置

### VS Code

安装 [Yo 扩展](https://marketplace.visualstudio.com/items?itemName=shd101wyy.yolang)，
并确保 `PATH` 中有 `yo` 二进制（参见 [macOS](./INSTALL_MACOS.md)、
[Linux](./INSTALL_LINUX.md) 和 [Windows](./INSTALL_WINDOWS.md) 的安装指南）。打开
`.yo` 文件时扩展会启动 `yo lsp`。

设置项：

| 设置              | 默认值  | 含义                                                                            |
| ----------------- | ------- | ------------------------------------------------------------------------------- |
| `yo.binPath`      | `"yo"`  | 当 `yo` 不在 `PATH` 中时，用于启动服务器的 `yo` 二进制路径。                          |
| `yo.lsp.enabled`  | `true`  | 是否启动语言服务器。设为 `false` 时扩展只提供语法高亮。                                |
| `yo.trace.server` | `"off"` | `messages` 或 `verbose` 会把 JSON-RPC 通信记录到 "Yo Language Server" 输出面板。 |

命令 **Yo: Restart Language Server** 会停止并重新启动服务器（例如安装了新版
`yo` 之后）。修改 `yo.binPath` 或 `yo.lsp.enabled` 会自动重启。

### 其他编辑器

把编辑器的 LSP 客户端指向命令 `yo lsp`（无参数，stdio 传输），用于 `yo` 语言 /
`.yo` 文件。例如使用 Neovim 内置客户端：

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = "yo",
  callback = function()
    vim.lsp.start({ name = "yo", cmd = { "yo", "lsp" } })
  end,
})
```

服务器查找标准库的方式与编译器相同（这里没有 `--std-path`；如果 `yo` 找不到自身旁边的
`std/`，请设置 `YO_STD`）。

## 功能

### 1. 诊断

打开和每次修改时都会发布错误，范围与编译器自身诊断渲染器画下划线的范围完全一致，并带有
诊断的严重级别（`error`、`warning`、`note`、`help`）以及错误码（如 `E0401`）。导入
文件中的错误会显示在导入方文档的顶部，消息中带有位置。

求值器在第一个错误处停止，因此一个文档一次最多显示一个主诊断（加上它的 note）。诊断的
note 与 help 若指向别处 —— 比如失败的 `where` 子句指向标准库、不匹配的另一端 —— 会作为
`relatedInformation` 条目附在主诊断上，Problems 面板将它们显示为可点击的链接，而不是
单独的 0:0 行。

### 2. 悬停信息

将鼠标悬停在标识符上，可以看到它的类型、编译期已知的值以及文档注释：

```
add_one
: fn(x : i32) -> i32
```

在成员访问（`p.x`、`list.len`）上悬停显示的是该成员的类型。泛型实例按书写形式渲染 ——
`ArrayList(i32)`、`Option(String)`、`?(*(T))` —— 绝不会显示内部 id。

### 3. 自动补全

- **导入路径**：在 `import("std/…` 或 `import("./…` 中列出该目录下的模块和子目录。
- **导入列表**：光标位于 `{ … } :: import("mod")` 的花括号内时，列出该模块的导出
  （已经写在列表中的名字除外），无论此刻文档能否解析。
- **点号补全**（`expr.`）：结构体字段、枚举变体、union 字段、模块成员、trait 方法、
  固有方法与泛型 impl 方法，带参数代码片段。类型值接收者同样支持（`Point.`、
  `Option(i32).`）；指针会自动解引用。
- **枚举变体前缀**（在 `=`、`(`、`,`、`{`、`;`、`=>`、`:=` 或 `return` 之后输入
  `.`）：根据类型标注的声明或所在 `match` 的主题推断出期望枚举，列出它的变体。
- **标识符**：文档中已经出现的名字、最内层作用域内可见的一切（`Option`、`Result` 等
  prelude 类型、导入的名字）以及关键字。标识符与导入列表按**前缀**匹配（`Poi` 给出
  `Point`，不会给出 `JoinHandle`）；点号补全同样按前缀。

### 4. 跳转到定义 / 声明 / 实现

**定义**：跳转到变量、函数、类型或导入名字的声明位置（导入的名字会跨文件跳转），
也支持成员：字段访问或结构体字面量标签（`p.x`、`Point(x : …)`）落在 `struct(...)`
中的字段上，变体（`Color.Red`、`.Red` 模式）落在 `enum(...)` 中的变体上，方法
（`p.dist()`、`list.push`）落在声明它的 `impl(...)` 块中的 `label : value` 对上
（固有、trait 或泛型 impl，无论在本文件还是标准库中），`mod.f` 落在被导入模块的
`f ::` 绑定上。

**声明**（`declaration`）应答的内容与定义完全相同 —— yo 的绑定只有一个位置，没有
独立的头文件形态 —— 因此把“跳转到声明”单独映射的编辑器也能正常工作。

**实现**（`textDocument/implementation`）列出光标下的类型或 trait 在本文件中的
`impl(...)` 块：trait 名给出文件中它的每个 impl，类型名给出它的固有 impl 和 trait
impl（目前与引用、重命名一样限于同一文件）。

### 5. 文档符号

每个顶层 `name :: value` 绑定，按值的形状分类（函数、结构体、枚举、trait、impl、
常量），以及 `(name : T) = value`、`name := value;`、`thread_local(name) := init;`
这些声明形式（列为变量）。文档存在求值错误时依然可用。未声明
`hierarchicalDocumentSymbolSupport` 的客户端收到的是扁平的 `SymbolInformation[]`
而不是层级形式。

### 6. 查找引用与重命名

两者都跟随光标下的**绑定**，而不是拼写：重命名局部变量 `x` 不会触及结构体字段 `x`、
`Point(x : …)` 中的标签或 `p.x` 这个访问。在尚未被特化的 `generic(...)` 函数体内，
出现位置按名字匹配（求值器还没有访问过它们）。引用与重命名限于同一文件。

`context.includeDeclaration` 会被遵守（即使在声明本身上发起请求 —— 在定义上右键 ——
为 false 时同样会去掉声明）。重命名先验证新名字：不是合法绑定名的标识符、关键字、
编译器内建保留名会被拒绝，并在重命名框中给出原因，而不是把坏文本拼进缓冲区；
`prepareRename` 只在真正可重命名的符号上作答。

### 7. 签名帮助

在调用中输入 `(` 或 `,` 之后，显示被调用函数的参数并高亮当前参数。

### 8. 折叠范围

多行的 `{ … }` / `( … )` 区域以及多行块注释。

### 9. 格式化

通过 `yo fmt` 的格式化器进行整文档格式化。无法解析的文档保持不变。VS Code 扩展默认为
`.yo` 文件开启保存时格式化。

### 10. 代码操作（快速修复）

`textDocument/codeAction` 对所请求行上每个携带编译器 `Repair` 的诊断回答一个
`quickfix`——即 `yo fix` 应用的那个唯一机械修复（重命名为唯一接近的候选、补上缺失的
std 导入行、在 `}` 前插入 `;`；见 `ERROR_DIAGNOSTICS.md`）。该操作的编辑与命令行
逐字节一致，因此编辑器与 `yo fix` 永不分歧。消息中列出两种可能修法的诊断不携带
修复，也就没有操作。

### 11. 文档高亮

选中一个标识符时高亮它的**绑定**在文件中的全部出现位置 —— 声明处按写入高亮，使用处
按普通文本高亮；成员与标签不高亮（与引用、重命名使用同一身份规则）。

### 12. 跳转到类型定义

在一个值上，跳转到它的类型的声明（`p := Point(…)` 中的 `p` 落在
`Point :: struct(…)` 上；实例化的泛型落在它的绑定上，按书写形式显示 ——
`ArrayList(usize)` 跳转到 `ArrayList`）。标签、函数类型的名字和原始类型不作答。

### 13. 工作区符号

`workspace/symbol` 搜索每个**已打开**文档的顶层符号（大小写不敏感的子串匹配；空查询
列出全部）。未打开的文件不在索引内 —— 跨模块搜索需要先做索引形态的决策。

### 14. 文档链接

`textDocument/documentLink` 把每个 `import("path")` 字符串字面量变成指向其所命名
文件的链接 —— `std/…` 路径经由标准库解析，`./…`/`../…` 路径经由导入文档所在目录。
只应答目标确实存在的链接；依赖包名（由编译器经由最近的 manifest 解析）不携带链接。

### 15. 语义 token

`textDocument/semanticTokens/full` 提供 TextMate 语法无法企及的着色：关键字、字符串、
数字和注释来自词法分析，标识符由分析分类 —— 类型、函数、普通变量，结构体字段 /
标签 / 变体作为属性。当前分析无法分类的标识符保留回退着色，而不是猜测。位置和长度
使用协商的位置编码；跨行的 token（块注释）按行拆成多段发出。

## 编辑过程中的行为

大多数按键都会让文档暂时无法解析。服务器为每个文档保留**最近一次成功解析**的分析结果，
供悬停、补全、符号、引用和重命名使用，因此这些功能在编辑途中仍然可用；位置会按 token
与当前文本匹配，所以过期的分析只在二者仍然一致的地方作答。能解析但求值失败的文档会保留
完整程序以及求值器在出错前记录的所有类型。

对已打开的被导入文件的修改，会在下一次分析任何导入它的文档时生效（服务器把打开的缓冲区
叠加到模块加载器上，并使依赖它的模块失效）。在编辑器**之外**修改被导入文件时，修改以
`workspace/didChangeWatchedFiles` 到达（编辑器会监视工作区）：该模块从缓存中清除，
每个已打开的文档被重新分析 —— VS Code 扩展监视 `**/*.yo`。修改 `std/prelude.yo`
仍需重启服务器（prelude 环境只缓存一次）。

## 位置编码

编译器的列以 Unicode 标量值计数（每个 rune 一列）。在 `initialize` 时服务器根据客户端
在 `general.positionEncodings` 中列出的编码协商线上编码：列出 `utf-32` 就选它
（服务器的原生单位，不做任何转换），否则 `utf-16`（协议默认），再否则 `utf-8` ——
绝不会应答客户端没有提供的编码。在 `utf-16` 或 `utf-8` 下，服务器发送和接收的每一列
都会被转换 —— emoji 等辅助平面字符占两个 UTF-16 单元、一个 rune（最多四个 UTF-8
字节）。

## 协议行为

服务器遵循 JSON-RPC 2.0 / LSP 3.17 生命周期：`initialize` 之前的请求以
`ServerNotInitialized` 拒绝，第二次 `initialize` 与 `shutdown` 之后的任何请求以
`InvalidRequest` 拒绝，未知的 `$/` 请求以 `MethodNotFound` 应答（供客户端探测能力），
`$/` 通知被忽略；无法解析的报文以 `-32700`、null id 应答。`exit` 终止进程 —— 先
`shutdown` 过则退出码为 0，否则为 1。

## 源码布局

| 文件                          | 提供                                            |
| ----------------------------- | ----------------------------------------------- |
| `src/lsp/server.yo`           | JSON-RPC 分发、`initialize`、文档同步             |
| `src/lsp/transport.yo`        | stdio 上的 `Content-Length` 帧                    |
| `src/lsp/protocol.yo`         | JSON 构造器、位置编码、`file:` URI                 |
| `src/lsp/diagnostics.yo`      | 文档分析与 `publishDiagnostics`；诊断携带 `textDocument/codeAction`（在 `server.yo`）所提供的 `Repair` |
| `src/lsp/hover.yo`            | 悬停、共享的 token/候选辅助函数、原子角色           |
| `src/lsp/completion.yo`       | `textDocument/completion`                        |
| `src/lsp/definition.yo`       | `textDocument/definition`、`typeDefinition`、`declaration` 与 `documentLink` |
| `src/lsp/references.yo`       | `textDocument/references`、`documentHighlight` 与出现位置遍历 |
| `src/lsp/rename.yo`           | `textDocument/rename` 与 `prepareRename`          |
| `src/lsp/symbols.yo`          | `textDocument/documentSymbol`、`workspace/symbol` 与 `implementation` |
| `src/lsp/signature_help.yo`   | `textDocument/signatureHelp`                     |
| `src/lsp/folding.yo`          | `textDocument/foldingRange` 与 `semanticTokens`  |

## 测试

服务器的测试方式与编辑器驱动它的方式完全一致：`tests/cli-cases/` 下的 `lsp-*` 用例通过
stdin 向 `yo lsp` 输入带帧的 JSON-RPC，并把带帧的回复与记录的 golden 比较
（`scripts/cli-diff-test.sh`）—— 同时断言**原始**流的帧严格是
`Content-Length: N` + 精确 `CRLF CRLF` + N 字节正文（每个用例 `opts` 里的
`framing=strict`），正是曾让所有 Windows 客户端失效的那一类问题。
`scripts/lsp-strict-handshake.py` 对任意 `yo` 二进制驱动同样的严格会话，并在发布
工作流的 Windows bundle 冒烟环节运行。纯函数辅助（URI 转换、位置编码）和分析状态
保证由 `tests/internal/lsp_protocol.test.yo` 覆盖；模块失效由
`tests/internal/module_invalidation.test.yo` 覆盖。
