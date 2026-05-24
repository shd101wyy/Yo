# Node.js API Implementation Plan for Yo

This document outlines the plan to implement Node.js-like APIs in Yo, making it a viable alternative for systems programming with async I/O.

## Current Status

### Already Implemented

| Trait                            | Location         | Status      | Notes                        |
| -------------------------------- | ---------------- | ----------- | ---------------------------- |
| `std/sys/file.yo`                | File I/O         | ✅ Basic    | Async read/write, open/close |
| `std/collections/array_list.yo`  | Dynamic arrays   | ✅ Complete | Similar to `Buffer`          |
| `std/collections/hash_map.yo`    | Hash maps        | ✅ Complete |                              |
| `std/collections/hash_set.yo`    | Hash sets        | ✅ Complete |                              |
| `std/collections/linked_list.yo` | Linked lists     | ✅ Complete |                              |
| `std/string/string.yo`           | UTF-8 strings    | ✅ Basic    | Immutable strings            |
| `std/string/rune.yo`             | Unicode chars    | ✅ Complete |                              |
| `std/async.yo`                   | Async primitives | ✅ Basic    | `yield`                      |
| `std/time.yo`                    | Time utilities   | ⚠️ Minimal  | Only `sleep`                 |
| `std/sync.yo`                    | Sync primitives  | ⚠️ Basic    | Mutex, etc.                  |
| `std/thread.yo`                  | Threading        | ⚠️ Basic    |                              |
| `std/worker.yo`                  | Worker threads   | ⚠️ Basic    |                              |

### libc Bindings Available

- `std/libc/stdio.yo` - Standard I/O
- `std/libc/stdlib.yo` - Memory, process, random
- `std/libc/unistd.yo` - POSIX APIs
- `std/libc/string.yo` - C strings
- `std/libc/time.yo` - Time functions
- `std/libc/math.yo` - Math functions
- `std/libc/errno.yo` - Error codes
- `std/libc/signal.yo` - Signal handling

---

## Design Philosophy: Async-First

**Yo takes an async-first approach** - all I/O operations are asynchronous by default, leveraging Yo's native async/await support.

### Why Async-Only for I/O?

1. **Native async/await is first-class** - Unlike Node.js which added async/await later, Yo was built with it from the ground up
2. **Prevents blocking** - No risk of accidentally blocking the event loop with synchronous I/O
3. **Simpler API surface** - No need for duplicate `*Sync()` variants
4. **Still convenient** - With native `await`, async code is just as ergonomic as sync code

### What Stays Synchronous?

Operations that don't involve I/O or blocking syscalls:

- **Pure computation** - `Path.join()`, `String` operations, etc.
- **In-memory data** - `Process.args()`, `Process.env.get()`
- **Fast syscalls** - `Process.pid()`, `Process.cwd()` (cached)

### Example

```rust
main :: (fn() -> Impl Future(unit))(async {
  // Sync - no I/O
  args := Process.args();
  path := Path.join("data", "file.txt");

  // Async - involves I/O (clean and simple!)
  content := await read_file(path);
  stat := await stat(path);

  print(content);
});
```

---

## Phase 1: Core I/O & File System (Priority: High)

### 1.1 File System Module Enhancement (`std/fs/`)

**Node.js Equivalent:** `fs` module

#### Data Types

```
// std/fs/types.yo
FileMode :: struct(mode: u32)          // Unix file permissions
FileType :: enum(File, Directory, Symlink, BlockDevice, CharDevice, Fifo, Socket, Unknown)
FileStat :: object(                    // File metadata
  size: i64,
  mode: FileMode,
  file_type: FileType,
  modified_time: Timestamp,
  accessed_time: Timestamp,
  created_time: Timestamp,
  uid: u32,
  gid: u32,
  inode: u64,
  dev: u64,
  nlink: u64
)

DirEntry :: object(                    // Directory entry
  name: String,
  file_type: FileType,
  path: Path
)

FileHandle :: object(...)              // File descriptor wrapper (existing as File)
```

#### Functions to Implement

**Note:** All file operations are async by default (no `_async` suffix needed).

| Yo Function               | Node.js Equivalent         | Priority | Returns                                        |
| ------------------------- | -------------------------- | -------- | ---------------------------------------------- |
| `stat(path)`              | `fs.promises.stat()`       | High     | `Future(Result(FileStat, IoError))`            |
| `lstat(path)`             | `fs.promises.lstat()`      | Medium   | `Future(Result(FileStat, IoError))`            |
| `fstat(fd)`               | `fs.promises.fstat()`      | Medium   | `Future(Result(FileStat, IoError))`            |
| `exists(path)`            | `fs.promises.access()`     | High     | `Future(bool)`                                 |
| `mkdir(path, options)`    | `fs.promises.mkdir()`      | High     | `Future(Result(unit, IoError))`                |
| `rmdir(path)`             | `fs.promises.rmdir()`      | High     | `Future(Result(unit, IoError))`                |
| `rm(path, options)`       | `fs.promises.rm()`         | High     | `Future(Result(unit, IoError))`                |
| `rename(old, new)`        | `fs.promises.rename()`     | High     | `Future(Result(unit, IoError))`                |
| `copy_file(src, dst)`     | `fs.promises.copyFile()`   | Medium   | `Future(Result(unit, IoError))`                |
| `readdir(path)`           | `fs.promises.readdir()`    | High     | `Future(Result(ArrayList(DirEntry), IoError))` |
| `read_file(path)`         | `fs.promises.readFile()`   | High     | `Future(Result(ArrayList(u8), IoError))`       |
| `write_file(path, data)`  | `fs.promises.writeFile()`  | High     | `Future(Result(unit, IoError))`                |
| `append_file(path, data)` | `fs.promises.appendFile()` | Medium   | `Future(Result(unit, IoError))`                |
| `truncate(path, len)`     | `fs.promises.truncate()`   | Medium   | `Future(Result(unit, IoError))`                |
| `chmod(path, mode)`       | `fs.promises.chmod()`      | Medium   | `Future(Result(unit, IoError))`                |
| `chown(path, uid, gid)`   | `fs.promises.chown()`      | Low      | `Future(Result(unit, IoError))`                |
| `link(src, dst)`          | `fs.promises.link()`       | Low      | `Future(Result(unit, IoError))`                |
| `symlink(target, path)`   | `fs.promises.symlink()`    | Low      | `Future(Result(unit, IoError))`                |
| `readlink(path)`          | `fs.promises.readlink()`   | Low      | `Future(Result(String, IoError))`              |
| `realpath(path)`          | `fs.promises.realpath()`   | Medium   | `Future(Result(Path, IoError))`                |
| `watch(path, callback)`   | `fs.watch()`               | Low      | `Future(Result(Watcher, IoError))`             |

### 1.2 Path Module (`std/path/`)

**Node.js Equivalent:** `path` module

#### Data Types

```
// std/path/path.yo
Path :: object(
  _segments: ArrayList(String),
  _is_absolute: bool,

  // Constructor methods
  new :: fn(path_str: String) -> Self,
  from_cstr :: fn(cstr: *(u8)) -> Self,

  // Path operations
  join :: fn(self: Self, other: Path) -> Self,
  parent :: fn(self: Self) -> Option(Self),
  file_name :: fn(self: Self) -> Option(String),
  file_stem :: fn(self: Self) -> Option(String),
  extension :: fn(self: Self) -> Option(String),
  with_extension :: fn(self: Self, ext: String) -> Self,

  // Path queries
  is_absolute :: fn(self: Self) -> bool,
  is_relative :: fn(self: Self) -> bool,
  exists :: fn(self: Self) -> bool,
  is_file :: fn(self: Self) -> bool,
  is_dir :: fn(self: Self) -> bool,

  // Conversion
  to_string :: fn(self: Self) -> String,
  to_cstr :: fn(self: Self) -> ArrayList(u8),
)
```

#### Functions to Implement

**Note:** Path operations are **synchronous** (pure computation, no I/O).

| Yo Function                 | Node.js Equivalent  | Priority | Notes                              |
| --------------------------- | ------------------- | -------- | ---------------------------------- |
| `Path.join(a, b)`           | `path.join()`       | High     | ✅ Implemented                     |
| `Path.resolve(paths...)`    | `path.resolve()`    | High     | Sync - resolve to absolute path    |
| `Path.normalize(path)`      | `path.normalize()`  | High     | Partially done in constructor      |
| `Path.is_absolute(path)`    | `path.isAbsolute()` | High     | ✅ Implemented                     |
| `Path.is_relative(path)`    | (derived)           | High     | ✅ Implemented                     |
| `Path.relative(from, to)`   | `path.relative()`   | Medium   | Sync - compute relative path       |
| `Path.dirname(path)`        | `path.dirname()`    | High     | ✅ Implemented as `parent()`       |
| `Path.basename(path)`       | `path.basename()`   | High     | ✅ Implemented as `file_name()`    |
| `Path.extname(path)`        | `path.extname()`    | High     | ✅ Implemented as `extension()`    |
| `Path.file_stem()`          | (derived)           | High     | ✅ Implemented                     |
| `Path.with_extension(ext)`  | (derived)           | High     | ✅ Implemented                     |
| `Path.with_file_name(name)` | -                   | Medium   | Sync - replace file name           |
| `Path.starts_with(base)`    | -                   | Medium   | Sync - check if starts with base   |
| `Path.ends_with(suffix)`    | -                   | Low      | Sync - check if ends with suffix   |
| `Path.components()`         | -                   | Low      | Sync - get all path components     |
| `Path.sep`                  | `path.sep`          | High     | ✅ Implemented as `PATH_SEPARATOR` |
| `Path.delimiter`            | `path.delimiter`    | Medium   | ✅ Implemented as `PATH_DELIMITER` |

**Note:** File system I/O operations like checking existence or file type belong in the `fs` module:

- Use `fs.exists(path)` to check if a path exists
- Use `fs.stat(path)` to get file metadata (includes `is_file()`, `is_dir()`, etc.)

---

## Phase 2: Networking (Priority: High)

### 2.1 TCP/UDP Sockets (`std/net/`)

**Node.js Equivalent:** `net` and `dgram` modules

#### Data Types

```
// std/net/socket.yo
SocketAddr :: enum(
  V4(ip: IPv4Addr, port: u16),
  V6(ip: IPv6Addr, port: u16)
)

IPv4Addr :: struct(octets: [4]u8)
IPv6Addr :: struct(segments: [8]u16)

TcpSocket :: object(
  _fd: i32,
  _local_addr: Option(SocketAddr),
  _remote_addr: Option(SocketAddr),

  connect :: fn(addr: SocketAddr) -> Impl Future(Result(Self, NetError)),
  read :: fn(self: Self, buffer: ArrayList(u8)) -> Impl Future(Result(usize, NetError)),
  write :: fn(self: Self, data: ArrayList(u8)) -> Impl Future(Result(usize, NetError)),
  close :: fn(self: Self) -> unit,
  set_nodelay :: fn(self: Self, enable: bool) -> Result(unit, NetError),
  set_keepalive :: fn(self: Self, enable: bool) -> Result(unit, NetError),
)

TcpListener :: object(
  _fd: i32,
  _local_addr: SocketAddr,

  bind :: fn(addr: SocketAddr) -> Result(Self, NetError),
  accept :: fn(self: Self) -> Impl Future(Result(TcpSocket, NetError)),
  local_addr :: fn(self: Self) -> SocketAddr,
)

UdpSocket :: object(
  _fd: i32,

  bind :: fn(addr: SocketAddr) -> Result(Self, NetError),
  send_to :: fn(self: Self, data: ArrayList(u8), addr: SocketAddr) -> Impl Future(Result(usize, NetError)),
  recv_from :: fn(self: Self, buffer: ArrayList(u8)) -> Impl Future(Result((usize, SocketAddr), NetError)),
)

NetError :: enum(
  ConnectionRefused,
  ConnectionReset,
  ConnectionAborted,
  NotConnected,
  AddrInUse,
  AddrNotAvailable,
  BrokenPipe,
  TimedOut,
  InvalidInput,
  Other(code: i32)
)
```

#### Functions to Implement

| Yo Function                       | Node.js Equivalent        | Priority | Notes |
| --------------------------------- | ------------------------- | -------- | ----- |
| `TcpSocket.connect(addr)`         | `net.createConnection()`  | High     | Async |
| `TcpSocket.read(buf)`             | `socket.on('data')`       | High     | Async |
| `TcpSocket.write(data)`           | `socket.write()`          | High     | Async |
| `TcpSocket.close()`               | `socket.destroy()`        | High     | Sync  |
| `TcpSocket.set_nodelay(enable)`   | `socket.setNoDelay()`     | Medium   | Sync  |
| `TcpSocket.set_keepalive(enable)` | `socket.setKeepAlive()`   | Medium   | Sync  |
| `TcpListener.bind(addr)`          | `net.createServer()`      | High     | Sync  |
| `TcpListener.accept()`            | `server.on('connection')` | High     | Async |
| `UdpSocket.bind(addr)`            | `dgram.createSocket()`    | Medium   | Sync  |
| `UdpSocket.send_to(...)`          | `socket.send()`           | Medium   | Async |
| `UdpSocket.recv_from(...)`        | `socket.on('message')`    | Medium   | Async |

### 2.2 DNS (`std/dns/`)

**Node.js Equivalent:** `dns` module

#### Data Types

```
// std/dns/dns.yo
DnsError :: enum(
  NotFound,
  ServerFailure,
  TimedOut,
  Other(code: i32)
)
```

#### Functions to Implement

**Note:** All DNS operations are async (network I/O).

| Yo Function          | Node.js Equivalent        | Priority | Returns                                         |
| -------------------- | ------------------------- | -------- | ----------------------------------------------- |
| `lookup(hostname)`   | `dns.promises.lookup()`   | High     | `Future(Result(SocketAddr, DnsError))`          |
| `resolve4(hostname)` | `dns.promises.resolve4()` | Medium   | `Future(Result(ArrayList(IPv4Addr), DnsError))` |
| `resolve6(hostname)` | `dns.promises.resolve6()` | Medium   | `Future(Result(ArrayList(IPv6Addr), DnsError))` |
| `reverse(ip)`        | `dns.promises.reverse()`  | Low      | `Future(Result(ArrayList(String), DnsError))`   |

---

## Phase 3: HTTP (Priority: High)

### 3.1 HTTP Client (`std/http/client.yo`)

**Node.js Equivalent:** `http`/`https` module, `fetch`

#### Data Types

```
// std/http/types.yo
HttpMethod :: enum(GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS, CONNECT, TRACE)

HttpVersion :: enum(HTTP_1_0, HTTP_1_1, HTTP_2)

Headers :: object(
  _entries: HashMap(String, ArrayList(String)),

  new :: fn() -> Self,
  set :: fn(self: Self, key: String, value: String) -> unit,
  get :: fn(self: Self, key: String) -> Option(String),
  get_all :: fn(self: Self, key: String) -> ArrayList(String),
  append :: fn(self: Self, key: String, value: String) -> unit,
  has :: fn(self: Self, key: String) -> bool,
  delete :: fn(self: Self, key: String) -> bool,
)

HttpRequest :: object(
  method: HttpMethod,
  url: Url,
  headers: Headers,
  body: Option(ArrayList(u8)),
)

HttpResponse :: object(
  status: u16,
  status_text: String,
  headers: Headers,
  body: ArrayList(u8),

  ok :: fn(self: Self) -> bool,           // status 200-299
  text :: fn(self: Self) -> Result(String, HttpError),
  json :: fn(self: Self) -> Result(JsonValue, HttpError),  // if JSON module exists
)

HttpError :: enum(
  NetworkError(NetError),
  InvalidUrl,
  InvalidHeader,
  TooManyRedirects,
  TimedOut,
  BodyTooLarge,
  Other(message: String)
)
```

#### Functions to Implement

| Yo Function            | Node.js Equivalent | Priority | Notes                    |
| ---------------------- | ------------------ | -------- | ------------------------ |
| `fetch(url, options)`  | `fetch()`          | High     | Async                    |
| `HttpRequest.new(...)` | `new Request()`    | High     | Sync                     |
| `HttpResponse.ok()`    | `response.ok`      | High     | Sync                     |
| `HttpResponse.text()`  | `response.text()`  | High     | Sync (body already read) |
| `HttpResponse.json()`  | `response.json()`  | Medium   | Sync (parsing only)      |

### 3.2 HTTP Server (`std/http/server.yo`)

**Node.js Equivalent:** `http.createServer()`

#### Data Types

```
// std/http/server.yo
HttpServer :: object(
  _listener: TcpListener,

  new :: fn(addr: SocketAddr) -> Result(Self, HttpError),
  serve :: fn(self: Self, handler: fn(Request) -> Response) -> Impl Future(unit),
)

Request :: object(
  method: HttpMethod,
  path: String,
  query: HashMap(String, String),
  headers: Headers,
  body: ArrayList(u8),

  text :: fn(self: Self) -> Result(String, HttpError),
  json :: fn(self: Self) -> Result(JsonValue, HttpError),
)

Response :: object(
  status: u16,
  headers: Headers,
  body: ArrayList(u8),

  new :: fn(status: u16) -> Self,
  with_text :: fn(self: Self, text: String) -> Self,
  with_json :: fn(self: Self, value: JsonValue) -> Self,
  with_header :: fn(self: Self, key: String, value: String) -> Self,
)
```

#### Functions to Implement

| Yo Function                 | Node.js Equivalent       | Priority | Notes                    |
| --------------------------- | ------------------------ | -------- | ------------------------ |
| `HttpServer.new(addr)`      | `http.createServer()`    | High     | Sync                     |
| `HttpServer.serve(handler)` | `server.listen()`        | High     | Async                    |
| `Request.text()`            | `req.text()`             | High     | Sync (body already read) |
| `Request.json()`            | `req.json()`             | High     | Sync (parsing only)      |
| `Response.new(status)`      | Response object creation | High     | Sync                     |
| `Response.with_text(...)`   | `res.end()`              | High     | Sync                     |
| `Response.with_json(...)`   | `res.json()`             | High     | Sync                     |

---

## Phase 4: Process & OS (Priority: Medium)

### 4.1 Process Module (`std/process/`)

**Node.js Equivalent:** `process` and `child_process`

#### Data Types

```
// std/process/process.yo
ExitCode :: struct(code: i32)

ProcessEnv :: object(
  get :: fn(key: String) -> Option(String),
  set :: fn(key: String, value: String) -> unit,
  delete :: fn(key: String) -> bool,
  entries :: fn() -> HashMap(String, String),
)

Process :: impl {
  args :: fn() -> ArrayList(String),      // process.argv
  env :: fn() -> ProcessEnv,              // process.env
  cwd :: fn() -> Result(Path, ProcessError),  // process.cwd()
  chdir :: fn(dir: Path) -> Result(unit, ProcessError),  // process.chdir()
  exit :: fn(code: i32) -> unit,          // process.exit()
  pid :: fn() -> u32,                     // process.pid
  ppid :: fn() -> u32,                    // process.ppid
  uptime :: fn() -> f64,                  // process.uptime()
  hrtime :: fn() -> (u64, u32),           // process.hrtime()
}

// Child process
ChildProcess :: object(
  pid: u32,
  stdin: Option(WritePipe),
  stdout: Option(ReadPipe),
  stderr: Option(ReadPipe),

  wait :: fn(self: Self) -> Impl Future(ExitCode),
  kill :: fn(self: Self, signal: Signal) -> Result(unit, ProcessError),
)

SpawnOptions :: struct(
  cwd: Option(Path),
  env: Option(HashMap(String, String)),
  stdin: StdioOption,
  stdout: StdioOption,
  stderr: StdioOption,
)

StdioOption :: enum(Inherit, Pipe, Null)
```

#### Functions to Implement

| Yo Function                 | Node.js Equivalent      | Priority | Notes                        |
| --------------------------- | ----------------------- | -------- | ---------------------------- |
| `Process.args()`            | `process.argv`          | High     | Sync (in-memory)             |
| `Process.env.get(key)`      | `process.env`           | High     | Sync (in-memory)             |
| `Process.env.set(key, val)` | `process.env`           | High     | Sync                         |
| `Process.cwd()`             | `process.cwd()`         | High     | Sync (cached)                |
| `Process.chdir(dir)`        | `process.chdir()`       | High     | Sync                         |
| `Process.exit(code)`        | `process.exit()`        | High     | Sync (never returns)         |
| `Process.pid()`             | `process.pid`           | Medium   | Sync                         |
| `Process.ppid()`            | `process.ppid`          | Medium   | Sync                         |
| `spawn(cmd, args, opts)`    | `child_process.spawn()` | High     | Sync (returns immediately)   |
| `exec(cmd)`                 | `child_process.exec()`  | High     | Async (waits for completion) |
| `ChildProcess.wait()`       | `child.on('exit')`      | High     | Async                        |
| `ChildProcess.kill(sig)`    | `child.kill()`          | Medium   | Sync                         |

### 4.2 OS Module (`std/os/`)

**Node.js Equivalent:** `os` module

#### Data Types

```
// std/os/os.yo
OsType :: enum(Linux, MacOS, Windows, FreeBSD, Unknown)
Arch :: enum(X86_64, Aarch64, X86, Arm, Unknown)

CpuInfo :: struct(
  model: String,
  speed: u32,  // MHz
  cores: u32,
)

NetworkInterface :: struct(
  name: String,
  address: String,
  netmask: String,
  family: String,
  mac: String,
  internal: bool,
)
```

#### Functions to Implement

**Note:** All OS info operations are **synchronous** (fast syscalls/cached data).

| Yo Function              | Node.js Equivalent       | Priority | Notes |
| ------------------------ | ------------------------ | -------- | ----- |
| `Os.type()`              | `os.type()`              | High     | Sync  |
| `Os.platform()`          | `os.platform()`          | High     | Sync  |
| `Os.arch()`              | `os.arch()`              | High     | Sync  |
| `Os.hostname()`          | `os.hostname()`          | Medium   | Sync  |
| `Os.homedir()`           | `os.homedir()`           | High     | Sync  |
| `Os.tmpdir()`            | `os.tmpdir()`            | High     | Sync  |
| `Os.cpus()`              | `os.cpus()`              | Low      | Sync  |
| `Os.totalmem()`          | `os.totalmem()`          | Medium   | Sync  |
| `Os.freemem()`           | `os.freemem()`           | Medium   | Sync  |
| `Os.uptime()`            | `os.uptime()`            | Low      | Sync  |
| `Os.loadavg()`           | `os.loadavg()`           | Low      | Sync  |
| `Os.networkInterfaces()` | `os.networkInterfaces()` | Low      | Sync  |
| `Os.eol`                 | `os.EOL`                 | High     | Const |

---

## Phase 5: Async Utilities (Priority: High)

### 5.1 Timers (`std/timers/`)

**Node.js Equivalent:** `setTimeout`, `setInterval`, `setImmediate`

#### Data Types

```
// std/timers/timers.yo
TimerId :: struct(id: u64)

Timer :: impl {
  // Returns a future that resolves after the specified duration
  sleep :: fn(ms: u64) -> Impl Future(unit),

  // Schedule a callback after delay (returns timer ID for cancellation)
  set_timeout :: fn(callback: fn() -> unit, ms: u64) -> TimerId,
  clear_timeout :: fn(id: TimerId) -> unit,

  // Schedule a repeating callback
  set_interval :: fn(callback: fn() -> unit, ms: u64) -> TimerId,
  clear_interval :: fn(id: TimerId) -> unit,

  // Schedule immediate execution (next tick)
  set_immediate :: fn(callback: fn() -> unit) -> TimerId,
}
```

#### Functions to Implement

| Yo Function                  | Node.js Equivalent                          | Priority | Notes                     |
| ---------------------------- | ------------------------------------------- | -------- | ------------------------- |
| `Timer.sleep(ms)`            | `await new Promise(r => setTimeout(r, ms))` | High     | Async                     |
| `Timer.set_timeout(cb, ms)`  | `setTimeout()`                              | High     | Sync (schedules callback) |
| `Timer.clear_timeout(id)`    | `clearTimeout()`                            | High     | Sync                      |
| `Timer.set_interval(cb, ms)` | `setInterval()`                             | Medium   | Sync (schedules callback) |
| `Timer.clear_interval(id)`   | `clearInterval()`                           | Medium   | Sync                      |
| `Timer.set_immediate(cb)`    | `setImmediate()`                            | Medium   | Sync (schedules callback) |

### 5.2 Events (`std/events/`)

**Node.js Equivalent:** `events` module

#### Data Types

```
// std/events/emitter.yo
EventEmitter :: (fn(comptime(E): Type) -> comptime(Type))
  object(
    _listeners: HashMap(String, ArrayList(fn(E) -> unit)),

    new :: fn() -> Self,
    on :: fn(self: Self, event: String, listener: fn(E) -> unit) -> unit,
    once :: fn(self: Self, event: String, listener: fn(E) -> unit) -> unit,
    off :: fn(self: Self, event: String, listener: fn(E) -> unit) -> unit,
    emit :: fn(self: Self, event: String, data: E) -> bool,
    remove_all_listeners :: fn(self: Self, event: Option(String)) -> unit,
    listener_count :: fn(self: Self, event: String) -> usize,
  )
;
```

#### Functions to Implement

**Note:** All event operations are **synchronous** (in-memory manipulation).

| Yo Function                           | Node.js Equivalent             | Priority | Notes |
| ------------------------------------- | ------------------------------ | -------- | ----- |
| `EventEmitter.on(...)`                | `emitter.on()`                 | High     | Sync  |
| `EventEmitter.once(...)`              | `emitter.once()`               | High     | Sync  |
| `EventEmitter.off(...)`               | `emitter.off()`                | High     | Sync  |
| `EventEmitter.emit(...)`              | `emitter.emit()`               | High     | Sync  |
| `EventEmitter.remove_all_listeners()` | `emitter.removeAllListeners()` | Medium   | Sync  |
| `EventEmitter.listener_count(event)`  | `emitter.listenerCount()`      | Medium   | Sync  |

---

## Phase 6: Streams (Priority: Medium)

### 6.1 Stream Types (`std/stream/`)

**Node.js Equivalent:** `stream` module

#### Data Types

```
// std/stream/types.yo
ReadableStream :: trait {
  read :: fn(self: Self, size: usize) -> Impl Future(Option(ArrayList(u8)));
  is_readable :: fn(self: Self) -> bool;
}

WritableStream :: trait {
  write :: fn(self: Self, data: ArrayList(u8)) -> Impl Future(Result(usize, StreamError));
  flush :: fn(self: Self) -> Impl Future(Result(unit, StreamError));
  close :: fn(self: Self) -> Impl Future(Result(unit, StreamError));
}

DuplexStream :: trait : ReadableStream + WritableStream {}

TransformStream :: trait : DuplexStream {
  transform :: fn(self: Self, chunk: ArrayList(u8)) -> Impl Future(ArrayList(u8));
}

StreamError :: enum(
  Closed,
  BrokenPipe,
  BufferFull,
  Other(code: i32)
)
```

#### Functions to Implement

| Yo Function                | Node.js Equivalent  | Priority |
| -------------------------- | ------------------- | -------- |
| `pipe(readable, writable)` | `readable.pipe()`   | Medium   |
| `pipeline(streams...)`     | `stream.pipeline()` | Medium   |

---

## Phase 7: Data Formats (Priority: Medium)

### 7.1 JSON (`std/json/`)

**Node.js Equivalent:** `JSON`

#### Data Types

```
// std/json/json.yo
JsonValue :: enum(
  Null,
  Bool(value: bool),
  Number(value: f64),
  String(value: String),
  Array(items: ArrayList(JsonValue)),
  Object(entries: HashMap(String, JsonValue))
)

JsonError :: enum(
  ParseError(message: String, line: usize, column: usize),
  TypeError(expected: String, got: String),
)
```

#### Functions to Implement

**Note:** All JSON operations are **synchronous** (pure computation).

| Yo Function                    | Node.js Equivalent       | Priority | Notes |
| ------------------------------ | ------------------------ | -------- | ----- |
| `Json.parse(str)`              | `JSON.parse()`           | High     | Sync  |
| `Json.stringify(value)`        | `JSON.stringify()`       | High     | Sync  |
| `Json.stringify_pretty(value)` | `JSON.stringify(..., 2)` | Medium   | Sync  |

### 7.2 URL (`std/url/`)

**Node.js Equivalent:** `url` module, `URL` class

#### Data Types

```
// std/url/url.yo
Url :: object(
  protocol: String,
  host: String,
  hostname: String,
  port: Option(u16),
  pathname: String,
  search: String,
  hash: String,
  username: String,
  password: String,

  parse :: fn(url_string: String) -> Result(Self, UrlError),
  to_string :: fn(self: Self) -> String,
)

SearchParams :: object(
  _params: HashMap(String, ArrayList(String)),

  get :: fn(self: Self, key: String) -> Option(String),
  get_all :: fn(self: Self, key: String) -> ArrayList(String),
  set :: fn(self: Self, key: String, value: String) -> unit,
  append :: fn(self: Self, key: String, value: String) -> unit,
  delete :: fn(self: Self, key: String) -> unit,
  has :: fn(self: Self, key: String) -> bool,
  to_string :: fn(self: Self) -> String,
)
```

#### Functions to Implement

**Note:** All URL operations are **synchronous** (string parsing/manipulation).

| Yo Function                     | Node.js Equivalent | Priority | Notes |
| ------------------------------- | ------------------ | -------- | ----- |
| `Url.parse(str)`                | `new URL()`        | High     | Sync  |
| `Url.to_string()`               | `url.toString()`   | High     | Sync  |
| `SearchParams.get(key)`         | `params.get()`     | High     | Sync  |
| `SearchParams.set(key, val)`    | `params.set()`     | High     | Sync  |
| `SearchParams.append(key, val)` | `params.append()`  | High     | Sync  |
| `SearchParams.delete(key)`      | `params.delete()`  | High     | Sync  |
| `SearchParams.has(key)`         | `params.has()`     | High     | Sync  |

---

## Phase 8: Cryptography (Priority: Low)

### 8.1 Crypto (`std/crypto/`)

**Node.js Equivalent:** `crypto` module

#### Data Types

```
// std/crypto/crypto.yo
HashAlgorithm :: enum(MD5, SHA1, SHA256, SHA384, SHA512)

Hash :: object(
  _algorithm: HashAlgorithm,

  new :: fn(algorithm: HashAlgorithm) -> Self,
  update :: fn(self: Self, data: ArrayList(u8)) -> Self,
  digest :: fn(self: Self) -> ArrayList(u8),
  digest_hex :: fn(self: Self) -> String,
)

Hmac :: object(
  _algorithm: HashAlgorithm,
  _key: ArrayList(u8),

  new :: fn(algorithm: HashAlgorithm, key: ArrayList(u8)) -> Self,
  update :: fn(self: Self, data: ArrayList(u8)) -> Self,
  digest :: fn(self: Self) -> ArrayList(u8),
)
```

#### Functions to Implement

**Note:** All crypto operations are **synchronous** (CPU-bound computation).

| Yo Function          | Node.js Equivalent     | Priority | Notes |
| -------------------- | ---------------------- | -------- | ----- |
| `Hash.new(alg)`      | `crypto.createHash()`  | Medium   | Sync  |
| `Hash.update(data)`  | `hash.update()`        | Medium   | Sync  |
| `Hash.digest()`      | `hash.digest()`        | Medium   | Sync  |
| `Hash.digest_hex()`  | `hash.digest('hex')`   | Medium   | Sync  |
| `random_bytes(size)` | `crypto.randomBytes()` | Medium   | Sync  |
| `random_uuid()`      | `crypto.randomUUID()`  | Medium   | Sync  |

---

## Phase 9: Console & Debugging (Priority: Medium)

### 9.1 Console (`std/console/`)

**Node.js Equivalent:** `console`

#### Functions to Implement

**Note:** All console operations are **synchronous** (write to stdout/stderr).

| Yo Function                 | Node.js Equivalent  | Priority | Notes |
| --------------------------- | ------------------- | -------- | ----- |
| `Console.log(...)`          | `console.log()`     | High     | Sync  |
| `Console.error(...)`        | `console.error()`   | High     | Sync  |
| `Console.warn(...)`         | `console.warn()`    | Medium   | Sync  |
| `Console.debug(...)`        | `console.debug()`   | Medium   | Sync  |
| `Console.time(label)`       | `console.time()`    | Low      | Sync  |
| `Console.time_end(label)`   | `console.timeEnd()` | Low      | Sync  |
| `Console.assert(cond, msg)` | `console.assert()`  | Low      | Sync  |

---

## Implementation Priorities

### Phase 1 (Immediate - 1-2 months)

1. **Path module** - Foundation for all file operations
2. **Enhanced File operations** - stat, mkdir, rmdir, readdir, rename
3. **Timers** - sleep_async, basic timer functions
4. **Process basics** - args, env, cwd, exit

### Phase 2 (Short-term - 2-4 months)

1. **TCP Sockets** - Essential for networking
2. **DNS lookup** - Required for HTTP
3. **HTTP Client** - fetch-like API
4. **JSON parsing** - Essential for web APIs

### Phase 3 (Medium-term - 4-6 months)

1. **HTTP Server** - Building web services
2. **Streams** - Efficient data handling
3. **URL parsing** - Web URL handling
4. **Event Emitter** - Event-driven architecture

### Phase 4 (Long-term - 6+ months)

1. **UDP Sockets**
2. **Crypto basics** - hashing, random
3. **OS information**
4. **Child processes**

---

## Required C Runtime Extensions

The following C runtime functions need to be added to support these APIs:

### File System

```c
// In runtime.ts
__yo_stat(path) -> StatResult
__yo_lstat(path) -> StatResult
__yo_mkdir(path, mode) -> i32
__yo_rmdir(path) -> i32
__yo_unlink(path) -> i32
__yo_rename(old, new) -> i32
__yo_readdir_start(path) -> DirHandle
__yo_readdir_next(handle) -> DirEntry
__yo_readdir_close(handle) -> unit
__yo_realpath(path, buf) -> i32
__yo_chmod(path, mode) -> i32
```

### Networking

```c
__yo_socket_create(domain, type, protocol) -> i32
__yo_socket_bind(fd, addr, port) -> i32
__yo_socket_listen(fd, backlog) -> i32
__yo_socket_accept(fd) -> Future(i32)
__yo_socket_connect(fd, addr, port) -> Future(i32)
__yo_socket_read(fd, buf, size) -> Future(i32)
__yo_socket_write(fd, buf, size) -> Future(i32)
__yo_socket_close(fd) -> unit
__yo_dns_lookup(hostname) -> Future(IpAddr)
```

### Process

```c
__yo_getenv(name) -> *(char)
__yo_setenv(name, value) -> i32
__yo_getcwd(buf, size) -> *(char)
__yo_chdir(path) -> i32
__yo_spawn(cmd, args, opts) -> ChildProcess
__yo_waitpid(pid) -> Future(i32)
__yo_kill(pid, signal) -> i32
```

### Timers

```c
__yo_timer_create(ms, callback) -> TimerId
__yo_timer_cancel(id) -> unit
__yo_sleep_async(ms) -> Future(unit)
```

---

## File Structure

```
std/
├── fs/
│   ├── index.yo
│   ├── file.yo        # (move from io/file.yo)
│   ├── stat.yo
│   ├── dir.yo
│   └── types.yo
├── path/
│   ├── index.yo
│   └── path.yo
├── net/
│   ├── index.yo
│   ├── tcp.yo
│   ├── udp.yo
│   ├── socket.yo
│   └── types.yo
├── dns/
│   ├── index.yo
│   └── dns.yo
├── http/
│   ├── index.yo
│   ├── client.yo
│   ├── server.yo
│   ├── request.yo
│   ├── response.yo
│   └── types.yo
├── process/
│   ├── index.yo
│   ├── process.yo
│   └── child.yo
├── os/
│   ├── index.yo
│   └── os.yo
├── timers/
│   ├── index.yo
│   └── timers.yo
├── events/
│   ├── index.yo
│   └── emitter.yo
├── stream/
│   ├── index.yo
│   ├── readable.yo
│   ├── writable.yo
│   └── transform.yo
├── json/
│   ├── index.yo
│   ├── parse.yo
│   └── stringify.yo
├── url/
│   ├── index.yo
│   ├── url.yo
│   └── search_params.yo
├── crypto/
│   ├── index.yo
│   ├── hash.yo
│   └── random.yo
└── console/
    ├── index.yo
    └── console.yo
```

---

## Improvements to Existing `std/sys/file.yo`

1. **Add `seek` operation** for random access within files
2. **Add file locking** (`flock`) for concurrent access control
3. **Add memory-mapped files** support for efficient large file access
4. **Add watch/notify** for file change monitoring
5. **Better error messages** with errno descriptions
6. **Add buffered operations** for improved performance with small reads/writes

---

## Notes

- All async operations should use io_uring on Linux for best performance
- Consider graceful degradation on systems without io_uring
- All APIs should be consistent with Yo's ownership/borrowing model
- Use `Result(T, E)` for fallible operations
- Use `Option(T)` for nullable returns
- Prefer immutable data structures where possible
