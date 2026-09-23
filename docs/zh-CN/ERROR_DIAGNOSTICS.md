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

命中已知家族的消息会在头部携带稳定的 `EXXXX` 错误码，并在 `help:` 尾行指向解释器。错误码是集中管理的：编译器将自身的消息词汇分类到各家族，因此同一个底层错误无论由哪个阶段报告，得到的错误码都相同。

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

## 诊断出现的位置

- `yo check`、`yo compile`、`yo build`、`yo test`、`yo install` —— 每个 CLI 出口都按所选格式、且只打印一次每条诊断。
- `yo lsp` —— 语言服务器通过结构化通道接收诊断（精确区间，无需重新解析文本），即使错误源于被导入的文件，编辑器也能得到精确的波浪线。
- 运行时 panic 携带调用点位置后缀：`panic: <message> (at file://…/app.yo:3:17)`。

## 退出码

任何格式下，错误退出码为 `1`，成功为 `0`。机器使用方应以退出码判断结果、以 JSON 输出获取细节，而不是解析正文。
