# `yo context` 命令

`yo context` 输出**代理上下文包**（agent context pack）：随 `yo` 二进制
发行版捆绑的、经过策展的纯语言指南。它面向 AI 编码代理——模型预训练中
没有 Yo——但作为人类的最快入门也同样好用。

## 上下文包包含什么

上下文包是一个 Markdown 文件，硬上限 24 KB，确保能放进任何模型的上下文
窗口。它只讲**语言事实**：

- 声明形式与花括号规则（`{ ... }` 组除非含 `;` 否则是记录字面量），
- 无优先级规则（所有中缀表达式都要加括号），
- 控制流（`cond`、`match`、`if`）、模式匹配、trait、impl、derive，
- 所有权与失败处理（`Option`/`Result`/异常）、异步与代数效应，
- 工具链循环（每次编辑后 `yo check`、`yo test`、`yo fmt`）。

它刻意**不含 API 列表**——API 每个版本都在变，上下文包不能跟着漂移。
API 发现交给 `yo doc`（渲染的文档）和 LSP；从 v0.2.40 起，`yo context`
命令族会逐步长出基于生成的 std 索引的查询模式（`plans/YO_CONTEXT.md`
的 C2–C5 阶段）。

## 用法

```bash
yo context
```

输出的第一行是引用头，标明工具链版本与上下文包修订号，便于代理引用
它读到的内容：

```text
yo 0.2.40 — pack-version: 1
# Yo — context pack for coding agents
...
```

## 上下文包的查找位置

查找顺序与 `yo skills install` 相同：

1. `$YO_CONTEXT_PACK`——显式指向 `context.md` 文件或其 `pack` 目录。
   **该变量具有决定性**：一旦设置，它就是唯一查找对象——值无效时直接
   报错，绝不静默回退（CI 中很有用，cli-cases 也是这样固定的）；
2. 从可执行文件向上逐级查找——发行包解压后是 `bin/yo` + `std/` +
   `pack/` 的兄弟结构，安装好的工具链总能找到自己的包；
3. 从工作目录向上逐级查找——在 Yo 检出内运行已安装的 `yo`，会找到
   检出自身的 `pack/`。

都找不到（打包损坏）时，命令会列出尝试过的位置并以退出码 1 结束。

上下文包的唯一事实来源是编译器树中的 `pack/context.md`；release
工作流会把它复制进每个发行包，且包的冒烟测试会在检出之外断言
`yo context` 能正常应答。
