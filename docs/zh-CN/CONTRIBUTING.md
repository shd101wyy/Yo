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

没有包管理器的安装步骤。唯一的第三方依赖是 git 子模块：

```bash
$ git submodule update --init --recursive
```

对编译器源码做类型检查（只跑求值器，不生成代码 —— 这是最快的迭代循环）：

```bash
$ yo check ./src
```

从源码构建编译器。务必加上 `--optimize 2`：在 `-O0` 下，求值器中那些大函数的栈帧有好几
兆字节，编译期的深度递归会耗尽栈空间。

```bash
$ yo compile src/main.yo --optimize 2 -o /tmp/yo-self-bin
```

> 没有监视重建的循环 —— 改动之后重新运行上面的 `yo compile`。

用刚构建出来的编译器试跑一个临时程序（`./tmp/` 已被 gitignore —— 请把一次性的 `.yo`
文件放在那里）：

```bash
$ /tmp/yo-self-bin compile ./tmp/fixme.yo --optimize 2 -o /tmp/fixme && /tmp/fixme
```

用 `yo test` 运行测试套件：

```bash
$ yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail
$ yo test ./tests/internal --parallel 1   # 编译器自身的测试
```

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
