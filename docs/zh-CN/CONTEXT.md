# `yo context` 命令

`yo context` 是面向 AI 代理的上下文入口。不带参数时，它输出**上下文包**：随
`yo` 工具链发布的、经过精选的纯语言指南。带查询时，它查找 **API**：随发行版
标准库、任意目录以及项目依赖中的模块和条目。它为 AI 编程代理而写（这些代理的
预训练数据中没有 Yo），同时也是人快速上手的最佳入口。

```bash
yo context                                   # 上下文包（语言指南）
yo context --list                            # 列出全部标准库模块，每行一个
yo context collections/array_list            # 某个模块的条目
yo context collections/array_list ArrayList.push   # 某个条目的完整说明
yo context push                              # 在整个语料中查找一个名字
yo context --search hash                     # 排序搜索
```

## 上下文包

上下文包是一个 markdown 文件，大小上限为 24 KB，可以放进任何模型的上下文窗口。
它**只讲语言本身**：

- 声明形式与花括号规则（`{ ... }` 在没有 `;` 时是记录字面量），
- 无运算符优先级的规则（每个中缀链都要加括号），
- 控制流（`cond`、`match`、`if`）、模式匹配、trait、impl、derive，
- 所有权、失败处理（`Option`/`Result`/异常）、异步与效应，
- 工具链循环（每次编辑后运行 `yo check`，`yo test`，`yo fmt`）。

它刻意**不包含任何 API 列表**。API 每个版本都在变，上下文包不能随之过时；API
问题由下面的查询直接从工具链中回答。

输出的第一行是引用头，写明工具链版本和上下文包的修订号，方便代理注明它读的是
哪一版：

```text
yo 0.2.40 — pack-version: 1
# Yo — context pack for coding agents
...
```

### 上下文包的查找顺序

1. `$YO_CONTEXT_PACK`：显式指向 `context.md` 文件或它所在的 `pack` 目录。设置
   后它是**权威的**：无效的值直接报错，绝不会悄悄回退到别的上下文包。
2. 可执行文件旁，沿父目录向上查找。发行包解压后是 `bin/yo` + `std/` +
   `pack/`，所以已安装的工具链总能找到自己的上下文包。
3. 工作目录旁，沿父目录向上查找。在 Yo 源码树中运行已安装的 `yo` 时，会找到
   该源码树的 `pack/`。

如果都没有找到，命令会列出查找过的位置并以退出码 2 退出。

## 查询

| 查询                          | 结果                                                   |
| ----------------------------- | ------------------------------------------------------ |
| `yo context --list`           | 全部模块，附文档首行和条目数                           |
| `yo context <module>`         | 该模块的条目，按名字排序：名字、种类、签名             |
| `yo context <module> <name>`  | 某个条目的完整说明：签名、完整文档、示例               |
| `yo context <name>`           | 在整个语料中查找这个名字（见下文）                     |
| `yo context --search <query>` | 在名字、签名和文档首行中进行排序搜索                   |

**模块**参数可以是完整路径（`std/collections/array_list`）、唯一的末段
（`array_list`）或唯一的后缀（`collections/array_list`）。匹配多个模块的参数会
列出这些模块并以退出码 1 退出。

**条目**是一个普通名字，方法则写作 `Type.name`（`ArrayList.push`）。当一个模块
里有多个同名条目（例如两个类型各自的 `new`）时，普通名字会列出它们的限定写法并
以退出码 1 退出。

不是模块的**裸名字**会在整个语料中查找。唯一命中时输出它的完整说明；多个命中时
输出排序后的 `module  name  kind  signature` 列表并以退出码 0 退出，加上
`--verbose` 还会输出前三个命中的完整说明。桶模块重新导出的名字（`std/string`
会重新导出它的子模块）只计一次：说明取自定义它的模块，并附上
`re-exported from` 注记。

**搜索**是基于词法的、确定性的：精确的名字匹配排第一，其次是名字前缀、名字子串、
签名匹配和文档匹配，同分时按模块路径排序。`--deep` 还会匹配每个条目完整文档的
正文。对同一版本的库，同一个查询总是返回相同的结果。

### 未命中与退出码

| 退出码 | 含义                                           |
| ------ | ---------------------------------------------- |
| 0      | 有结果                                         |
| 1      | 未命中，或模块、条目有歧义                     |
| 2      | 用法错误、打包错误，或缺少 `yo install`        |

未命中时，stderr 上最多给出三个“你是否想要”的名字：

```text
yo: error: context: no module or item 'hashmap' in the corpus
  Did you mean: std/collections/hash_map
```

### JSON 输出

`--format json` 适用于所有查询，此时 stdout 上只有一个 JSON 文档（进度信息输出
到 stderr）。每个条目对象都有相同的字段：`module`、`origin`（重新导出时为定义它
的模块，否则为 `""`）、`name`、`kind`、`signature` 和 `doc`。

- `--list`：`{"modules": [{"module", "doc", "items", "degraded"}, ...]}`
- `<module>`：`{"module", "doc", "degraded", "items": [条目, ...]}`
- `<module> <name>`：条目本身，外加 `text`，即它完整渲染后的文档
- `<name>` 与 `--search`：`{"query", "count", "hits": [...]}`；搜索命中会多一个
  `score`
- 未命中：stdout 上输出 `{"error": "...", "suggestions": [...]}`，退出码为 1

## 索引

第一次查询会为语料建立索引：对整个目录树做一次求值，工作量与 `yo doc` 相同（随
发行版的标准库约 28 秒）。之后的查询从缓存读取，只需几毫秒。索引位于全局 yo 缓存
（`yo cache path`）或 `$YO_CONTEXT_CACHE` 下的 `context/<key>/`。键是语料名、
索引格式、工具链版本以及每个被索引文件的路径与内容的摘要，所以修改任何文件或升级
`yo` 都会建立新的索引。`--refresh` 则无条件重建。

`--path <dir>` 为任意目录建立索引，而不是随发行版的标准库；相对路径相对于工作
目录解析，模块名以该目录名为前缀。求值器无法加载的模块会退回到仅基于词法记号的
文档，并标记为 `(untyped)`：降级总会被标出，绝不静默。

`yo cache gc` 会保留当前工具链自身标准库的索引，删除其他所有索引（旧版本、
`--path` 目录、依赖），它们会在需要时重建。构建、查询和 gc 共用一把锁，因此彼此
都不会看到对方做到一半的状态。

## 依赖

```bash
yo install                         # 必须先安装 git 依赖
yo context --deps --list           # 标准库 + 项目 yo.toml 中的依赖
yo context --deps mylib            # 某个依赖模块
yo context --deps --search double
```

`--deps` 会把最近的 `yo.lock` 中的每个包加入语料。git 依赖从内容寻址的存储中读取，
路径依赖直接从其目录读取。它们的模块以依赖的导入名命名（`mylib/util`），也就是你在
`import("mylib/util")` 中写的第一段路径。缺少 `yo.toml`、缺少或无法解析 `yo.lock`，
以及 git 依赖尚未安装，都会报错并说明该运行什么命令（退出码 2）。
