# 版本管理

Yo 支持通过 `.yo-version` 文件实现项目级别的版本固定，类似于 `.nvmrc`（Node.js）或 `.python-version`（Python）。这确保了团队间构建的可重复性和 IDE 行为的一致性。

## 快速开始

```bash
# 将项目固定到当前 Yo 版本
yo version pin

# 固定到特定版本
yo version pin 0.2.4

# 显示当前版本和固定版本
yo version

# 安装特定版本（不固定）
yo version install 0.2.9

# 列出本地缓存的版本
yo version list

# 列出所有已发布的版本
yo version list --remote
```

## `.yo-version` 文件

`.yo-version` 文件包含一行 semver 版本号：

```
0.2.9
```

`v` 前缀是可选的，会被自动去除：

```
v0.1.14
```

### 文件查找

当你运行任何 `yo` 命令时，CLI 会从当前工作目录开始向上查找 `.yo-version` 文件——与 `.nvmrc` 或 `.python-version` 的行为相同。找到的第一个文件将被使用。

```
my-project/
├── .yo-version      ← 在这里找到
├── build.yo
├── src/
│   └── main.yo      ← 从这里运行 `yo compile src/main.yo`
└── tests/
    └── test.test.yo
```

### 自动版本调度

当 `.yo-version` 文件指定的版本与当前安装的版本不同时，`yo` CLI 会自动：

1. 下载并缓存指定版本（如果尚未缓存）
2. 将命令重新调度到缓存的版本

这一切是透明进行的——你不需要手动切换版本。

## 命令

### `yo version`

显示当前 Yo 版本和固定版本：

```
$ yo version
Yo 0.2.9
.yo-version: 0.2.4 (current: 0.2.9)
```

### `yo version pin [version]`

创建或更新 `.yo-version` 文件。不带版本参数时，固定到当前安装的版本：

```bash
yo version pin           # 固定到当前版本（如 0.2.9）
yo version pin 0.2.4    # 固定到特定版本
```

指定的版本会在写入前通过已发布的 GitHub Releases 验证。

### `yo version install <version>`

下载并缓存特定版本，不进行固定：

```bash
yo version install 0.2.9
```

这对于在切换项目前预获取版本很有用。

### `yo version list [--remote]`

列出缓存的版本：

```
$ yo version list
Cached versions:
  0.2.4
  0.2.9
```

使用 `--remote` 列出 GitHub Releases 上发布的所有版本：

```
$ yo version list --remote
Available versions:
  0.0.2
  0.0.3
  ...
  0.2.9
```

### `yo version clean [version]`

删除缓存的版本：

```bash
yo version clean 0.2.4   # 删除特定版本
yo version clean           # 删除所有缓存版本
```

## `yo init` 集成

使用 `yo init` 创建的新项目默认**不**包含 `.yo-version` 文件。初始化后如需固定版本：

```bash
yo init my-project
cd my-project
yo version pin
```

## LSP 集成

Yo LSP 服务器过去会读取 `.yo-version` 来解析正确的 `std/` 标准库路径，从而让跳转到定义、悬停信息和补全都来自项目实际固定的那个版本。

**目前没有 LSP 服务器。** 它是一个 TypeScript 程序，已经随 TypeScript 编译器一起被删除；等到 Yo 原生的服务器出现时，这套 `.yo-version` 解析也会回来。详见 [LSP.md](./LSP.md)。

## 版本缓存

下载的版本存储在全局 Yo 缓存目录中，每一个都是该版本原生发布包的直接解压结果 —— 与 `scripts/install.sh` 安装出来的布局完全一致：

```
~/.cache/yo/versions/
├── 0.2.4/
│   ├── bin/yo
│   ├── std/
│   ├── vendor/
│   └── LICENSE.md
└── 0.2.9/
    ├── bin/yo
    ├── std/
    ├── vendor/
    └── LICENSE.md
```

`vendor/` 必须与 `std/` 保持同级 —— 二进制文件通过从可执行文件向上查找来定位标准库，并按 `<std>/../vendor` 定位 mimalloc。

缓存位置可通过环境变量自定义：

- `$YO_CACHE_DIR` — 设置自定义缓存根目录
- `$XDG_CACHE_HOME` — 遵循 XDG 规范（默认：`~/.cache`）

## 注意事项

- `.yo-version` 中**不支持** `latest` 关键字，请始终使用具体的版本号。
- `yo version` 子命令以及 `--help` / `--version` 会跳过版本调度。
- 版本以对应宿主平台的原生发布包形式从 [GitHub Releases](https://github.com/shd101wyy/Yo/releases) 下载。设置 `$YO_REPO` 可以指向某个 fork。
- 早于 `0.2.1` 的版本发布于原生包之前，已经无法安装 —— npm 发布在 `0.2.0` 之后就停止了，该渠道已废弃。
- 下载需要 `PATH` 中有 `tar`。从 v0.2.22 起，HTTP 请求由编译器通过 `std/http` 和编译器内置生成的 TLS 后端直接完成 —— 不再依赖 `curl`（此前的每个版本都是 shell-out 调用 curl）。**Windows 通过 Schannel（SSPI）支持 TLS**，它随操作系统提供，无需安装任何东西。在没有 OpenSSL 的 unix 机器上，远程子命令会报告 `TLS is unavailable in this build` 并给出安装指引（`brew install openssl@3`，或发行版的 `libssl-dev`）。**不再需要** Node.js 或 Bun —— 只有当年 Yo 以 npm 包形式发布时才需要它们。
