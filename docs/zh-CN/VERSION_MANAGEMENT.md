# 版本管理

Yo 支持通过 `.yo-version` 文件实现项目级别的版本固定，类似于 `.nvmrc`（Node.js）或 `.python-version`（Python）。这确保了团队间构建的可重复性和 IDE 行为的一致性。

## 快速开始

```bash
# 将项目固定到当前 Yo 版本
yo version pin

# 固定到特定版本
yo version pin 0.1.12

# 显示当前版本和固定版本
yo version

# 安装特定版本（不固定）
yo version install 0.1.13

# 列出本地缓存的版本
yo version list

# 列出 npm 上所有可用版本
yo version list --remote
```

## `.yo-version` 文件

`.yo-version` 文件包含一行 semver 版本号：

```
0.1.14
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
Yo 0.1.14
.yo-version: 0.1.12 (current: 0.1.14)
```

### `yo version pin [version]`

创建或更新 `.yo-version` 文件。不带版本参数时，固定到当前安装的版本：

```bash
yo version pin           # 固定到当前版本（如 0.1.14）
yo version pin 0.1.12    # 固定到特定版本
```

指定的版本会在写入前通过 npm 注册表验证。

### `yo version install <version>`

下载并缓存特定版本，不进行固定：

```bash
yo version install 0.1.13
```

这对于在切换项目前预获取版本很有用。

### `yo version list [--remote]`

列出缓存的版本：

```
$ yo version list
Cached versions:
  0.1.12
  0.1.13
```

使用 `--remote` 列出 npm 上所有可用版本：

```
$ yo version list --remote
Available versions:
  0.0.2
  0.0.3
  ...
  0.1.14
```

### `yo version clean [version]`

删除缓存的版本：

```bash
yo version clean 0.1.12   # 删除特定版本
yo version clean           # 删除所有缓存版本
```

## `yo init` 集成

使用 `yo init` 创建新项目时，会自动生成固定到当前 Yo 版本的 `.yo-version` 文件：

```bash
$ yo init my-project
Created:
  my-project/
  my-project/build.yo
  my-project/.gitignore
  my-project/.yo-version    ← 自动创建
  my-project/README.md
  my-project/src/
  my-project/src/main.yo
```

## LSP 集成

Yo LSP 服务器会读取 `.yo-version` 来解析正确的 `std/` 标准库路径。当你的项目固定到特定版本且该版本已在本地缓存时，LSP 会使用缓存版本的标准库来提供：

- **跳转到定义** — 跳转到正确版本的 `std/` 文件
- **悬停信息** — 显示固定版本标准库中的类型
- **补全** — 建议固定版本中的符号

这确保了你的 IDE 体验与项目实际使用的版本一致。

## 版本缓存

下载的版本存储在全局 Yo 缓存目录中：

```
~/.cache/yo/versions/
├── 0.1.12/
│   ├── out/cjs/yo-cli.cjs
│   ├── std/
│   ├── vendor/
│   └── package.json
└── 0.1.13/
    ├── out/cjs/yo-cli.cjs
    ├── std/
    ├── vendor/
    └── package.json
```

缓存位置可通过环境变量自定义：

- `$YO_CACHE_DIR` — 设置自定义缓存根目录
- `$XDG_CACHE_HOME` — 遵循 XDG 规范（默认：`~/.cache`）

## 注意事项

- `.yo-version` 中**不支持** `latest` 关键字，请始终使用具体的版本号。
- `yo version`、`yo lsp`、`--help` 和 `--version` 命令会跳过版本调度。
- 版本从 [`@shd101wyy/yo`](https://www.npmjs.com/package/@shd101wyy/yo) npm 包下载。
- 下载需要系统上安装 Node.js 或 Bun。
