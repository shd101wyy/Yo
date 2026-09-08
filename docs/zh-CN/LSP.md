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

求值器在第一个错误处停止，因此一个文档一次最多显示一个主诊断（加上它的 note）。

### 2. 悬停信息

将鼠标悬停在标识符上，可以看到它的类型、编译期已知的值以及文档注释：

```
add_one
: fn(x : i32) -> i32
```

在成员访问（`p.x`、`list.len`）上悬停显示的是该成员的类型。

### 3. 自动补全

- **导入路径**：在 `import("std/…` 或 `import("./…` 中列出该目录下的模块和子目录。
- **点号补全**（`expr.`）：结构体字段、枚举变体、union 字段、模块成员、trait 方法、
  固有方法与泛型 impl 方法，带参数代码片段。类型值接收者同样支持（`Point.`、
  `Option(i32).`）；指针会自动解引用。
- **枚举变体前缀**（在 `=`、`(`、`,`、`{`、`;`、`=>`、`:=` 或 `return` 之后输入
  `.`）：根据类型标注的声明或所在 `match` 的主题推断出期望枚举，列出它的变体。
- **标识符**：文档中已经出现的名字、最内层作用域内可见的一切（`Option`、`Result` 等
  prelude 类型、导入的名字）以及关键字。

### 4. 跳转到定义

跳转到变量、函数、类型或导入名字的声明位置 —— 导入的名字会跨文件跳转。成员名和标签
（`p.x`、`Point(x : 1)`）目前没有定义目标。

### 5. 文档符号

每个顶层 `name :: value` 绑定，按值的形状分类（函数、结构体、枚举、trait、impl、
常量）。文档存在求值错误时依然可用。

### 6. 查找引用与重命名

两者都跟随光标下的**绑定**，而不是拼写：重命名局部变量 `x` 不会触及结构体字段 `x`、
`Point(x : …)` 中的标签或 `p.x` 这个访问。在尚未被特化的 `generic(...)` 函数体内，
出现位置按名字匹配（求值器还没有访问过它们）。引用与重命名限于同一文件。

### 7. 签名帮助

在调用中输入 `(` 或 `,` 之后，显示被调用函数的参数并高亮当前参数。

### 8. 折叠范围

多行的 `{ … }` / `( … )` 区域以及多行块注释。

### 9. 格式化

通过 `yo fmt` 的格式化器进行整文档格式化。无法解析的文档保持不变。VS Code 扩展默认为
`.yo` 文件开启保存时格式化。

## 编辑过程中的行为

大多数按键都会让文档暂时无法解析。服务器为每个文档保留**最近一次成功解析**的分析结果，
供悬停、补全、符号、引用和重命名使用，因此这些功能在编辑途中仍然可用；位置会按 token
与当前文本匹配，所以过期的分析只在二者仍然一致的地方作答。能解析但求值失败的文档会保留
完整程序以及求值器在出错前记录的所有类型。

对已打开的被导入文件的修改，会在下一次分析任何导入它的文档时生效（服务器把打开的缓冲区
叠加到模块加载器上，并使依赖它的模块失效）。在编辑器**之外**修改被导入文件，或者修改
`std/prelude.yo`，需要重启服务器。

## 位置编码

编译器的列以 Unicode 标量值计数（每个 rune 一列）。在 `initialize` 时服务器协商线上
编码：如果客户端在 `general.positionEncodings` 中列出了 `utf-32`，服务器就选择它，列
原样传递；否则使用协议默认的 `utf-16`，并转换它发送和接收的每一列 —— emoji 等辅助平面
字符占两个 UTF-16 单元、一个 rune。

## 源码布局

| 文件                          | 提供                                            |
| ----------------------------- | ----------------------------------------------- |
| `src/lsp/server.yo`           | JSON-RPC 分发、`initialize`、文档同步             |
| `src/lsp/transport.yo`        | stdio 上的 `Content-Length` 帧                    |
| `src/lsp/protocol.yo`         | JSON 构造器、位置编码、`file:` URI                 |
| `src/lsp/diagnostics.yo`      | 文档分析与 `publishDiagnostics`                   |
| `src/lsp/hover.yo`            | 悬停、共享的 token/候选辅助函数、原子角色           |
| `src/lsp/completion.yo`       | `textDocument/completion`                        |
| `src/lsp/definition.yo`       | `textDocument/definition`                        |
| `src/lsp/references.yo`       | `textDocument/references` 与出现位置遍历           |
| `src/lsp/rename.yo`           | `textDocument/rename`                            |
| `src/lsp/symbols.yo`          | `textDocument/documentSymbol`                    |
| `src/lsp/signature_help.yo`   | `textDocument/signatureHelp`                     |
| `src/lsp/folding.yo`          | `textDocument/foldingRange`                      |

## 测试

服务器的测试方式与编辑器驱动它的方式完全一致：`tests/cli-cases/` 下的 `lsp-*` 用例通过
stdin 向 `yo lsp` 输入带帧的 JSON-RPC，并把带帧的回复与记录的 golden 比较
（`scripts/cli-diff-test.sh`）。纯函数辅助（URI 转换、位置编码）和分析状态保证由
`tests/internal/lsp_protocol.test.yo` 覆盖；模块失效由
`tests/internal/module_invalidation.test.yo` 覆盖。
