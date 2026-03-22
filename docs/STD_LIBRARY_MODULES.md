# Yo Standard Library Modules

The Yo standard library provides a comprehensive set of modules for common programming tasks. All modules are imported using the `import` or `open import` statements.

```yo
// Named import
{ ArrayList } :: import "std/collections/array_list";

// Open import (brings all exports into scope)
open import "std/string";
```

---

## Table of Contents

- [Core](#core)
- [String](#string)
- [Collections](#collections)
- [File System](#file-system)
- [Networking](#networking)
- [HTTP](#http)
- [Encoding](#encoding)
- [Crypto](#crypto)
- [Regular Expressions](#regular-expressions)
- [CLI Argument Parsing](#cli-argument-parsing)
- [TOML Parsing](#toml-parsing)
- [Glob Pattern Matching](#glob-pattern-matching)
- [IO Traits](#io-traits)
- [URL Parsing](#url-parsing)
- [Time & Duration](#time--duration)
- [Synchronization](#synchronization)
- [Concurrency](#concurrency)
- [Formatting & Display](#formatting--display)
- [Logging](#logging)
- [Testing](#testing)
- [OS & Environment](#os--environment)
- [Path](#path)
- [Build System](#build-system)

---

## Core

### Prelude (`std/prelude`)

Automatically imported. Provides fundamental types and traits:

- **`Option(T)`** — `Some(T)` | `None`. Methods: `unwrap`, `is_some`, `is_none`, `map`, `and_then`, `or`, `unwrap_or`.
- **`Result(T, E)`** — `Ok(T)` | `Err(E)`. Methods: `unwrap`, `is_ok`, `is_err`, `map`, `map_err`, `and_then`, `or`.
- **`Box(T)`** / **`box(value)`** — Heap-allocated boxed values.
- **`Pointer`** — Compile-time and runtime pointer operations.
- **Traits**: `Eq`, `Ord`, `Hash`, `Runtime`, `Comptime`, `ToString`.

### Error (`std/error`)

- **`AnyErr`** — Type-erased error interface using `dyn`.

### Process (`std/process`)

- **`Platform`** — enum with `Linux`, `MacOS`, `Windows` variants.
- **`platform`** — Constant indicating the current build platform.

---

## String

### String (`std/string`)

```yo
open import "std/string";
```

**`String`** — UTF-8 encoded, reference-counted string object.

| Method          | Signature                                     | Description                     |
| --------------- | --------------------------------------------- | ------------------------------- |
| `new`           | `fn() -> String`                              | Create empty string             |
| `from`          | `fn(slice: str) -> String`                    | Create from str slice           |
| `len`           | `fn(self) -> usize`                           | Character count (Unicode-aware) |
| `is_empty`      | `fn(self) -> bool`                            | Check if empty                  |
| `at`            | `fn(self, index: usize) -> Option(rune)`      | Get character at index          |
| `concat`        | `fn(self, other: String) -> String`           | Concatenate strings             |
| `substring`     | `fn(self, start, end: usize) -> String`       | Extract substring               |
| `trim`          | `fn(self) -> String`                          | Trim whitespace                 |
| `trim_start`    | `fn(self) -> String`                          | Trim leading whitespace         |
| `trim_end`      | `fn(self) -> String`                          | Trim trailing whitespace        |
| `to_lowercase`  | `fn(self) -> String`                          | Convert to lowercase (ASCII)    |
| `to_uppercase`  | `fn(self) -> String`                          | Convert to uppercase (ASCII)    |
| `starts_with`   | `fn(self, prefix: String) -> bool`            | Check prefix                    |
| `ends_with`     | `fn(self, suffix: String) -> bool`            | Check suffix                    |
| `contains`      | `fn(self, substr: String) -> bool`            | Check containment               |
| `index_of`      | `fn(self, substr: String) -> Option(usize)`   | Find first occurrence           |
| `last_index_of` | `fn(self, substr: String) -> Option(usize)`   | Find last occurrence            |
| `replace`       | `fn(self, old, new: String) -> String`        | Replace occurrences             |
| `split`         | `fn(self, sep: String) -> ArrayList(String)`  | Split by separator              |
| `repeat`        | `fn(self, count: usize) -> String`            | Repeat N times                  |
| `pad_start`     | `fn(self, len: usize, pad: String) -> String` | Pad from start                  |
| `pad_end`       | `fn(self, len: usize, pad: String) -> String` | Pad from end                    |
| `parse_i32`     | `fn(self) -> Option(i32)`                     | Parse as i32                    |
| `parse_i64`     | `fn(self) -> Option(i64)`                     | Parse as i64                    |
| `parse_u32`     | `fn(self) -> Option(u32)`                     | Parse as u32                    |
| `parse_u64`     | `fn(self) -> Option(u64)`                     | Parse as u64                    |
| `parse_bool`    | `fn(self) -> Option(bool)`                    | Parse "true"/"false"            |
| `as_bytes`      | `fn(self) -> ArrayList(u8)`                   | Get byte view                   |
| `as_str`        | `fn(self) -> str`                             | Get str slice                   |

Implements: `Eq`, `Ord`, `Hash`, `ToString`.

**Template strings** create `String` values: `` `hello ${name}` ``

### Rune (`std/string/rune`)

**`rune`** — Unicode code point (32-bit). Methods: `from_u32`, `to_u32`, `is_ascii`, `is_whitespace`, `is_digit`, `is_alphabetic`, `to_lowercase`, `to_uppercase`.

---

## Collections

### ArrayList (`std/collections/array_list`)

```yo
{ ArrayList } :: import "std/collections/array_list";
```

Dynamic array backed by a growable buffer.

| Method                              | Description                       |
| ----------------------------------- | --------------------------------- |
| `new()`                             | Create empty list                 |
| `with_capacity(cap)`                | Create with initial capacity      |
| `push(item)`                        | Append item                       |
| `pop() -> Option(T)`                | Remove and return last            |
| `get(index) -> Option(T)`           | Get by index                      |
| `set(index, value)`                 | Set by index                      |
| `len() -> usize`                    | Element count                     |
| `is_empty() -> bool`                | Check if empty                    |
| `contains(item) -> bool`            | Check containment (requires `Eq`) |
| `index_of(item) -> Option(usize)`   | Find index (requires `Eq`)        |
| `reverse()`                         | Reverse in-place                  |
| `sort()`                            | Sort in-place (requires `Ord`)    |
| `clear()`                           | Remove all items                  |
| `slice(start, end) -> ArrayList(T)` | Extract sub-list                  |

### HashMap (`std/collections/hash_map`)

```yo
{ HashMap } :: import "std/collections/hash_map";
```

Hash map with linear probing. Keys must implement `Eq` and `Hash`.

| Method                      | Description      |
| --------------------------- | ---------------- |
| `new()`                     | Create empty map |
| `set(key, value)`           | Insert or update |
| `get(key) -> Option(V)`     | Lookup by key    |
| `contains_key(key) -> bool` | Check key exists |
| `remove(key) -> Option(V)`  | Remove entry     |
| `len() -> usize`            | Entry count      |
| `keys() -> ArrayList(K)`    | Get all keys     |
| `values() -> ArrayList(V)`  | Get all values   |

### HashSet (`std/collections/hash_set`)

```yo
{ HashSet } :: import "std/collections/hash_set";
```

| Method                   | Description      |
| ------------------------ | ---------------- |
| `new()`                  | Create empty set |
| `insert(item)`           | Add item         |
| `contains(item) -> bool` | Check membership |
| `remove(item)`           | Remove item      |
| `len() -> usize`         | Element count    |

### LinkedList (`std/collections/linked_list`)

Doubly-linked list with `push_front`, `push_back`, `pop_front`, `pop_back`, `contains`, `len`.

### BTreeMap (`std/collections/btree_map`)

Ordered map backed by a B-tree. Keys must implement `Ord`.

### Deque (`std/collections/deque`)

Double-ended queue with `push_front`, `push_back`, `pop_front`, `pop_back`.

### PriorityQueue (`std/collections/priority_queue`)

Min-heap priority queue with `push`, `pop`, `peek`.

---

## File System

### File (`std/fs/file`)

```yo
open import "std/fs/file";
```

Async file I/O operations using effects.

| Function                                   | Description   |
| ------------------------------------------ | ------------- |
| `File.open(path, flags, mode, using(io))`  | Open a file   |
| `File.read(fd, buf, size, using(io))`      | Read bytes    |
| `File.write(fd, buf, size, using(io))`     | Write bytes   |
| `File.close(fd, using(io))`                | Close file    |
| `File.seek(fd, offset, whence, using(io))` | Seek position |

### SeekFrom (`std/fs/types`)

```yo
SeekFrom :: enum(Start(offset: i64), Current(offset: i64), End(offset: i64));
```

### Directory (`std/fs/dir`)

Directory operations: `mkdir`, `rmdir`, `readdir`.

### Metadata (`std/fs/metadata`)

File metadata: size, permissions, timestamps.

### Temp (`std/fs/temp`)

Temporary file and directory creation.

### Walker (`std/fs/walker`)

Recursive directory walking/traversal.

---

## Networking

### TCP (`std/net/tcp`)

```yo
open import "std/net/tcp";
```

Async TCP client/server with `connect`, `listen`, `accept`, `read_bytes`, `write`.

### UDP (`std/net/udp`)

UDP datagram sockets with `bind`, `send_to`, `recv_from`.

### DNS (`std/net/dns`)

DNS resolution with `resolve`.

### Addr (`std/net/addr`)

Network address types: `IpAddr`, `SocketAddr`.

---

## HTTP

### HTTP Types (`std/http/http`)

```yo
{ HttpMethod, HttpHeader, HttpRequest, HttpResponse, http_parse_response } :: import "std/http/http";
```

**HttpMethod** — enum: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `HEAD`, `OPTIONS`.

**HttpRequest** — Builder pattern for constructing HTTP requests:

```yo
req := HttpRequest.new(.GET, `/api/users`);
req = req.header(`Host`, `example.com`);
req = req.header(`Accept`, `application/json`);
s := req.to_string();  // Serializes to HTTP/1.1 format
```

**HttpResponse** — Response with status helpers:

```yo
resp := result.unwrap();
resp.status_code  // i32
resp.is_ok()      // 2xx
resp.is_redirect() // 3xx
resp.is_error()   // 4xx/5xx
resp.get_header(`Content-Type`)  // Option(String)
```

**http_parse_response** — Parse an HTTP/1.1 response string into `HttpResponse`.

---

## Encoding

### JSON (`std/encoding/json`)

```yo
open import "std/encoding/json";
```

Full JSON parser and stringifier.

**JsonValue** — enum: `Null`, `Bool`, `Number`, `Str`, `Array`, `Object`.

```yo
// Parse
result := json_parse(`{"name": "Yo", "version": 1}`);
obj := result.unwrap();
name := obj.get(`name`).unwrap().as_string().unwrap();

// Stringify
val := JsonValue.new_object();
val.set(`key`, .Str(`value`));
s := json_stringify(val);
```

### Base64 (`std/encoding/base64`)

```yo
open import "std/encoding/base64";
```

- `base64_encode(data: ArrayList(u8)) -> String` — Encode bytes to base64
- `base64_decode(encoded: String) -> Result(ArrayList(u8), String)` — Decode base64 to bytes

### Hex (`std/encoding/hex`)

- `hex_encode(data: ArrayList(u8)) -> String`
- `hex_decode(hex: String) -> Result(ArrayList(u8), String)`

### UTF-16 (`std/encoding/utf16`)

UTF-16 encoding/decoding utilities.

---

## Crypto

### SHA-256 (`std/crypto/sha256`)

```yo
open import "std/crypto/sha256";
hash := sha256(`Hello`);  // Returns hex string
```

### MD5 (`std/crypto/md5`)

```yo
open import "std/crypto/md5";
hash := md5(`Hello`);  // Returns hex string
```

### Random (`std/crypto/random`)

Cryptographic random number generation.

---

## Regular Expressions

### Regex (`std/regex/regex`)

```yo
open import "std/regex/regex";
```

Full regex engine with compilation and matching.

```yo
re := Regex.compile(`\d+`);
m := re.find(`abc 123 def`);
// Match support: find, find_all, test, replace
```

---

## CLI Argument Parsing

### ArgParser (`std/cli/arg_parser`)

```yo
{ ArgParser, ParsedArgs } :: import "std/cli/arg_parser";
```

Builder-pattern CLI argument parser:

```yo
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

## TOML Parsing

### TOML (`std/toml/toml`)

```yo
{ toml_parse, TomlValue } :: import "std/toml/toml";
```

Basic TOML parser supporting strings, integers, booleans, and table sections.

```yo
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

**TomlValue** — enum: `Str`, `Int`, `Bool`, `Table`.

| Method            | Description          |
| ----------------- | -------------------- |
| `new_table()`     | Create empty table   |
| `get(key)`        | Lookup by key        |
| `set(key, value)` | Insert/update        |
| `has_key(key)`    | Check key existence  |
| `table_len()`     | Number of entries    |
| `as_string()`     | Extract String value |
| `as_int()`        | Extract i64 value    |
| `as_bool()`       | Extract bool value   |

---

## Glob Pattern Matching

### Glob (`std/glob/glob`)

```yo
{ glob_match, GlobPattern } :: import "std/glob/glob";
```

Unix-style glob pattern matching.

```yo
glob_match(`*.txt`, `readme.txt`)     // true
glob_match(`src/**/*.yo`, `src/a/b.yo`) // true
glob_match(`[abc].txt`, `a.txt`)       // true
```

Supports: `*`, `?`, `**`, `[abc]`, `[!abc]`.

---

## IO Traits

### Reader (`std/io/reader`)

```yo
{ Reader } :: import "std/io/reader";
```

Trait for reading bytes:

```yo
Reader :: trait(
  read : (fn(self: *(Self), buf: *(u8), size: usize, using(exn: Exception)) -> usize)
);
```

### Writer (`std/io/writer`)

```yo
{ Writer } :: import "std/io/writer";
```

Trait for writing bytes:

```yo
Writer :: trait(
  write : (fn(self: *(Self), buf: *(u8), size: usize, using(exn: Exception)) -> usize),
  flush : (fn(self: *(Self), using(exn: Exception)) -> unit)
);
```

---

## URL Parsing

### URL (`std/url/url`)

URL parsing and component extraction.

---

## Time & Duration

### Instant (`std/time/instant`)

Monotonic clock for measuring elapsed time.

### Duration (`std/time/duration`)

Time duration with arithmetic operations.

### DateTime (`std/time/datetime`)

Date and time representation.

### Sleep (`std/time/sleep`)

Async sleep using `io.sleep(duration, using(io))`.

---

## Synchronization

### Mutex (`std/sync/mutex`)

Mutual exclusion lock for shared data.

### RWLock (`std/sync/rwlock`)

Reader-writer lock allowing multiple readers or one writer.

### Channel (`std/sync/channel`)

Multi-producer, single-consumer channel for message passing.

### WaitGroup (`std/sync/waitgroup`)

Synchronization barrier for waiting on multiple tasks.

### Once (`std/sync/once`)

One-time initialization primitive.

### Cond (`std/sync/cond`)

Condition variable for thread coordination.

---

## Concurrency

### Async (`std/async`)

Core async/await primitives. `io.async`, `io.await`, `io.spawn`.

### Thread (`std/thread`)

Thread creation and management.

### Worker (`std/worker`)

Worker thread pool for parallel execution.

---

## Formatting & Display

### Fmt (`std/fmt`)

```yo
open import "std/fmt";
```

- `print(value)` — Print without newline
- `println(value)` — Print with newline

Works with any type implementing `ToString`.

### ToString (`std/fmt/to_string`)

Trait for converting values to String representation.

### Display (`std/fmt/display`)

Display trait for formatted output.

---

## Logging

### Log (`std/log/log`)

```yo
open import "std/log/log";
```

Leveled logging: `log_debug`, `log_info`, `log_warn`, `log_error`.

---

## Testing

### Assert (builtin)

- `assert(condition, message)` — Runtime assertion
- `comptime_assert(condition, message)` — Compile-time assertion

### Bench (`std/testing/bench`)

Benchmarking utilities.

---

## OS & Environment

### Env (`std/os/env`)

- `get_env(name) -> Option(String)` — Get environment variable
- `set_env(name, value)` — Set environment variable

### Signal (`std/os/signal`)

Signal handling for Unix signals.

---

## Path

### Path (`std/path`)

```yo
open import "std/path";
```

Cross-platform path manipulation:

| Function                | Description        |
| ----------------------- | ------------------ |
| `path_join(a, b)`       | Join paths         |
| `path_dirname(p)`       | Get directory      |
| `path_basename(p)`      | Get filename       |
| `path_extname(p)`       | Get extension      |
| `path_is_absolute(p)`   | Check if absolute  |
| `exists(p, using(io))`  | Check existence    |
| `is_file(p, using(io))` | Check if file      |
| `is_dir(p, using(io))`  | Check if directory |

---

## Build System

### Build (`std/build`)

```yo
open import "std/build";
```

Build system API for defining projects, steps, and dependencies. Used in `build.yo` files.

See `plans/BUILD_SYSTEM.md` for detailed documentation.

---

## Importing Conventions

```yo
// Import specific exports
{ HashMap } :: import "std/collections/hash_map";

// Open import (all exports in scope)
open import "std/string";

// Relative imports (within std or project)
{ MyType } :: import "./my_module";
```
