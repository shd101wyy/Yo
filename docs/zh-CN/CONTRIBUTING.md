# 为 Yo 做贡献

`Yo` 编译器是**自举**的：它用 Yo 自身编写，代码位于 [`src/`](../../src/)。
构建它需要一个已经安装好的 `yo` 二进制（可以用[安装脚本](./README.md#安装脚本推荐)获取）以及一个
C 编译器。

Yo 主要在 Steam Deck LCD（Linux）上开发。编译器目前将 Yo 转换为 C；要生成机器码，你必须有一个 C 编译器（例如 `gcc`、`clang`、`zig`、`emcc` 等）。

请继续之前安装 [nix](https://nixos.org/download.html) 和 [direnv](https://direnv.net/)。

开发环境定义在 [shell.nix](../../shell.nix) 中。你也可以手动安装文件中列出的依赖项。

## 环境设置

```bash
$ cd Yo
$ direnv allow . # 运行此命令激活 nix shell。
                  # 只需运行一次。
```

唯一以 vendor 形式引入的依赖是 git 子模块 `vendor/mimalloc`：

```bash
$ git submodule update --init --recursive
```

编译器唯一的 Yo 依赖 `markdown_yo`（`yo doc --format html` 背后的 Markdown
渲染器）声明在仓库根目录的 `yo.toml` 里，由 Yo 自己的包管理器抓取：

```bash
$ yo install
```

对编译器源码做类型检查（只跑求值器，不生成代码）。在运行任何更耗时的命令之前，先跑这一步：

```bash
$ yo check ./src
```

需要反复修改时，让一个检查器常驻，而不是每次冷启动重新检查；它只会重新检查你改动过的定义：

```bash
$ yo check ./src --watch
```

`check` 不经过代码生成，所以看不到在代码生成阶段才执行的异步状态机规则。改动异步代码时，
还要跑一遍编译的前半段（约 3 分钟）：

```bash
$ yo compile src/main.yo --skip-c-compiler
```

用编译器自己的构建文件 [`build.yo`](../../build.yo) 从源码构建编译器，产物位于
`yo-out/<target>/bin/yo`：

```bash
$ yo build --std-path ./std
```

`--std-path ./std` 让构建使用本仓库中的标准库；不加它时，已安装的 `yo` 会使用它自带的标准库。
`build.yo` 已经使用 `--optimize 2` 构建；手动编译编译器时也要保持这一设置。在 `-O0` 下，
求值器中那些大函数的栈帧有好几兆字节，编译期的深度递归会耗尽栈空间。（`--release` 已被移除，
它就等同于 `--optimize 2`。）在 v0.2.43 或更新的 `yo` 下，这一步在 8 GB 内存的机器上即可完成
（峰值约 4.3 GiB，包含 C 编译器）。`yo build --watch` 会在每次改动后于进程内重新构建。

用刚构建出来的编译器试跑一个临时程序（`./tmp/` 已被 gitignore —— 请把一次性的 `.yo`
文件放在那里）：

```bash
$ yo-out/<target>/bin/yo compile ./tmp/fixme.yo --optimize 2 -o /tmp/fixme && /tmp/fixme
```

用 `yo test` 运行测试套件：

```bash
# 快速语言测试套件（即 `yo build test` 运行的内容）。两个 exclude 都不能少。
$ yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail
# 标准库自身的测试。
$ yo test ./std --bail
# 编译器自身的测试。其中每个文件都会编译一次整个编译器，所以请逐个文件运行；
# 整个目录要跑一个多小时。
$ yo test ./tests/internal/parser.test.yo --parallel 1
```

提交 PR 之前：

- 对你新建或修改的每个 `.yo` 文件运行 `yo fmt`（`yo fmt --check` 可用于验证；仓库没有
  pre-commit 钩子）；
- 你修复的每个 bug 都要在 [`issues/`](../../issues/) 中留下记录，并在 `tests/` 中加一个
  修复前失败、修复后通过的测试；
- 用户文档要同时写在 [`docs/en-US/`](../en-US/) 和 [`docs/zh-CN/`](./) 中。

## 欢迎 LLM 与 AI Agent 的贡献

**Yo 的设计目标之一就是让语言模型来编写**，因此我们欢迎借助 LLM 完成的贡献，而不只是
勉强接受。无需声明，也没有单独的评审流程。

我们的要求和对任何贡献者一样：**理解你提交的改动，并验证它。** 一个没人能解释的补丁
就是问题，无论作者是人还是模型。提交 PR 之前请：

- 运行 `yo check ./src` —— 只跑求值器的快速循环；
- 运行覆盖你所改动部分的测试（见下文），不要只跑最快的那些；
- 在 PR 描述中写清楚你实际运行了什么，包括失败的和跳过的部分。

仓库本身已经为此做好准备：[`AGENTS.md`](../../AGENTS.md) 是 agent 应当最先阅读的入口；
`.github/instructions/` 存放各领域的规则（C 代码生成、调试、测试、语言设计、语法）；
`.github/skills/` 提供可复用的技能包。保持这些文档的准确本身就是有价值的贡献 —— 如果
你在 Yo 上踩过坑并学到了什么，请把它写进去。

## 贡献的许可

Yo 采用 [Apache License 2.0 with LLVM Exceptions](../../LICENSE.md)
（`Apache-2.0 WITH LLVM-exception`）授权。贡献同样以该许可证接受——提交 Pull
Request 即表示你同意你的贡献可以在该许可证下分发。

无需签署 CLA，你的贡献的著作权仍归你所有。取而代之的是「开发者原创声明」
（Developer Certificate of Origin）签名：请在每个提交中加入 `Signed-off-by`
一行，使用 `git commit -s` 即可自动添加。

```
Signed-off-by: Your Name <your.email@example.com>
```

这一行表示你撰写了该补丁，或以其他方式有权以本项目的许可证提交它——完整文本见
<https://developercertificate.org/>。它的作用是让项目的来源仅凭 git 历史即可核
查，从而使将来的许可证决定无需逐一联系每位贡献者。

如果你在使用 AI Agent，请以你本人的名义签名：该声明关乎你提交这份工作的权利，
而非由谁或由什么键入。
