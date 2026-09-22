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
API 发现是这个命令的查询半边。

## 用法

```bash
yo context                                  # 上下文包（语言指南）
yo context --list                           # 内置 std 的模块索引
yo context --list --path <dir>              # 改为索引任意目录树
yo context --list --refresh                 # 强制重建索引
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

## 描述：模块与条目

`yo context <module>` 输出模块的单屏索引；追加条目名则输出该条目的完整
内容（签名、文档、示例——从渲染好的模块页中切出）：

```bash
yo context collections/array_list              # 模块索引
yo context collections/array_list ArrayList.push   # 单个条目（Type.method 或裸名）
yo context ArrayList.push                      # 全语料唯一时直接命中
yo context push                                # 有歧义 -> 列出候选，退出码 1
```

模块参数接受完整语料路径（`std/collections/array_list`）或唯一的末段
（`array_list`）；有歧义的末段会列出候选并以退出码 1 结束，未命中时
最多给出三个 did-you-mean 建议。


## `--list`：API 索引

`yo context --list` 会为内置 std（175 个模块、约 2,069 个条目）建索引，
每个模块输出一行——模块文档首行与条目数：

```text
std/allocator  Memory allocation abstractions and global allocator interface. (5 items)
std/assert     Runtime assertion and panic functions. (5 items)
...
— 175 modules; yo context <module> for its items
```

索引按 std 版本一次性建入内容寻址缓存——`$YO_CONTEXT_CACHE` 或全局
yo 缓存（`yo cache path`）下的 `context/<key>/`，其中 key 是所有被索引
文件「路径 + 内容哈希」的摘要。冷构建相当于对整棵树做一次 `yo doc`
级别的求值（内置 std 约 28 秒）；之后的每次查询都以毫秒级读缓存。
`yo cache gc` 会整体清扫 `context/` 缓存——它是纯缓存，按需重建。

`--path <dir>` 改为索引任意目录树（相对路径按工作目录解析）；模块名
以该目录名作为前缀。求值器无法加载的模块回退到仅词法的 token-only
文档，并在输出中标注 `(untyped)`——降级必有标记，绝不静默。

逐模块、逐条目的视图与全文搜索是后续阶段（`plans/YO_CONTEXT.md`
C3–C5）：`yo context <module> [name]` 与 `yo context --search <query>`。
