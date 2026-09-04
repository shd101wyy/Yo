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

`--json-summary`（由 test/check 驱动接受）额外把最终的 `N passed / M failed` 式页脚输出为一行机器可读的摘要，测试工具无需抓取正文即可解析结果。

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

- `yo check`、`yo compile`、`yo build`、`yo test`、`yo fetch` —— 每个 CLI 出口都按所选格式、且只打印一次每条诊断。
- `yo lsp` —— 语言服务器通过结构化通道接收诊断（精确区间，无需重新解析文本），即使错误源于被导入的文件，编辑器也能得到精确的波浪线。
- 运行时 panic 携带调用点位置后缀：`panic: <message> (at file://…/app.yo:3:17)`。

## 退出码

任何格式下，错误退出码为 `1`，成功为 `0`。机器使用方应以退出码判断结果、以 JSON 输出获取细节，而不是解析正文。
