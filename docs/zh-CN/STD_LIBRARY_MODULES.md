# Yo 标准库模块

Yo 标准库提供了一套全面的模块，用于常见的编程任务。所有模块均通过 `import` 或 `open import` 语句导入。

```rust
// 命名导入
{ ArrayList } :: import "std/collections/array_list";

// 开放导入（将所有导出项引入当前作用域）
open import "std/string";
```

当目录名与文件名相同（如 `url/url.yo`）时，使用 `index.yo` 以获得简洁的导入路径：

```rust
// 简洁导入 — 加载 std/url/index.yo
{ Url } :: import "std/url";
{ Regex } :: import "std/regex";
{ fetch, HttpRequest } :: import "std/http";
```

包含多个独立子模块的目录需要显式导入：

```rust
// 显式子模块导入
{ TcpStream } :: import "std/net/tcp";
open import "std/fs/file";
{ toml_parse } :: import "std/encoding/toml";
```

---

## 目录

- [核心模块](#核心模块)
- [字符串](#字符串)
- [集合](#集合)
- [文件系统](#文件系统)
- [网络](#网络)
- [HTTP](#http)
- [编码](#编码)
- [加密](#加密)
- [正则表达式](#正则表达式)
- [命令行参数解析](#命令行参数解析)
- [TOML 解析](#toml-解析)
- [Glob 模式匹配](#glob-模式匹配)
- [IO Trait](#io-trait)
- [URL 解析](#url-解析)
- [时间与时长](#时间与时长)
- [同步原语](#同步原语)
- [并发](#并发)
- [格式化与显示](#格式化与显示)
- [日志](#日志)
- [测试](#测试)
- [操作系统与环境](#操作系统与环境)
- [路径](#路径)
- [构建系统](#构建系统)

---

## 核心模块

### Prelude (`std/prelude`)

自动导入，提供基础类型和 trait：

- **`Option(T)`** — `Some(T)` | `None`。方法：`unwrap`、`is_some`、`is_none`、`map`、`and_then`、`or`、`unwrap_or`。
- **`Result(T, E)`** — `Ok(T)` | `Err(E)`。方法：`unwrap`、`is_ok`、`is_err`、`map`、`map_err`、`and_then`、`or`。
- **`Box(T)`** / **`box(value)`** — 堆分配的装箱值。
- **`Pointer`** — 编译期和运行时指针操作。
- **Trait**：`Eq`、`Ord`、`Hash`、`Runtime`、`Comptime`、`ToString`。

### Error (`std/error`)

- **`AnyErr`** — 使用 `dyn` 实现的类型擦除错误接口。

### Process (`std/process`)

- **`Platform`** — 枚举，包含 `Linux`、`MacOS`、`Windows` 变体。
- **`platform`** — 表示当前构建平台的常量。

---

## 字符串

### String (`std/string`)

```rust
open import "std/string";
```

**`String`** — UTF-8 编码、引用计数的字符串对象。

| 方法            | 签名                                          | 描述                   |
| --------------- | --------------------------------------------- | ---------------------- |
| `new`           | `fn() -> String`                              | 创建空字符串           |
| `from`          | `fn(slice: str) -> String`                    | 从 str 切片创建        |
| `len`           | `fn(self) -> usize`                           | 字符数（Unicode 感知） |
| `is_empty`      | `fn(self) -> bool`                            | 检查是否为空           |
| `at`            | `fn(self, index: usize) -> Option(rune)`      | 获取指定索引处的字符   |
| `concat`        | `fn(self, other: String) -> String`           | 拼接字符串             |
| `substring`     | `fn(self, start, end: usize) -> String`       | 提取子串               |
| `trim`          | `fn(self) -> String`                          | 去除首尾空白           |
| `trim_start`    | `fn(self) -> String`                          | 去除前导空白           |
| `trim_end`      | `fn(self) -> String`                          | 去除尾部空白           |
| `to_lowercase`  | `fn(self) -> String`                          | 转为小写（ASCII）      |
| `to_uppercase`  | `fn(self) -> String`                          | 转为大写（ASCII）      |
| `starts_with`   | `fn(self, prefix: String) -> bool`            | 检查前缀               |
| `ends_with`     | `fn(self, suffix: String) -> bool`            | 检查后缀               |
| `contains`      | `fn(self, substr: String) -> bool`            | 检查是否包含子串       |
| `index_of`      | `fn(self, substr: String) -> Option(usize)`   | 查找首次出现位置       |
| `last_index_of` | `fn(self, substr: String) -> Option(usize)`   | 查找最后出现位置       |
| `replace`       | `fn(self, old, new: String) -> String`        | 替换匹配项             |
| `split`         | `fn(self, sep: String) -> ArrayList(String)`  | 按分隔符拆分           |
| `repeat`        | `fn(self, count: usize) -> String`            | 重复 N 次              |
| `pad_start`     | `fn(self, len: usize, pad: String) -> String` | 从开头填充             |
| `pad_end`       | `fn(self, len: usize, pad: String) -> String` | 从末尾填充             |
| `parse_i32`     | `fn(self) -> Option(i32)`                     | 解析为 i32             |
| `parse_i64`     | `fn(self) -> Option(i64)`                     | 解析为 i64             |
| `parse_u32`     | `fn(self) -> Option(u32)`                     | 解析为 u32             |
| `parse_u64`     | `fn(self) -> Option(u64)`                     | 解析为 u64             |
| `parse_bool`    | `fn(self) -> Option(bool)`                    | 解析 "true"/"false"    |
| `as_bytes`      | `fn(self) -> ArrayList(u8)`                   | 获取字节视图           |
| `as_str`        | `fn(self) -> str`                             | 获取 str 切片          |

已实现的 trait：`Eq`、`Ord`、`Hash`、`ToString`。

**模板字符串**用于创建 `String` 值：`` `hello ${name}` ``

### Rune (`std/string/rune`)

**`rune`** — Unicode 码点（32 位）。方法：`from_u32`、`to_u32`、`is_ascii`、`is_whitespace`、`is_digit`、`is_alphabetic`、`to_lowercase`、`to_uppercase`。

---

## 集合

### ArrayList (`std/collections/array_list`)

```rust
{ ArrayList } :: import "std/collections/array_list";
```

基于可增长缓冲区的动态数组。

| 方法                                | 描述                        |
| ----------------------------------- | --------------------------- |
| `new()`                             | 创建空列表                  |
| `with_capacity(cap)`                | 以指定初始容量创建          |
| `push(item)`                        | 追加元素                    |
| `pop() -> Option(T)`                | 移除并返回最后一个元素      |
| `get(index) -> Option(T)`           | 按索引获取                  |
| `set(index, value)`                 | 按索引设置                  |
| `len() -> usize`                    | 元素数量                    |
| `is_empty() -> bool`                | 检查是否为空                |
| `contains(item) -> bool`            | 检查是否包含（需实现 `Eq`） |
| `index_of(item) -> Option(usize)`   | 查找索引（需实现 `Eq`）     |
| `reverse()`                         | 原地反转                    |
| `sort()`                            | 原地排序（需实现 `Ord`）    |
| `clear()`                           | 移除所有元素                |
| `slice(start, end) -> ArrayList(T)` | 提取子列表                  |

### HashMap (`std/collections/hash_map`)

```rust
{ HashMap } :: import "std/collections/hash_map";
```

使用线性探测的哈希映射。键类型必须实现 `Eq` 和 `Hash`。

| 方法                        | 描述           |
| --------------------------- | -------------- |
| `new()`                     | 创建空映射     |
| `set(key, value)`           | 插入或更新     |
| `get(key) -> Option(V)`     | 按键查找       |
| `contains_key(key) -> bool` | 检查键是否存在 |
| `remove(key) -> Option(V)`  | 删除条目       |
| `len() -> usize`            | 条目数量       |
| `keys() -> ArrayList(K)`    | 获取所有键     |
| `values() -> ArrayList(V)`  | 获取所有值     |

### HashSet (`std/collections/hash_set`)

```rust
{ HashSet } :: import "std/collections/hash_set";
```

| 方法                     | 描述         |
| ------------------------ | ------------ |
| `new()`                  | 创建空集合   |
| `insert(item)`           | 添加元素     |
| `contains(item) -> bool` | 检查是否包含 |
| `remove(item)`           | 移除元素     |
| `len() -> usize`         | 元素数量     |

### LinkedList (`std/collections/linked_list`)

双向链表，支持 `push_front`、`push_back`、`pop_front`、`pop_back`、`contains`、`len`。

### BTreeMap (`std/collections/btree_map`)

基于 B 树的有序映射。键类型必须实现 `Ord`。

### Deque (`std/collections/deque`)

双端队列，支持 `push_front`、`push_back`、`pop_front`、`pop_back`。

### PriorityQueue (`std/collections/priority_queue`)

最小堆优先队列，支持 `push`、`pop`、`peek`。

---

## 文件系统

### File (`std/fs/file`)

```rust
open import "std/fs/file";
```

基于 effect 的异步文件 I/O 操作。

| 函数                                       | 描述         |
| ------------------------------------------ | ------------ |
| `File.open(path, flags, mode, using(io))`  | 打开文件     |
| `File.read(fd, buf, size, using(io))`      | 读取字节     |
| `File.write(fd, buf, size, using(io))`     | 写入字节     |
| `File.close(fd, using(io))`                | 关闭文件     |
| `File.seek(fd, offset, whence, using(io))` | 移动读写位置 |

### SeekFrom (`std/fs/types`)

```rust
SeekFrom :: enum(Start(offset: i64), Current(offset: i64), End(offset: i64));
```

### Directory (`std/fs/dir`)

目录操作：`mkdir`、`rmdir`、`readdir`。

### Metadata (`std/fs/metadata`)

文件元数据：大小、权限、时间戳。

### Temp (`std/fs/temp`)

临时文件和目录的创建。

### Walker (`std/fs/walker`)

递归目录遍历。

---

## 网络

### TCP (`std/net/tcp`)

```rust
open import "std/net/tcp";
```

异步 TCP 客户端/服务器，支持 `connect`、`listen`、`accept`、`read_bytes`、`write`。

### UDP (`std/net/udp`)

UDP 数据报套接字，支持 `bind`、`send_to`、`recv_from`。

### DNS (`std/net/dns`)

DNS 解析，支持 `resolve`。

### Addr (`std/net/addr`)

网络地址类型：`IpAddr`、`SocketAddr`。

---

## HTTP

### HTTP (`std/http`)

```rust
// 通过 index 导入（推荐）
{ HttpMethod, HttpRequest, HttpResponse, fetch, FetchOptions } :: import "std/http";

// 或导入特定子模块
{ HttpMethod, HttpRequest, HttpResponse } :: import "std/http/http";
{ fetch, fetch_with, FetchOptions, HttpError } :: import "std/http/client";
```

**HttpMethod** — 枚举：`GET`、`POST`、`PUT`、`DELETE`、`PATCH`、`HEAD`。

**HttpRequest** — 使用构建器模式构造 HTTP 请求：

```rust
req := HttpRequest.new(.GET, `/api/users`);
req = req.header(`Host`, `example.com`);
req = req.header(`Accept`, `application/json`);
s := req.to_string();  // 序列化为 HTTP/1.1 格式
```

**HttpResponse** — 包含状态码辅助方法的响应对象：

```rust
resp.status_code  // i32
resp.is_ok()      // 2xx
resp.is_redirect() // 3xx
resp.is_error()   // 4xx/5xx
resp.get_header(`Content-Type`)  // Option(String)
```

**parse_response** — 将 HTTP/1.1 响应字符串解析为 `HttpResponse`。

### 异步 HTTP 客户端 (`std/http/client`)

**fetch** — 高级异步 HTTP GET，类似于 JavaScript 的 `fetch`：

```rust
{ fetch } :: import "std/http";
{ Exception } :: import "std/error";

main :: (fn(using(io : IO)) -> unit)({
  given(exn) := Exception(throw : ((err) -> {
    println(err.message());
    escape ();
  }));
  resp := io.await(fetch(`http://example.com/api/data`, using(io)));
  cond(resp.is_ok() => println(resp.body), true => println(`Request failed`));
});
```

**fetch_with** — 带自定义选项的异步 HTTP 请求：

```rust
opts := FetchOptions.new()
  .with_method(.POST)
  .with_header(`Content-Type`, `application/json`)
  .with_body(`{"key": "value"}`);
resp := io.await(fetch_with(`http://example.com/api`, opts, using(io)));
```

**FetchOptions** — 请求配置：

| 方法          | 描述                |
| ------------- | ------------------- |
| `new()`       | 创建默认配置（GET） |
| `with_method` | 设置 HTTP 方法      |
| `with_header` | 添加请求头          |
| `with_body`   | 设置请求体          |

**HttpError** — 枚举：`ConnectionFailed`、`InvalidUrl`、`Timeout`、`TooManyRedirects`、`UnsupportedScheme`、`ResponseTooLarge`、`Other`。

---

## 编码

```rust
// 导入特定的编码模块
open import "std/encoding/json";
{ toml_parse, TomlValue } :: import "std/encoding/toml";
{ base64_encode } :: import "std/encoding/base64";
```

### JSON (`std/encoding/json`)

```rust
open import "std/encoding/json";
```

完整的 JSON 解析器和序列化器。

**JsonValue** — 枚举：`Null`、`Bool`、`Number`、`Str`、`Array`、`Object`。

```rust
// 解析
result := json_parse(`{"name": "Yo", "version": 1}`);
obj := result.unwrap();
name := obj.get(`name`).unwrap().as_string().unwrap();

// 序列化
val := JsonValue.new_object();
val.set(`key`, .Str(`value`));
s := json_stringify(val);
```

### Base64 (`std/encoding/base64`)

```rust
open import "std/encoding/base64";
```

- `base64_encode(data: ArrayList(u8)) -> String` — 将字节编码为 Base64
- `base64_decode(encoded: String) -> Result(ArrayList(u8), String)` — 将 Base64 解码为字节

### Hex (`std/encoding/hex`)

- `hex_encode(data: ArrayList(u8)) -> String`
- `hex_decode(hex: String) -> Result(ArrayList(u8), String)`

### UTF-16 (`std/encoding/utf16`)

UTF-16 编码/解码工具。

---

## 加密

### SHA-256 (`std/crypto/sha256`)

```rust
open import "std/crypto/sha256";
hash := sha256(`Hello`);  // 返回十六进制字符串
```

### MD5 (`std/crypto/md5`)

```rust
open import "std/crypto/md5";
hash := md5(`Hello`);  // 返回十六进制字符串
```

### Random (`std/crypto/random`)

密码学安全的随机数生成。

---

## 正则表达式

### Regex (`std/regex`)

```rust
open import "std/regex";
```

完整的正则表达式引擎，支持编译和匹配。

```rust
re := Regex.compile(`\d+`);
m := re.find(`abc 123 def`);
// 支持的匹配操作：find、find_all、test、replace
```

---

## 命令行参数解析

### ArgParser (`std/cli/arg_parser`)

```rust
{ ArgParser, ParsedArgs } :: import "std/cli/arg_parser";
```

基于构建器模式的命令行参数解析器：

```rust
parser := ArgParser.new(`my-tool`, `A helpful tool`);
parser = parser.add_flag(`verbose`, `v`, `Enable verbose output`);
parser = parser.add_option(`output`, `o`, `Output file`, `out.txt`);
parser = parser.add_positional(`input`, `Input file`);

result := parser.parse(args);
args := result.unwrap();
args.has_flag(`verbose`)        // bool
args.get_option(`output`)       // Option(String)
args.get_positional(`input`)    // Option(String)
```

---

## TOML 解析

### TOML (`std/encoding/toml`)

为与其他数据格式保持一致，TOML 已移至 `std/encoding/` 模块。

```rust
{ toml_parse, TomlValue } :: import "std/encoding/toml";
```

基础 TOML 解析器，支持字符串、整数、布尔值和表节。

```rust
result := toml_parse(`
[server]
host = "localhost"
port = 8080
debug = true
`);

root := result.unwrap();
srv := root.get(`server`).unwrap();
host := srv.get(`host`).unwrap().as_string().unwrap();  // `localhost`
port := srv.get(`port`).unwrap().as_int().unwrap();      // i64(8080)
```

**TomlValue** — 枚举：`Str`、`Int`、`Bool`、`Table`。

| 方法              | 描述           |
| ----------------- | -------------- |
| `new_table()`     | 创建空表       |
| `get(key)`        | 按键查找       |
| `set(key, value)` | 插入/更新      |
| `has_key(key)`    | 检查键是否存在 |
| `table_len()`     | 条目数量       |
| `as_string()`     | 提取 String 值 |
| `as_int()`        | 提取 i64 值    |
| `as_bool()`       | 提取 bool 值   |

---

## Glob 模式匹配

### Glob (`std/glob`)

```rust
{ glob_match, GlobPattern } :: import "std/glob";
```

Unix 风格的 glob 模式匹配。

```rust
glob_match(`*.txt`, `readme.txt`)     // true
glob_match(`src/**/*.yo`, `src/a/b.yo`) // true
glob_match(`[abc].txt`, `a.txt`)       // true
```

支持的通配符：`*`、`?`、`**`、`[abc]`、`[!abc]`。

---

## IO Trait

### Reader (`std/io/reader`)

```rust
{ Reader } :: import "std/io/reader";
```

用于读取字节的 trait：

```rust
Reader :: trait(
  read : (fn(self: *(Self), buf: *(u8), size: usize, using(exn: Exception)) -> usize)
);
```

### Writer (`std/io/writer`)

```rust
{ Writer } :: import "std/io/writer";
```

用于写入字节的 trait：

```rust
Writer :: trait(
  write : (fn(self: *(Self), buf: *(u8), size: usize, using(exn: Exception)) -> usize),
  flush : (fn(self: *(Self), using(exn: Exception)) -> unit)
);
```

---

## URL 解析

### URL (`std/url`)

```rust
{ Url, url_parse } :: import "std/url";
```

URL 解析与组件提取。

---

## 时间与时长

### Instant (`std/time/instant`)

用于测量经过时间的单调时钟。

### Duration (`std/time/duration`)

支持算术运算的时间时长。

### DateTime (`std/time/datetime`)

日期与时间表示。

### Sleep (`std/time/sleep`)

通过 `io.sleep(duration, using(io))` 实现异步休眠。

---

## 同步原语

### Mutex (`std/sync/mutex`)

用于共享数据的互斥锁。

### RWLock (`std/sync/rwlock`)

读写锁，允许多个读者或一个写者。

### Channel (`std/sync/channel`)

多生产者、单消费者通道，用于消息传递。

### WaitGroup (`std/sync/waitgroup`)

用于等待多个任务完成的同步屏障。

### Once (`std/sync/once`)

一次性初始化原语。

### Cond (`std/sync/cond`)

用于线程协调的条件变量。

---

## 并发

### Async (`std/async`)

核心 async/await 原语：`io.async`、`io.await`、`io.spawn`。

### Thread (`std/thread`)

线程的创建与管理。

### Worker (`std/worker`)

用于并行执行的工作线程池。

---

## 格式化与显示

### Fmt (`std/fmt`)

```rust
open import "std/fmt";
```

- `print(value)` — 不换行打印
- `println(value)` — 换行打印

适用于任何实现了 `ToString` 的类型。

### ToString (`std/fmt/to_string`)

将值转换为 String 表示的 trait。

### Display (`std/fmt/display`)

用于格式化输出的 Display trait。

---

## 日志

### Log (`std/log`)

```rust
open import "std/log";
```

分级日志：`log_debug`、`log_info`、`log_warn`、`log_error`。

---

## 测试

### Assert（内置）

- `assert(condition, message)` — 运行时断言
- `comptime_assert(condition, message)` — 编译期断言

### Bench (`std/testing/bench`)

基准测试工具。

---

## 操作系统与环境

### Env (`std/os/env`)

- `get_env(name) -> Option(String)` — 获取环境变量
- `set_env(name, value)` — 设置环境变量

### Signal (`std/os/signal`)

Unix 信号处理。

---

## 路径

### Path (`std/path`)

```rust
open import "std/path";
```

跨平台路径操作：

| 函数                    | 描述               |
| ----------------------- | ------------------ |
| `path_join(a, b)`       | 拼接路径           |
| `path_dirname(p)`       | 获取目录部分       |
| `path_basename(p)`      | 获取文件名         |
| `path_extname(p)`       | 获取扩展名         |
| `path_is_absolute(p)`   | 检查是否为绝对路径 |
| `exists(p, using(io))`  | 检查是否存在       |
| `is_file(p, using(io))` | 检查是否为文件     |
| `is_dir(p, using(io))`  | 检查是否为目录     |

---

## 构建系统

### Build (`std/build`)

```rust
open import "std/build";
```

用于定义项目、步骤和依赖项的构建系统 API。在 `build.yo` 文件中使用。

详细文档参见 `plans/BUILD_SYSTEM.md`。

---

## 导入约定

```rust
// 导入特定导出项
{ HashMap } :: import "std/collections/hash_map";

// 开放导入（所有导出项引入作用域）
open import "std/string";

// 相对导入（在 std 或项目内部）
{ MyType } :: import "./my_module";
```
