# Yo Standard Library Modules Plan

## Overview

With the low-level `std/sys` async I/O foundation complete (39 modules covering file, socket, process, mmap, signals, TTY, DNS, bufio, etc.), this plan covers building the **high-level standard library** that makes Yo battery-included. These modules sit on top of `std/sys` and provide ergonomic, type-safe APIs for common programming tasks.

## Algebraic Effects: Io and Exception

Async I/O in Yo is expressed via the **`Io` algebraic effect** for suspension/resumption via `io.await(...)`. Errors are propagated using the **`Exception` algebraic effect** — a non-resumable effect that throws `AnyError` values. This replaces the previous `Result(T, E)` approach, leveraging algebraic effects as the primary error handling mechanism.

Async functions that perform I/O take `using(io : Io)` as an implicit parameter. Fallible async operations include `Exception` in their `Future` return type: `Impl(Future(T, Io, Exception))`. The `Exception` effect is forwarded via the `io.async` closure — the outer function itself only needs `using(io : Io)` in its parameters, not `using(exn : Exception)`. Sync fallible functions take `using(exn : Exception)` directly in their parameter list.

```rust
// Async + fallible: only `using(io : Io)` in params, Exception in Future return type
File.open :: (fn(path: Path, mode: OpenMode, using(io : Io)) -> Impl(Future(File, Io, Exception))) ...;

// Sync functions that cannot fail return T directly:
File.position :: (fn(self: Self) -> i64) ...;

// Sync functions that can fail use Exception in params:
File.seek :: (fn(self: Self, offset: i64, whence: i32, using(exn : Exception)) -> i64) ...;
```

Byte buffers use `ArrayList(u8)` (not `Slice(u8)`).

## Current Standard Library Status

### What's Done

| Module              | File(s)                                 | Status      | Notes                                                                                                              |
| ------------------- | --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| **Prelude**         | `std/prelude.yo`                        | ✅ Complete | Core types, traits, operators, Box, Option, Result, Array, Slice; Io algebraic effect                              |
| **Error**           | `std/error.yo`                          | ✅ Complete | `Error` trait, `AnyError`, `Exception` / `ResumableException` effects                                              |
| **String**          | `std/string/`                           | ✅ Complete | Immutable UTF-8 `String`, `rune` (Unicode code point)                                                              |
| **Collections**     | `std/collections/`                      | ✅ Complete | `ArrayList`, `HashMap`, `HashSet`, `LinkedList`, `Deque`, `BTreeMap`, `PriorityQueue`                              |
| **Path**            | `std/path.yo`                           | ✅ Complete | Cross-platform path manipulation (join, parent, extension, normalize)                                              |
| **Process**         | `std/process.yo`                        | ✅ Complete | Platform/arch detection, args, env, cwd, chdir, exit                                                               |
| **Allocator**       | `std/allocator.yo`                      | ✅ Complete | `GlobalAllocator` (mimalloc/libc), `CustomAllocator` trait                                                         |
| **Format**          | `std/fmt/`                              | ✅ Complete | `ToString` trait, `Writer`, `Display`; `println`/`print`/`eprintln`                                                |
| **Hash**            | `std/alg/hash.yo`                       | ✅ Complete | FNV-1a hash function                                                                                               |
| **Sync**            | `std/sync/mutex.yo`, `std/sync/cond.yo` | ✅ Complete | `Mutex`, `Cond` (stack + GC-managed variants)                                                                      |
| **Sync Channel**    | `std/sync/channel.yo`                   | ✅ Complete | Bounded MPMC `Channel` — 15 single-threaded tests passing (cross-thread tests removed pending `Send`/`Iso` design) |
| **Sync RwLock**     | `std/sync/rwlock.yo`                    | ✅ Complete | `RwLock` — multiple-reader / single-writer lock                                                                    |
| **Sync WaitGroup**  | `std/sync/waitgroup.yo`                 | ✅ Complete | `WaitGroup` — wait for a group of tasks to complete                                                                |
| **Sync Once**       | `std/sync/once.yo`                      | ✅ Complete | `Once` — one-time thread-safe initialization                                                                       |
| **Thread**          | `std/thread.yo`                         | ✅ Complete | `Thread` (spawn/join), hardware thread count                                                                       |
| **Worker**          | `std/worker.yo`                         | ✅ Complete | Thread pool with round-robin task distribution                                                                     |
| **GC**              | `std/gc.yo`                             | ✅ Complete | `collect`, `tracked_count`                                                                                         |
| **Async**           | `std/async.yo`                          | ✅ Minimal  | Only `yield`; async/await uses Io algebraic effect                                                                 |
| **Time**            | `std/time/`                             | ✅ Complete | `Duration`, `Instant` (monotonic), `DateTime` (wall clock), `sleep` (sync) — 25 tests all passing                  |
| **Sys (low-level)** | `std/sys/` (39 files)                   | ✅ Complete | Full async I/O: file, socket, process, mmap, DNS, signals, TTY, bufio, etc.                                        |
| **Libc bindings**   | `std/libc/`                             | ✅ Complete | stdio, stdlib, string, math, errno, signal, etc.                                                                   |
| **FS**              | `std/fs/`                               | ✅ Complete | `File`, `Metadata`, `TempDir`, `TempFile`, directory walker — 44 tests passing with Exception effect               |
| **Net**             | `std/net/`                              | ✅ Complete | `TcpStream`, `TcpListener`, `UdpSocket`, `IpAddr`, DNS lookup — all using Exception effect                         |
| **OS**              | `std/os/`                               | ✅ Complete | Signal handling, environment directory utilities — all using Exception effect                                      |
| **Encoding**        | `std/encoding/`                         | ✅ Complete | Base64, hex, JSON, UTF-16 — all using Exception effect                                                             |
| **Crypto**          | `std/crypto/`                           | ✅ Complete | SHA-256, MD5, secure random, UUID v4 — all using Exception effect                                                  |
| **URL**             | `std/url/`                              | ✅ Complete | URL parser with Exception effect                                                                                   |
| **Regex**           | `std/regex/`                            | ✅ Complete | Regular expression engine                                                                                          |
| **Math**            | `std/math/`                             | ⏸ Deferred | `std/libc/math.yo` covers standard math; only needed for generic min/max/clamp, PRNG                               |
| **Log**             | `std/log/log.yo`                        | ✅ Complete | Structured logger — Level enum (Trace→Error), `set_level`/`set_output`, convenience helpers (`trace`…`error`)      |
| **Testing**         | `std/testing/assert.yo`, `bench.yo`     | ✅ Complete | Rich assertions (`assert_eq`/`ne`/`gt`/`lt`/`ge`/`le`/`approx`), micro-benchmarking with `BenchResult`             |

---

## API Naming Conventions

Async functions take `using(io : Io)` only — `Exception` appears only in the `Impl(Future(..., Exception))` return type. Sync fallible functions take `using(exn : Exception)` directly.

**Method naming rules:**

- `read(buf, size)` — low-level read into buffer
- `read_bytes()` — read all content as `ArrayList(u8)`
- `read_string()` — read all content as `String`
- `write_string(String)` — write String data
- `write_str(str)` — write str data
- `write_bytes(ArrayList(u8))` — write byte data
- `close()` — close resource
- `fd()` — get file descriptor
- Boolean predicates use `is_*` prefix

**Standalone function naming rules:**

- `read_file(Path)` → `ArrayList(u8)` (read file as bytes)
- `read_string(Path)` → `String` (read file as String)
- `write_file(Path, String)` → writes String to file
- `write_bytes(Path, ArrayList(u8))` → writes bytes to file
- `_str` suffix = path parameter is `str` instead of `Path`
- `_cstr` suffix = path parameter is `*(u8)` instead of `Path`

---

## Phase 1: High-Level File System (`std/fs`) — ✅ Done

**Status**: All 5 modules implemented with Exception effect. 44 tests passing (file: 13, dir: 12, temp: 7, metadata: 6, walker: 6). All tests verified with AddressSanitizer (no leaks, no use-after-free).

**Depends on**: `std/sys/file`, `std/sys/dir`, `std/sys/seek`, `std/sys/path`, `std/sys/statx`, `std/sys/perm`, `std/sys/temp`, `std/path`, `std/string`

### 1.1 `std/fs/file.yo` — File Object

A high-level `File` object wrapping a file descriptor with buffered I/O.

```rust
// Open mode — determines how the file is opened
OpenMode :: enum(
  Read,        // O_RDONLY — read existing file
  Write,       // O_WRONLY | O_CREAT | O_TRUNC — create/overwrite
  Append,      // O_WRONLY | O_CREAT | O_APPEND — append to file
  ReadWrite,   // O_RDWR — read and write existing file
  CreateNew    // O_WRONLY | O_CREAT | O_EXCL — create new, fail if exists
);

// File permissions (Unix mode bits)
FilePermission :: newtype(mode : u32);
FilePermission.default :: (fn() -> FilePermission) ...;       // 0o644 (rw-r--r--)
FilePermission.executable :: (fn() -> FilePermission) ...;    // 0o755 (rwxr-xr-x)
FilePermission.readonly :: (fn() -> FilePermission) ...;      // 0o444 (r--r--r--)
FilePermission.private :: (fn() -> FilePermission) ...;       // 0o600 (rw-------)

File :: object(
  fd : i32,
  path : Path,
  _read_buf : ArrayList(u8),
  _write_buf : ArrayList(u8),
  _position : i64,
  _is_closed : bool
);

// Static constructors — default takes Path, _str takes str, _cstr takes *(u8)
// File.open uses FilePermission.default() when creating files
// Note: async functions only take `using(io : Io)` — Exception is in the Future return type only
File.open :: (fn(path: Path, mode: OpenMode, using(io : Io)) -> Impl(Future(File, Io, Exception))) ...;
File.open_str :: (fn(path: str, mode: OpenMode, using(io : Io)) -> Impl(Future(File, Io, Exception))) ...;
File.open_cstr :: (fn(path: *(u8), mode: OpenMode, using(io : Io)) -> Impl(Future(File, Io, Exception))) ...;
// File.open_with allows specifying custom file permissions
File.open_with :: (fn(path: Path, mode: OpenMode, perm: FilePermission, using(io : Io)) -> Impl(Future(File, Io, Exception))) ...;
File.open_with_str :: (fn(path: str, mode: OpenMode, perm: FilePermission, using(io : Io)) -> Impl(Future(File, Io, Exception))) ...;
File.open_with_cstr :: (fn(path: *(u8), mode: OpenMode, perm: FilePermission, using(io : Io)) -> Impl(Future(File, Io, Exception))) ...;

// Instance methods
File.read :: (fn(self: Self, buf: *(u8), size: u32, using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
File.write_string :: (fn(self: Self, data: String, using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
File.write_bytes :: (fn(self: Self, data: ArrayList(u8), using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
File.read_bytes :: (fn(self: Self, using(io : Io)) -> Impl(Future(ArrayList(u8), Io, Exception))) ...;
File.read_string :: (fn(self: Self, using(io : Io)) -> Impl(Future(String, Io, Exception))) ...;
File.flush :: (fn(self: Self, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
File.seek :: (fn(self: Self, offset: i64, whence: i32, using(exn : Exception)) -> i64) ...;
File.position :: (fn(self: Self) -> i64) ...;
File.size :: (fn(self: Self) -> i64) ...;
File.close :: (fn(self: Self, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
File.metadata :: (fn(self: Self, using(io : Io)) -> Impl(Future(Metadata, Io, Exception))) ...;

// Convenience functions (no File object needed)
// Default takes Path; _str takes str; _cstr takes *(u8)
// Note: async functions only take `using(io : Io)` — Exception is in the Future return type only
read_file :: (fn(path: Path, using(io : Io)) -> Impl(Future(ArrayList(u8), Io, Exception))) ...;
read_file_str :: (fn(path: str, using(io : Io)) -> Impl(Future(ArrayList(u8), Io, Exception))) ...;
read_file_cstr :: (fn(path: *(u8), using(io : Io)) -> Impl(Future(ArrayList(u8), Io, Exception))) ...;
read_string :: (fn(path: Path, using(io : Io)) -> Impl(Future(String, Io, Exception))) ...;
read_string_str :: (fn(path: str, using(io : Io)) -> Impl(Future(String, Io, Exception))) ...;
read_string_cstr :: (fn(path: *(u8), using(io : Io)) -> Impl(Future(String, Io, Exception))) ...;
write_file :: (fn(path: Path, data: String, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
write_file_str :: (fn(path: str, data: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
write_file_cstr :: (fn(path: *(u8), data: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
write_bytes :: (fn(path: Path, data: ArrayList(u8), using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
append_file :: (fn(path: Path, data: String, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
append_file_str :: (fn(path: str, data: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
exists :: (fn(path: Path, using(io : Io)) -> Impl(Future(bool, Io))) ...;
exists_str :: (fn(path: str, using(io : Io)) -> Impl(Future(bool, Io))) ...;
exists_cstr :: (fn(path: *(u8), using(io : Io)) -> Impl(Future(bool, Io))) ...;
```

### 1.2 `std/fs/metadata.yo` — File Metadata

```rust
Metadata :: struct(
  _buf : ArrayList(u8)
);

Metadata.size :: (fn(self: *(Self)) -> i64) ...;
Metadata.mode :: (fn(self: *(Self)) -> u32) ...;
Metadata.is_file :: (fn(self: *(Self)) -> bool) ...;
Metadata.is_dir :: (fn(self: *(Self)) -> bool) ...;
Metadata.is_symlink :: (fn(self: *(Self)) -> bool) ...;
Metadata.modified_time :: (fn(self: *(Self)) -> i64) ...;
Metadata.accessed_time :: (fn(self: *(Self)) -> i64) ...;
Metadata.created_time :: (fn(self: *(Self)) -> i64) ...;
Metadata.permissions :: (fn(self: *(Self)) -> Permissions) ...;

Permissions :: struct(mode: u32);
Permissions.readonly :: (fn(self: *(Self)) -> bool) ...;
Permissions.set_readonly :: (fn(self: *(Self), readonly: bool) -> unit) ...;

// Convenience — default takes Path; _str takes str
metadata :: (fn(path: Path, using(io : Io)) -> Impl(Future(Metadata, Io, Exception))) ...;
metadata_str :: (fn(path: str, using(io : Io)) -> Impl(Future(Metadata, Io, Exception))) ...;
symlink_metadata :: (fn(path: Path, using(io : Io)) -> Impl(Future(Metadata, Io, Exception))) ...;
symlink_metadata_str :: (fn(path: str, using(io : Io)) -> Impl(Future(Metadata, Io, Exception))) ...;
```

### 1.3 `std/fs/dir.yo` — Directory Operations

```rust
// High-level directory operations — default takes Path; _str variants available
create_dir :: (fn(path: Path, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
create_dir_str :: (fn(path: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
create_dir_all :: (fn(path: Path, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
create_dir_all_str :: (fn(path: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
remove_dir :: (fn(path: Path, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
remove_dir_str :: (fn(path: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
remove_file :: (fn(path: Path, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
remove_file_str :: (fn(path: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
rename :: (fn(from: Path, to: Path, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
rename_str :: (fn(from: str, to: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
hard_link :: (fn(src: Path, dst: Path, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
hard_link_str :: (fn(src: str, dst: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
symlink :: (fn(src: Path, dst: Path, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
symlink_str :: (fn(src: str, dst: str, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;

// Directory listing
DirEntry :: struct(
  name : String,
  path : Path,
  file_type : FileType,
  ino : u64
);

FileType :: enum(File, Directory, Symlink, Other);   // note: no leading dots in enum declaration

read_dir :: (fn(path: Path, using(io : Io)) -> Impl(Future(ArrayList(DirEntry), Io, Exception))) ...;
read_dir_str :: (fn(path: str, using(io : Io)) -> Impl(Future(ArrayList(DirEntry), Io, Exception))) ...;
```

### 1.4 `std/fs/walker.yo` — Recursive Directory Traversal

```rust
WalkEntry :: struct(
  path : Path,
  name : String,
  depth : u32,
  file_type : FileType
);

WalkOptions :: struct(
  max_depth : Option(u32),
  follow_symlinks : bool,
  include_dirs : bool
);

walk :: (fn(root: Path, using(io : Io)) -> Impl(Future(ArrayList(WalkEntry), Io, Exception))) ...;
walk_cstr :: (fn(root: *(u8), using(io : Io)) -> Impl(Future(ArrayList(WalkEntry), Io, Exception))) ...;
walk_with :: (fn(root: Path, options: WalkOptions, using(io : Io)) -> Impl(Future(ArrayList(WalkEntry), Io, Exception))) ...;
walk_with_cstr :: (fn(root: *(u8), options: WalkOptions, using(io : Io)) -> Impl(Future(ArrayList(WalkEntry), Io, Exception))) ...;
```

### 1.5 `std/fs/temp.yo` — Temporary Files and Directories

```rust
TempDir :: object(
  _path : Path,
  _removed : bool
);
TempDir.new :: (fn(using(io : Io)) -> Impl(Future(TempDir, Io, Exception))) ...;
TempDir.new_in :: (fn(parent: Path, using(io : Io)) -> Impl(Future(TempDir, Io, Exception))) ...;
TempDir.path :: (fn(self: Self) -> Path) ...;
TempDir.remove :: (fn(self: Self, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;

TempFile :: object(
  file : File,
  _path : Path
);
TempFile.new :: (fn(using(io : Io)) -> Impl(Future(TempFile, Io, Exception))) ...;
TempFile.new_in :: (fn(parent: Path, using(io : Io)) -> Impl(Future(TempFile, Io, Exception))) ...;
TempFile.path :: (fn(self: Self) -> Path) ...;
TempFile.remove :: (fn(self: Self, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
```

**Tests**: File read/write round-trip, buffered I/O, read_string, metadata queries, create_dir_all, remove_dir_all, directory walk, temp file/dir auto-cleanup.

---

## Phase 2: High-Level Networking (`std/net`) — Priority: Critical — ✅ Done

**Goal**: Provide ergonomic async TCP/UDP client and server types. This is the second most important module for building real applications.

**Status**: All modules implemented with Exception effect. Tests: errors 9/9, addr 5/6, tcp 10/10, udp 5/5, dns 3/3. Note: addr has 1 known RC leak on error path (escape propagation limitation).

**Depends on**: `std/sys/tcp`, `std/sys/udp`, `std/sys/dns`, `std/sys/socket`, `std/string`

### 2.1 `std/net/errors.yo` — Network Errors

```rust
NetError :: enum(
  ConnectionRefused,
  ConnectionReset,
  ConnectionAborted,
  AddrInUse,
  AddrNotAvailable,
  TimedOut,
  HostUnreachable,
  NetworkUnreachable,
  DNSFailed(msg: String),
  Io(err: IoError),
  Other(msg: String)
);

// Helpers
NetError.from_io :: (fn(err: IoError) -> Self) ...;        // Maps IoError variants to NetError
NetError.check :: (fn(result: i32, using(exn : Exception)) -> i32) ...;  // Throws on error result codes
```

### 2.2 `std/net/addr.yo` — Network Addresses

```rust
IpAddr :: enum(
  V4(a: u8, b: u8, c: u8, d: u8),
  V6(segments: Array(u16, usize(8)))
);

IpAddr.parse_v4 :: (fn(s: String, using(exn : Exception)) -> IpAddr) ...;
IpAddr.loopback_v4 :: (fn() -> IpAddr) ...;
IpAddr.loopback_v6 :: (fn() -> IpAddr) ...;
IpAddr.any_v4 :: (fn() -> IpAddr) ...;
IpAddr.is_loopback :: (fn(self: Self) -> bool) ...;
IpAddr.is_v4 :: (fn(self: Self) -> bool) ...;
IpAddr.is_v6 :: (fn(self: Self) -> bool) ...;
// Implements ToString

SocketAddr :: struct(
  ip   : IpAddr,
  port : u16
);

SocketAddr.new :: (fn(ip: IpAddr, port: u16) -> Self) ...;
SocketAddr.loopback :: (fn(port: u16) -> Self) ...;
SocketAddr.any :: (fn(port: u16) -> Self) ...;
// Implements ToString
```

### 2.3 `std/net/tcp.yo` — TCP Client and Server

```rust
TcpListener :: object(
  _fd         : i32,
  _local_addr : SocketAddr
);

TcpListener.bind :: (fn(addr: SocketAddr, using(io : Io)) -> Impl(Future(TcpListener, Io, Exception))) ...;
TcpListener.accept :: (fn(self: Self, using(io : Io)) -> Impl(Future(TcpStream, Io, Exception))) ...;
TcpListener.local_addr :: (fn(self: Self) -> SocketAddr) ...;
TcpListener.close :: (fn(self: Self, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
TcpListener.fd :: (fn(self: Self) -> i32) ...;
// Implements Dispose

TcpStream :: object(
  _fd        : i32,
  _peer_addr : SocketAddr,
  _is_closed : bool
);

TcpStream.connect :: (fn(addr: SocketAddr, using(io : Io)) -> Impl(Future(TcpStream, Io, Exception))) ...;
TcpStream.read :: (fn(self: Self, buf: *(u8), size: usize, using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
TcpStream.write_str :: (fn(self: Self, data: str, using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
TcpStream.write_string :: (fn(self: Self, data: String, using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
TcpStream.write_bytes :: (fn(self: Self, data: ArrayList(u8), using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
TcpStream.read_bytes :: (fn(self: Self, using(io : Io)) -> Impl(Future(ArrayList(u8), Io, Exception))) ...;
TcpStream.shutdown :: (fn(self: Self, how: i32, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
TcpStream.close :: (fn(self: Self, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
TcpStream.peer_addr :: (fn(self: Self) -> SocketAddr) ...;
TcpStream.fd :: (fn(self: Self) -> i32) ...;
TcpStream.set_nodelay :: (fn(self: Self, nodelay: bool, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
TcpStream.set_keepalive :: (fn(self: Self, enabled: bool, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
// Implements Dispose
```

### 2.4 `std/net/udp.yo` — UDP Socket

```rust
UdpSocket :: object(
  _fd         : i32,
  _local_addr : SocketAddr,
  _is_closed  : bool
);

UdpSocket.bind :: (fn(addr: SocketAddr, using(io : Io)) -> Impl(Future(UdpSocket, Io, Exception))) ...;
UdpSocket.send_to :: (fn(self: Self, data: ArrayList(u8), addr: SocketAddr, using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
UdpSocket.recv :: (fn(self: Self, buf: *(u8), size: usize, using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
UdpSocket.recv_from :: (fn(self: Self, buf: *(u8), size: usize, src_addr: *(u8), src_addr_len: *(u32), using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
UdpSocket.send :: (fn(self: Self, data: ArrayList(u8), using(io : Io)) -> Impl(Future(i32, Io, Exception))) ...;
UdpSocket.close :: (fn(self: Self, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
UdpSocket.set_broadcast :: (fn(self: Self, enabled: bool, using(io : Io)) -> Impl(Future(unit, Io, Exception))) ...;
UdpSocket.local_addr :: (fn(self: Self) -> SocketAddr) ...;
UdpSocket.fd :: (fn(self: Self) -> i32) ...;
// Implements Dispose
```

### 2.5 `std/net/dns.yo` — DNS Resolution

```rust
lookup_host :: (fn(host: String, using(io : Io)) -> Impl(Future(ArrayList(IpAddr), Io, Exception))) ...;
resolve :: (fn(host: String, port: u16, using(io : Io)) -> Impl(Future(ArrayList(SocketAddr), Io, Exception))) ...;
```

**Tests**: TCP echo server/client with typed API, UDP datagram exchange, DNS lookup, address parsing/formatting, connection error handling.

**Test files** (all passing):

- `tests/net/addr.test.yo` — 6 tests (IpAddr parsing, loopback, SocketAddr, ToString; 1 known RC leak on error path)
- `tests/net/errors.test.yo` — 9 tests (NetError variants, from_io, check, ToString)
- `tests/net/tcp.test.yo` — 10 tests (bind/close, local_addr, connect/accept, write_str/read echo, write String, write_bytes, set_nodelay/set_keepalive, shutdown, peer_addr, read_all)
- `tests/net/udp.test.yo` — 5 tests (bind/close, local_addr, send_to/recv, recv_from, set_broadcast)
- `tests/net/dns.test.yo` — 3 tests (lookup_host localhost, invalid host, resolve)

---

## Phase 3: Time and Duration (`std/time`) — Priority: High

**Goal**: Rich time support with Duration, Instant (monotonic), and DateTime (wall clock). Essential for benchmarking, logging, timeouts, and scheduling.

**Depends on**: `std/sys/clock`, `std/sys/timer`, `std/string`, `std/fmt`

### 3.1 `std/time/duration.yo` — Time Duration

```rust
Duration :: struct(
  secs : i64,
  nanos : i64
);

Duration.from_secs :: (fn(secs: i64) -> Duration) ...;
Duration.from_millis :: (fn(millis: i64) -> Duration) ...;
Duration.from_micros :: (fn(micros: i64) -> Duration) ...;
Duration.from_nanos :: (fn(nanos: i64) -> Duration) ...;
Duration.zero :: (fn() -> Duration) ...;
Duration.as_secs :: (fn(self: *(Self)) -> i64) ...;
Duration.as_millis :: (fn(self: *(Self)) -> i64) ...;
Duration.as_micros :: (fn(self: *(Self)) -> i64) ...;
Duration.as_nanos :: (fn(self: *(Self)) -> i64) ...;
Duration.as_secs_f64 :: (fn(self: *(Self)) -> f64) ...;
Duration.add :: (fn(self: *(Self), other: Duration) -> Duration) ...;
Duration.sub :: (fn(self: *(Self), other: Duration) -> Duration) ...;
Duration.is_zero :: (fn(self: *(Self)) -> bool) ...;
```

### 3.2 `std/time/instant.yo` — Monotonic Clock

```rust
Instant :: struct(
  secs : i64,
  nanos : i64
);

Instant.now :: (fn() -> Instant) ...;
Instant.elapsed :: (fn(self: *(Self)) -> Duration) ...;
Instant.duration_since :: (fn(self: *(Self), earlier: Instant) -> Duration) ...;
```

### 3.3 `std/time/datetime.yo` — Wall Clock Time

```rust
DateTime :: struct(
  year : i32,
  month : u8,
  day : u8,
  hour : u8,
  minute : u8,
  second : u8,
  nanosecond : u32,
  utc_offset_secs : i32
);

DateTime.now :: (fn() -> DateTime) ...;
DateTime.now_utc :: (fn() -> DateTime) ...;
DateTime.from_unix :: (fn(secs: i64, nanos: i64) -> DateTime) ...;
DateTime.to_unix :: (fn(self: *(Self)) -> i64) ...;
DateTime.format :: (fn(self: *(Self), fmt: str) -> String) ...;
DateTime.to_string :: (fn(self: *(Self)) -> String) ...;
DateTime.is_leap_year :: (fn(self: *(Self)) -> bool) ...;
DateTime.day_of_week :: (fn(self: *(Self)) -> u8) ...;
DateTime.day_of_year :: (fn(self: *(Self)) -> u16) ...;
```

**Tests**: Duration arithmetic, Instant elapsed measurement, DateTime formatting, Unix timestamp round-trip, leap year detection.

**Test files** (all passing):

- `tests/time/duration.test.yo` — 12 tests (from_secs/millis/micros/nanos, zero, add, add with nanos overflow, sub normal, sub saturates to zero, as_secs_f64, is_zero, to_string)
- `tests/time/instant.test.yo` — 4 tests (now returns non-zero, elapsed non-negative, duration_since two instants, duration_since earlier returns zero)
- `tests/time/datetime.test.yo` — 9 tests (now_utc valid date, from_unix epoch, from_unix known date, to_unix round-trip, to_unix epoch round-trip, is_leap_year, day_of_week, day_of_year, to_string ISO 8601)

---

## Phase 4: String Formatting (`std/fmt`) — ✅ Done

**Status**: Complete. `std/fmt/` provides `ToString` trait, `Writer`, `Display`, and `println`/`print`/`eprintln` functions. Template strings (`` `Hello ${name}` ``) with `ToString` trait provide string formatting.

---

## Phase 5: Encoding & Serialization (`std/encoding`) — ✅ Done

**Goal**: Common data encoding/decoding formats essential for network protocols, file formats, and data interchange.

**Depends on**: `std/string`, `std/collections/array_list`

**Status**: All modules implemented and tested (71 tests total).

### 5.1 `std/encoding/hex.yo` — Hexadecimal (11 tests)

```rust
hex_encode :: (fn(data: ArrayList(u8)) -> String) ...;
hex_decode :: (fn(s: str, using(exn : Exception)) -> ArrayList(u8)) ...;
```

### 5.2 `std/encoding/base64.yo` — Base64 (13 tests)

```rust
base64_encode :: (fn(data: ArrayList(u8)) -> String) ...;
base64_decode :: (fn(s: str, using(exn : Exception)) -> ArrayList(u8)) ...;
base64_encode_url :: (fn(data: ArrayList(u8)) -> String) ...;
base64_decode_url :: (fn(s: str, using(exn : Exception)) -> ArrayList(u8)) ...;
```

### 5.3 `std/encoding/json.yo` — JSON (35 tests)

Uses `ArrayList` pairs for Object (keys + values) instead of `HashMap` due to `HashMap(String, Self)` not being supported with recursive enum types.

```rust
JsonValue :: enum(
  Null,
  Bool(value: bool),
  Number(value: f64),
  Str(value: String),
  Array(items: ArrayList(Self)),
  Object(keys: ArrayList(String), values: ArrayList(Self))
);

json_parse :: (fn(s: str, using(exn : Exception)) -> JsonValue) ...;
json_stringify :: (fn(value: JsonValue) -> String) ...;

JsonValue.get :: (fn(self: Self, key: String) -> Option(JsonValue)) ...;
JsonValue.at :: (fn(self: Self, index: usize) -> Option(JsonValue)) ...;
JsonValue.as_bool :: (fn(self: Self) -> Option(bool)) ...;
JsonValue.as_number :: (fn(self: Self) -> Option(f64)) ...;
JsonValue.as_string :: (fn(self: Self) -> Option(String)) ...;
JsonValue.as_array :: (fn(self: Self) -> Option(ArrayList(JsonValue))) ...;
JsonValue.as_object :: (fn(self: Self) -> Option(ArrayList(JsonKV))) ...;
```

### 5.4 `std/encoding/utf16.yo` — UTF-16 (12 tests)

```rust
utf8_to_utf16 :: (fn(s: str) -> ArrayList(u16)) ...;
utf16_to_utf8 :: (fn(data: ArrayList(u16), using(exn : Exception)) -> String) ...;
```

**Tests**: `tests/encoding/hex.test.yo` (11), `tests/encoding/base64.test.yo` (13), `tests/encoding/json.test.yo` (35), `tests/encoding/utf16.test.yo` (12) — all passing. Note: error-path tests may show RC leaks due to a known escape propagation limitation.

---

## Phase 6: Cryptographic Hashing & Random (`std/crypto`) — ✅ Done

**Goal**: Common hash functions and cryptographically secure random number generation. Essential for security, checksums, and unique ID generation.

**Depends on**: `std/string`, `std/collections/array_list`

**Status**: All modules implemented and tested (33 tests total).

### 6.1 `std/crypto/sha256.yo` — SHA-256

```rust
Sha256 :: object(state: ...);
Sha256.new :: (fn() -> Sha256) ...;
Sha256.update :: (fn(self: Self, data: ArrayList(u8)) -> Self) ...;
Sha256.finish :: (fn(self: Self) -> Array(u8, usize(32))) ...;

sha256 :: (fn(data: ArrayList(u8)) -> Array(u8, usize(32))) ...;
sha256_hex :: (fn(data: ArrayList(u8)) -> String) ...;
```

### 6.2 `std/crypto/md5.yo` — MD5

```rust
md5 :: (fn(data: ArrayList(u8)) -> Array(u8, usize(16))) ...;
md5_hex :: (fn(data: ArrayList(u8)) -> String) ...;
```

### 6.3 `std/crypto/random.yo` — Secure Random

```rust
random_bytes :: (fn(buf: *(u8), size: usize, using(exn : Exception)) -> unit) ...;
random_u32 :: (fn() -> u32) ...;
random_u64 :: (fn() -> u64) ...;
random_f64 :: (fn() -> f64) ...;
random_range :: (fn(min: i64, max: i64) -> i64) ...;
uuid_v4 :: (fn() -> String) ...;
```

Cross-platform: Linux `getrandom()`, macOS `arc4random_buf()`, Windows `BCryptGenRandom()`.

**Test files** (all passing):

- `tests/crypto/sha256.test.yo` — 12 tests (known vectors: empty, abc, hello world, The quick brown fox; raw digest; streaming: chunked, byte-by-byte, empty update; edge cases: 55/56/64/90+ bytes)
- `tests/crypto/md5.test.yo` — 11 tests (RFC 1321 vectors: empty, a, abc, message digest, alphabet, alphanumeric, numeric sequence; raw digest; edge cases: 55/56/64 bytes)
- `tests/crypto/random.test.yo` — 10 tests (random_bytes fill + differ, random_u32, random_u64, random_f64 range, random_range bounds + single + zero span, uuid_v4 format + uniqueness)

---

## Phase 7: Math Extensions (`std/math`) — ⏸ Deferred

**Status**: Deferred. The `std/libc/math.yo` already exposes all standard math functions (`sin`, `cos`, `sqrt`, `pow`, `floor`, `ceil`, `fabs`, etc.) from C's `math.h`. A separate `std/math` module would only be needed for Yo-native generic utilities (min/max/clamp with trait constraints, lerp, PRNG). These can be added when a concrete use case arises.

---

## Phase 8: Error Handling (`std/error`) — ✅ Done

**Status**: Complete. `std/error.yo` provides:

- `Error` trait — standard interface for typed error propagation (requires `ToString`)
- `AnyError` (`Dyn(Error)`) — type-erased error value for cross-module error passing
- `Exception` — non-resumable exception effect; `exn.throw(error)` discards the continuation
- `ResumableException(ResumeType)` — resumable exception effect (handler can supply a fallback value)

All fallible operations in the standard library use the `Exception` effect instead of `Result(T, E)`. This makes error handling compositional via algebraic effects — callers install `given(exn) : Exception` handlers to catch errors.

---

## Phase 9: Logging (`std/log`) — ✅ Done

**Status**: Complete. `std/log/log.yo` provides a structured logger with:

- `Level` enum — Trace, Debug, Info, Warn, Error
- `set_level(level)` / `set_output(file)` — configure log level and output destination
- Convenience functions: `trace()`, `debug()`, `info()`, `warn()`, `error()`

---

## Phase 10: Testing Utilities (`std/testing`) — ✅ Done

**Status**: Complete. `std/testing/` provides:

- `assert.yo` — Rich typed assertions: `assert_eq`, `assert_ne`, `assert_gt`, `assert_lt`, `assert_ge`, `assert_le`, `assert_approx` (with generic type constraints)
- `bench.yo` — Micro-benchmarking with `BenchResult` struct and `bench()` function for timing statistics

---

## Phase 11: Advanced Collections (`std/collections`) — Priority: Low

**Goal**: Additional data structures beyond the existing ArrayList, HashMap, HashSet, LinkedList.

**Depends on**: `std/allocator`, `std/fmt`

### 11.1 `std/collections/deque.yo` — Double-Ended Queue

```rust
Deque :: (fn(comptime(T) : Type) -> comptime(Type))
  object(
    _buf : Option(*(T)),
    _head : usize,
    _tail : usize,
    _capacity : usize
  )
;

Deque.push_front :: ...;
Deque.push_back :: ...;
Deque.pop_front :: ...;
Deque.pop_back :: ...;
Deque.get :: ...;
Deque.len :: ...;
```

### 11.2 `std/collections/btree_map.yo` — Sorted Map (B-Tree)

```rust
BTreeMap :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))
  object(...)
;

BTreeMap.get :: ...;
BTreeMap.set :: ...;
BTreeMap.remove :: ...;
BTreeMap.min :: ...;
BTreeMap.max :: ...;
BTreeMap.range :: ...;
BTreeMap.iter :: ...;
```

### 11.3 `std/collections/priority_queue.yo` — Binary Heap

```rust
PriorityQueue :: (fn(comptime(T) : Type) -> comptime(Type))
  object(...)
;

PriorityQueue.push :: ...;
PriorityQueue.pop :: ...;
PriorityQueue.peek :: ...;
PriorityQueue.len :: ...;
```

**Tests**: Deque push/pop from both ends, BTreeMap ordered iteration, PriorityQueue min-heap property.

---

## Phase 12: OS Utilities (`std/os`) — ✅ Done

**Goal**: OS-level utilities that don't fit in `std/sys` or `std/process`.

**Depends on**: `std/sys/signal`, `std/sys/sysinfo`, `std/string`

**Tests**: 10 tests passing (env: 7, signal: 3)

### 12.1 `std/os/signal.yo` — High-Level Signal Handling

```rust
Signal :: enum(
  Interrupt,
  Terminate,
  Hangup,
  User1,
  User2,
  Pipe,
  Alarm,
  Child
);

SignalHandler :: (fn(data: *(u8)) -> unit);  // re-exported from std/sys/signal

on_signal :: (fn(sig: Signal, handler: SignalHandler, using(exn : Exception)) -> unit) ...;
off_signal :: (fn(sig: Signal, using(exn : Exception)) -> unit) ...;
```

### 12.2 `std/os/env.yo` — Environment Utilities

```rust
home_dir :: (fn() -> Option(String)) ...;
config_dir :: (fn() -> Option(String)) ...;
cache_dir :: (fn() -> Option(String)) ...;
temp_dir :: (fn() -> String) ...;
```

**Test files**: `tests/os/env.test.yo` (7 tests), `tests/os/signal.test.yo` (3 tests)

---

## Dependency Graph

```
Phase 1  (std/fs)          ← CRITICAL — every program needs file I/O
  └── Depends on: std/sys/file, std/sys/dir, std/sys/seek, std/sys/statx, std/sys/perm
                  std/sys/temp, std/path, std/string, std/collections

Phase 2  (std/net)         ← CRITICAL — needed for any networked application
  └── Depends on: std/sys/tcp, std/sys/udp, std/sys/unix, std/sys/dns
                  std/sys/sockinfo, std/string, std/collections

Phase 3  (std/time)        ← HIGH — needed for benchmarks, logging, scheduling
  └── Depends on: std/sys/clock, std/sys/timer

Phase 4  (std/fmt)         ← HIGH — needed for Display, logging, debugging
  └── Depends on: std/string, std/fmt/to_string

Phase 5  (std/encoding)    ← MEDIUM — JSON, base64, hex
  └── Depends on: std/string, std/collections

Phase 6  (std/crypto)      ← MEDIUM — hashing, random
  └── Depends on: std/string, std/encoding/hex (for hex output)

Phase 7  (std/math)        ← MEDIUM — math utilities, PRNG
  └── Depends on: std/libc/math

Phase 8  (std/error)       ← HIGH — error trait foundation
  └── Depends on: std/string, std/fmt

Phase 9  (std/log)         ← LOW — structured logging
  └── Depends on: std/time (Phase 3), std/fmt (Phase 4), std/fs (Phase 1)

Phase 10 (std/testing)     ← LOW — test helpers
  └── Depends on: std/fmt (Phase 4), std/time (Phase 3)

Phase 11 (std/collections) ← LOW — additional data structures
  └── Depends on: std/allocator

Phase 12 (std/os)          ← LOW — OS utilities
  └── Depends on: std/sys/signal, std/sys/sysinfo, std/string
```

## Phase 13: Channel (`std/sync/channel`) — ✅ Done

**Goal**: Provide a bounded multi-producer, multi-consumer channel for sending values between threads and workers. This is the most important missing concurrency primitive.

**Depends on**: `std/sync` (Mutex, Cond), `std/collections/deque`

**Tests**: 15 tests passing — `tests/sync/channel.test.yo`

**Note**: Thread/Worker integration tests were removed after fixing `Send` trait enforcement. `Channel(T)` is an `object` type (non-atomic RC) which does not implement `Send`, so it cannot be captured in thread closures. Cross-thread channel tests require either `Iso(Channel(T))` wrapping or making Channel use atomic RC. See `plans/backlog/MULTI_CLOSURE_RC_BUG.md` for details.

### Design Decision: Sync (blocking) vs Async

The Channel uses **blocking** `send`/`recv` via condition variables rather than async/await (`using(io : Io)`). Rationale:

1. **Works everywhere**: Channels are used with both `Thread` and `Worker`. Neither requires an Io effect context, so a sync Channel is more universally applicable.
2. **Simpler mental model**: `send()` blocks when the buffer is full; `recv()` blocks when the buffer is empty. No need to manage Io effects or futures for basic message passing.
3. **Channel is a synchronization primitive, not I/O**: Like Mutex and Cond, Channel belongs in `std/sync`, not `std/sys`.
4. **Async wrapping is easy**: If async semantics are needed, users can wrap `recv()` in `io.async(...)`:
   ```rust
   // Async recv — non-blocking in Io context
   async_recv := io.async((using(io : Io)) => {
     return ch.recv();
   });
   ```
5. **Precedent**: Go channels are synchronous. Rust's `std::sync::mpsc` is synchronous. Async channels (like Tokio's) are a separate abstraction.

### 13.1 `std/sync/channel.yo` — Bounded MPMC Channel

```rust
Channel :: (fn(comptime(T) : Type) -> comptime(Type))
  object(
    _buf      : Deque(T),
    _capacity : usize,
    _mutex    : Mutex,
    _not_empty : Cond,
    _not_full  : Cond,
    _closed   : bool
  )
;

Channel.new :: (fn(capacity: usize) -> Channel(T)) ...;
Channel.send :: (fn(self: Self, value: T) -> Result(unit, unit)) ...;
Channel.recv :: (fn(self: Self) -> Option(T)) ...;
Channel.try_send :: (fn(self: Self, value: T) -> Result(unit, unit)) ...;
Channel.try_recv :: (fn(self: Self) -> Option(T)) ...;
Channel.close :: (fn(self: Self) -> unit) ...;
Channel.is_closed :: (fn(self: Self) -> bool) ...;
Channel.len :: (fn(self: Self) -> usize) ...;
Channel.is_empty :: (fn(self: Self) -> bool) ...;
```

**Test coverage** (15 tests):

- Basic: new, send/recv, FIFO order, capacity fill (4 tests)
- Non-blocking: try_send success/fail, try_recv success/empty (4 tests)
- Close: close flag, send-after-close, try_send-after-close, drain-after-close, try_recv-after-close (5 tests)
- Edge cases: bool type, usize type (2 tests)

**Removed tests** (8 tests — require `Send`/`Iso` design for cross-thread sharing):

- Thread: single producer/consumer, many values, consumer blocks, close wakes consumer
- Worker: send from worker, multiple values
- Back-pressure: bounded capacity blocks producer
- Edge cases: capacity-1 rendezvous

**Known limitation**: Capturing the same `object` (Rc-managed) in multiple closures within the same scope causes a codegen double-free bug. Tests avoid this by using a single closure per channel reference.

---

## Phase 14: Additional Suggested Modules — Priority: Various

### 14.1 `std/sync/rwlock.yo` — Reader-Writer Lock (Priority: Medium)

A lock that allows multiple concurrent readers or one exclusive writer.

```rust
RwLock :: object(
  _readers : i32,
  _writer  : bool,
  _mutex   : Mutex,
  _read_cv : Cond,
  _write_cv : Cond
);

RwLock.new :: (fn() -> RwLock) ...;
RwLock.read_lock :: (fn(self: Self) -> unit) ...;
RwLock.read_unlock :: (fn(self: Self) -> unit) ...;
RwLock.write_lock :: (fn(self: Self) -> unit) ...;
RwLock.write_unlock :: (fn(self: Self) -> unit) ...;
```

### 14.2 `std/sync/waitgroup.yo` — WaitGroup (Priority: Medium)

Wait for a group of tasks to complete. Similar to Go's `sync.WaitGroup`.

```rust
WaitGroup :: object(
  _count : i32,
  _mutex : Mutex,
  _cv    : Cond
);

WaitGroup.new :: (fn() -> WaitGroup) ...;
WaitGroup.add :: (fn(self: Self, delta: i32) -> unit) ...;
WaitGroup.done :: (fn(self: Self) -> unit) ...;
WaitGroup.wait :: (fn(self: Self) -> unit) ...;
```

### 14.3 `std/sync/once.yo` — One-Time Initialization (Priority: Low)

Execute a function exactly once, thread-safely.

```rust
Once :: object(
  _done  : bool,
  _mutex : Mutex
);

Once.new :: (fn() -> Once) ...;
Once.call :: (fn(self: Self, f: Fn(() -> unit)) -> unit) ...;
```

### 14.4 `std/url/` — URL Parsing (Priority: Low, Future)

Parse and manipulate URLs.

```rust
Url :: object(
  scheme : String,
  host   : String,
  port   : Option(u16),
  path   : String,
  query  : Option(String),
  fragment : Option(String)
);

Url.parse :: (fn(s: str, using(exn : Exception)) -> Url) ...;
Url.to_string :: (fn(self: Self) -> String) ...;
```

### 14.5 `std/sys/bufio/` — Buffered I/O (Priority: Medium, Future)

Buffered reader/writer wrappers for any file descriptor.

```rust
BufReader :: object(fd: i32, buf: ArrayList(u8), pos: usize);
BufWriter :: object(fd: i32, buf: ArrayList(u8));

BufReader.read_line :: (fn(self: Self, using(io : Io)) -> Impl(Future(Result(Option(String), IoError)))) ...;
BufWriter.flush :: (fn(self: Self, using(io : Io)) -> Impl(Future(Result(unit, IoError)))) ...;
```

---

## Recommended Implementation Order

| Order | Phase    | Module                                             | Priority | Est. Effort | Status      |
| ----- | -------- | -------------------------------------------------- | -------- | ----------- | ----------- |
| 1     | Phase 8  | `std/error` — Error trait                          | —        | —           | ✅ Done     |
| 2     | Phase 4  | `std/fmt` — Writer + Display                       | —        | —           | ✅ Done     |
| 3     | Phase 3  | `std/time` — Duration, Instant, DateTime           | High     | Medium      | ✅ Done     |
| 4     | Phase 1  | `std/fs` — File, Metadata, Dir, Walker, Temp       | Critical | Large       | ✅ Done     |
| 5     | Phase 2  | `std/net` — TcpListener, TcpStream, UdpSocket, DNS | Critical | Large       | ✅ Done     |
| 6     | Phase 7  | `std/math` — Functions, PRNG                       | Low      | Small       | ⏸ Deferred |
| 7     | Phase 5  | `std/encoding` — Base64, Hex, JSON, UTF-16         | Medium   | Medium      | ✅ Done     |
| 8     | Phase 6  | `std/crypto` — SHA-256, MD5, Random                | Medium   | Medium      | ✅ Done     |
| 9     | Phase 10 | `std/testing` — Assertions, Bench                  | —        | —           | ✅ Done     |
| 10    | Phase 9  | `std/log` — Structured logging                     | —        | —           | ✅ Done     |
| 11    | Phase 11 | `std/collections` — Deque, BTreeMap, PriorityQueue | Low      | Medium      | ✅ Done     |
| 12    | Phase 12 | `std/os` — Signals, Env dirs                       | Low      | Small       | ✅ Done     |
| 13    | Phase 13 | `std/sync/channel` — Bounded MPMC Channel          | Critical | Small       | ✅ Done     |
| 14    | Phase 14 | `std/sync/rwlock` — Reader-Writer Lock             | Medium   | Small       | ✅ Done     |
| 15    | Phase 14 | `std/sync/waitgroup` — WaitGroup                   | Medium   | Small       | ✅ Done     |
| 16    | Phase 14 | `std/sync/once` — One-Time Init                    | Low      | Small       | ✅ Done     |
| —     | Phase 14 | `std/url/` — URL parsing                           | Low      | Small       | ✅ Done     |
| —     | Phase 14 | `std/sys/bufio/` — Buffered I/O                    | Medium   | Medium      | ✅ Done     |
| —     | —        | `std/regex` — Regular expressions                  | Medium   | Large       | ✅ Done     |

**Rationale**: Error trait and fmt/Writer come first because they're dependencies of almost everything else. Time comes before fs/net because Duration/Instant are useful for timeouts and logging. fs and net are the largest, most impactful modules. Math/encoding/crypto are independent utilities. Testing, logging, and advanced collections are low priority since the existing tools work.

## Design Principles

1. **Build on `std/sys`, don't duplicate**: High-level modules call into `std/sys/*` for all system operations. No direct C externs in high-level modules.

2. **Return `Result`, not raw `i32`**: High-level APIs use `Result(T, Error)` for all fallible operations. Async fallible I/O operations return `Impl(Future(Result(T, Error)))`. Callers use `io.await(fn(...))` to get back a `Result` and then pattern-match or propagate using the `?(...)` operator. The `std/sys` errno-based pattern stays in `std/sys`.

3. **Use `Path` for filesystem paths**: High-level APIs that accept filesystem paths use `Path` as the default parameter type. Variants with `_str` and `_cstr` suffixes accept `str` and `*(u8)` respectively. Internally, `Path` is converted to `*(u8)` via `.to_string().to_cstr()` for the `std/sys` layer.

4. **Objects with `Dispose`**: Resources (File, TcpStream, TempDir) are `object` types implementing `Dispose` for automatic cleanup through reference counting.

5. **Async-first for I/O via Algebraic Effects**: File and network operations use `using(io : Io)` and `io.await(...)`. Callers must have an Io effect in scope (e.g., via `test ... using(io : Io), { ... }` or `main :: (fn(using(io : Io)) -> unit)(...)`).

6. **Cross-platform by default**: All APIs must work on Linux, macOS, and Windows. Platform-specific behavior is documented but never exposed in the type signatures.

7. **No barrel re-exports**: Import specific modules directly: `{ File } :: import "std/fs/file"`, `{ TcpStream } :: import "std/net/tcp"`.

8. **`ArrayList(u8)` for byte buffers**: Prefer `ArrayList(u8)` over `Slice(u8)` for owned byte data. Use `*(u8)` with an explicit size for raw buffer parameters.

## Notes

- **`Path` for filesystem paths**: `std/fs` functions use `Path` (from `std/path`) as the default path parameter type. `Path` provides cross-platform normalization, joining, and component extraction. For convenience, `_str` suffixed variants accept `str` directly (e.g., `read_file_str("data.txt", ...)`) and `_cstr` variants accept `*(u8)`. Internally, paths are converted to `*(u8)` via `path.to_string().to_cstr()` for the `std/sys` layer.

- **Buffered I/O strategy**: `File` objects use internal `ArrayList(u8)` buffers (default 8KB). Reads fill the buffer in one syscall; subsequent reads drain from buffer. Writes accumulate in buffer until `flush()` or buffer full. This amortizes syscall overhead for small reads/writes.

- **JSON as a value type**: `JsonValue` is an `enum` rather than a trait/interface. This keeps the API simple (parse → walk → extract) without requiring codegen or reflection. Type-safe serialization of custom structs can be added later via a `Serialize`/`Deserialize` trait.

- **Cryptographic disclaimer**: `std/crypto` provides common hash functions, NOT a full cryptographic library. For production security needs (TLS, encryption), users should FFI to OpenSSL/libsodium.

- **PRNG vs CSPRNG**: `std/math/random` provides a fast PRNG (xoshiro256\*\*) for games/simulations. `std/crypto/random` provides cryptographically secure random using OS entropy. The two should never be confused.

- **Io effect propagation**: Any function that calls an async I/O operation must either handle the `Io` effect (by providing `given(io)`) or propagate it via `using(io : Io)` in its own signature. Errors are returned as `Result(T, E)` values. The `main` function automatically receives Io from the runtime.

---

## Known API Issues

Issues discovered during audit. **All naming issues and missing methods have been fixed.**

### Naming Inconsistencies — ✅ Fixed

All naming inconsistencies were fixed in commit `f3deb5de`:

| Module                        | Old Name        | New Name       | Status   |
| ----------------------------- | --------------- | -------------- | -------- |
| `std/net/tcp.yo`              | `read_all`      | `read_bytes`   | ✅ Fixed |
| `std/string/string.yo`        | `to_lower_case` | `to_lowercase` | ✅ Fixed |
| `std/string/string.yo`        | `to_upper_case` | `to_uppercase` | ✅ Fixed |
| `std/string/string.yo`        | `includes`      | `contains`     | ✅ Fixed |
| `std/collections/hash_map.yo` | `has`           | `contains_key` | ✅ Fixed |

### Type Safety Issues — ✅ Fixed

- **`File.seek()` whence parameter**: Now uses `SeekFrom` enum (`Start`, `Current`, `End`) instead of raw `i32`.

### Error Handling Inconsistencies

The standard library uses a mix of error handling strategies. These are acceptable for now but could be unified in the future:

| Module                                        | Pattern                                      | Status                              |
| --------------------------------------------- | -------------------------------------------- | ----------------------------------- |
| `std/fs/`, `std/net/tcp.yo`, `std/net/udp.yo` | `Exception` effect                           | ✅ Correct                          |
| `std/sync/channel.yo`                         | `Result(unit, unit)` for send, `?T` for recv | ⚠️ Acceptable — different semantics |
| `std/crypto/random.yo`                        | Custom `CryptoError` enum                    | ⚠️ Could use `Exception` in future  |
| `std/encoding/json.yo`                        | Custom `JsonError` enum                      | ⚠️ Could use `Exception` in future  |

---

## Missing Convenience Methods — ✅ All Fixed

| Module                          | Methods Added                                                                 | Commit                 |
| ------------------------------- | ----------------------------------------------------------------------------- | ---------------------- |
| `std/collections/array_list.yo` | `contains`, `index_of`, `reverse`, `sort`                                     | `49118208`, `23b3ba75` |
| `std/string/string.yo`          | `parse_i32`, `parse_i64`, `parse_u32`, `parse_u64`, `parse_bool`, `Hash` impl | `35cf9926`, `d0a6feed` |
| `std/path.yo`                   | `exists`, `is_file`, `is_dir` (already existed); tests added                  | `69437d1f`             |

---

## Missing Modules

Status of modules that were not yet implemented at the start of the std library overhaul:

| Module                    | Priority | Status      | Notes                                                                        |
| ------------------------- | -------- | ----------- | ---------------------------------------------------------------------------- |
| **CLI argument parsing**  | High     | ✅ Done     | `std/cli/arg_parser.yo` — builder pattern, flags, options, positionals, help |
| **Reader/Writer traits**  | High     | ✅ Done     | `std/io/reader.yo`, `std/io/writer.yo` — generic I/O interfaces              |
| **TOML parsing**          | Medium   | ✅ Done     | `std/toml/toml.yo` — strings, ints, bools, table sections, comments          |
| **Glob/pattern matching** | Medium   | ✅ Done     | `std/glob/glob.yo` — `*`, `?`, `**`, `[abc]`, `[!abc]` support               |
| **HTTP types**            | Medium   | ✅ Done     | `std/http/http.yo` — request builder, response parser, status helpers        |
| **Compression**           | Low      | ⏸ Deferred | Would need C library bindings (zlib/miniz)                                   |
| **HTTP server**           | Low      | ⏸ Deferred | Would build on top of `std/net/tcp` and `std/http/http`                      |

## Documentation

Full standard library documentation: **[Standard Library Documentation](https://shd101wyy.github.io/Yo/)**
