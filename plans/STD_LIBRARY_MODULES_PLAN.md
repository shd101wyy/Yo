# Yo Standard Library Modules Plan

## Overview

With the low-level `std/sys` async I/O foundation complete (37 modules covering file, socket, process, mmap, signals, TTY, DNS, etc.), this plan covers building the **high-level standard library** that makes Yo battery-included. These modules sit on top of `std/sys` and provide ergonomic, type-safe APIs for common programming tasks.

## Algebraic Effects and IO

Async I/O in Yo is expressed via the **`IO` algebraic effect** for suspension/resumption via `io.await(...)`. Errors are propagated using the **`Result(T, E)` data type** — the standard approach for fallible operations.

Async functions that perform I/O take `using(io : IO)` as an implicit parameter. Fallible async operations return `Impl(Future(Result(T, E)))` — the `Impl(Future(...))` wrapper makes the async nature explicit at the type level, and `Result` makes errors explicit. Callers use `io.await(fn(...))` to drive execution and get back `Result(T, E)`.

```yo
// Async + Result style:
File.open :: (fn(path: Path, mode: OpenMode, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;

// Sync functions that cannot fail return T directly:
File.position :: (fn(self: Self) -> i64) ...;

// Sync functions that can fail return Result:
File.seek :: (fn(self: Self, offset: i64, whence: i32) -> Result(i64, IOError)) ...;
```

Byte buffers use `ArrayList(u8)` (not `Slice(u8)`).

## Current Standard Library Status

### What's Done

| Module              | File(s)                                 | Status      | Notes                                                                                                              |
| ------------------- | --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| **Prelude**         | `std/prelude.yo`                        | ✅ Complete | Core types, traits, operators, Box, Option, Result, Array, Slice; IO algebraic effect                              |
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
| **Async**           | `std/async.yo`                          | ✅ Minimal  | Only `yield`; async/await uses IO algebraic effect                                                                 |
| **Time**            | `std/time.yo`                           | 🔸 Minimal  | Only `sleep`; see `std/time/` for Duration, Instant, DateTime                                                      |
| **Time (rich)**     | `std/time/`                             | ✅ Complete | `Duration`, `Instant` (monotonic), `DateTime` (wall clock) — 25 tests all passing                                  |
| **Sys (low-level)** | `std/sys/` (37 files)                   | ✅ Complete | Full async I/O: file, socket, process, mmap, DNS, signals, TTY, etc.                                               |
| **Libc bindings**   | `std/libc/`                             | ✅ Complete | stdio, stdlib, string, math, errno, signal, etc.                                                                   |
| **FS**              | `std/fs/`                               | ✅ Complete | `File`, `Metadata`, `TempDir`, `TempFile`, directory walker                                                        |
| **Net**             | `std/net/`                              | ✅ Complete | `TcpStream`, `TcpListener`, `UdpSocket`, `IpAddr`, DNS lookup                                                      |
| **OS**              | `std/os/`                               | ✅ Complete | Signal handling, environment directory utilities — 10 tests passing                                                |
| **Encoding**        | `std/encoding/`                         | ✅ Complete | Base64, hex, JSON, UTF-16 — 71 tests passing                                                                       |
| **Crypto**          | `std/crypto/`                           | ✅ Complete | SHA-256, MD5, secure random, UUID v4 — 33 tests passing                                                            |
| **Math**            | `std/math/`                             | ✅ Complete | Generic min/max/clamp, lerp, PRNG (xoshiro256\*\*)                                                                 |
| **Log**             | `std/log/`                              | ✅ Complete | Structured logger with level filtering and output routing                                                          |
| **Testing**         | `std/testing/`                          | ✅ Complete | Rich assertion helpers, micro-benchmarking                                                                         |

### What's Remaining

Potential future additions (not currently planned):

1. **`std/regex`** — Regular expressions

---

## Phase 1: High-Level File System (`std/fs`) — Priority: Critical

**Goal**: Provide ergonomic async file I/O with buffered readers/writers, file objects, and directory traversal. This is the most important module — every non-trivial program needs file I/O.

**Depends on**: `std/sys/file`, `std/sys/dir`, `std/sys/seek`, `std/sys/path`, `std/sys/statx`, `std/sys/perm`, `std/sys/temp`, `std/path`, `std/string`

### 1.1 `std/fs/file.yo` — File Object

A high-level `File` object wrapping a file descriptor with buffered I/O.

```yo
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
File.open :: (fn(path: Path, mode: OpenMode, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;
File.open_str :: (fn(path: str, mode: OpenMode, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;
File.open_cstr :: (fn(path: *(u8), mode: OpenMode, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;
// File.open_with allows specifying custom file permissions
File.open_with :: (fn(path: Path, mode: OpenMode, perm: FilePermission, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;
File.open_with_str :: (fn(path: str, mode: OpenMode, perm: FilePermission, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;
File.open_with_cstr :: (fn(path: *(u8), mode: OpenMode, perm: FilePermission, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;

// Instance methods
File.read :: (fn(self: Self, buf: *(u8), size: usize, using(io : IO)) -> Impl(Future(Result(i32, IOError)))) ...;
File.write :: (fn(self: Self, data: str, using(io : IO)) -> Impl(Future(Result(i32, IOError)))) ...;
File.write_string :: (fn(self: Self, data: String, using(io : IO)) -> Impl(Future(Result(i32, IOError)))) ...;
File.write_bytes :: (fn(self: Self, data: ArrayList(u8), using(io : IO)) -> Impl(Future(Result(i32, IOError)))) ...;
File.read_all :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(ArrayList(u8), IOError)))) ...;
File.read_to_string :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(String, IOError)))) ...;
File.flush :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
File.seek :: (fn(self: Self, offset: i64, whence: i32) -> Result(i64, IOError)) ...;
File.position :: (fn(self: Self) -> i64) ...;
File.size :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(i64, IOError)))) ...;
File.close :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
File.metadata :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(Metadata, IOError)))) ...;

// Convenience functions (no File object needed)
// Default takes Path; _str takes str; _cstr takes *(u8)
read_file :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(ArrayList(u8), IOError)))) ...;
read_file_str :: (fn(path: str, using(io : IO)) -> Impl(Future(Result(ArrayList(u8), IOError)))) ...;
read_file_cstr :: (fn(path: *(u8), using(io : IO)) -> Impl(Future(Result(ArrayList(u8), IOError)))) ...;
read_to_string :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(String, IOError)))) ...;
read_to_string_str :: (fn(path: str, using(io : IO)) -> Impl(Future(Result(String, IOError)))) ...;
read_to_string_cstr :: (fn(path: *(u8), using(io : IO)) -> Impl(Future(Result(String, IOError)))) ...;
write_file :: (fn(path: Path, data: str, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
write_file_str :: (fn(path: str, data: str, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
write_file_cstr :: (fn(path: *(u8), data: str, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
write_bytes :: (fn(path: Path, data: ArrayList(u8), using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
append_file :: (fn(path: Path, data: str, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
exists :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(bool, IOError)))) ...;
exists_str :: (fn(path: str, using(io : IO)) -> Impl(Future(Result(bool, IOError)))) ...;
exists_cstr :: (fn(path: *(u8), using(io : IO)) -> Impl(Future(Result(bool, IOError)))) ...;
```

### 1.2 `std/fs/metadata.yo` — File Metadata

```yo
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

// Convenience — default takes Path; _str takes str; _cstr takes *(u8)
metadata :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(Metadata, IOError)))) ...;
metadata_str :: (fn(path: str, using(io : IO)) -> Impl(Future(Result(Metadata, IOError)))) ...;
metadata_cstr :: (fn(path: *(u8), using(io : IO)) -> Impl(Future(Result(Metadata, IOError)))) ...;
symlink_metadata :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(Metadata, IOError)))) ...;
symlink_metadata_str :: (fn(path: str, using(io : IO)) -> Impl(Future(Result(Metadata, IOError)))) ...;
symlink_metadata_cstr :: (fn(path: *(u8), using(io : IO)) -> Impl(Future(Result(Metadata, IOError)))) ...;
```

### 1.3 `std/fs/dir.yo` — Directory Operations

```yo
// High-level directory operations — default takes Path; _str/_cstr variants available
create_dir :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
create_dir_str :: (fn(path: str, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
create_dir_all :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
create_dir_all_str :: (fn(path: str, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
remove_dir :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
remove_dir_all :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
remove_file :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
rename :: (fn(from: Path, to: Path, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
hard_link :: (fn(src: Path, dst: Path, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
symlink :: (fn(src: Path, dst: Path, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;

// Directory listing
DirEntry :: struct(
  name : String,
  path : Path,
  file_type : FileType,
  ino : u64
);

FileType :: enum(File, Directory, Symlink, Other);   // note: no leading dots in enum declaration

read_dir :: (fn(path: Path, using(io : IO)) -> Impl(Future(Result(ArrayList(DirEntry), IOError)))) ...;
read_dir_str :: (fn(path: str, using(io : IO)) -> Impl(Future(Result(ArrayList(DirEntry), IOError)))) ...;
```

### 1.4 `std/fs/walker.yo` — Recursive Directory Traversal

```yo
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

walk :: (fn(root: Path, using(io : IO)) -> Impl(Future(Result(ArrayList(WalkEntry), IOError)))) ...;
walk_cstr :: (fn(root: *(u8), using(io : IO)) -> Impl(Future(Result(ArrayList(WalkEntry), IOError)))) ...;
walk_with :: (fn(root: Path, options: WalkOptions, using(io : IO)) -> Impl(Future(Result(ArrayList(WalkEntry), IOError)))) ...;
walk_with_cstr :: (fn(root: *(u8), options: WalkOptions, using(io : IO)) -> Impl(Future(Result(ArrayList(WalkEntry), IOError)))) ...;
```

### 1.5 `std/fs/temp.yo` — Temporary Files and Directories

```yo
TempDir :: object(
  _path : Path,
  _removed : bool
);
TempDir.new :: (fn(using(io : IO)) -> Impl(Future(Result(TempDir, IOError)))) ...;
TempDir.new_in :: (fn(parent: Path, using(io : IO)) -> Impl(Future(Result(TempDir, IOError)))) ...;
TempDir.path :: (fn(self: Self) -> Path) ...;
TempDir.remove :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;

TempFile :: object(
  file : File,
  _path : Path
);
TempFile.new :: (fn(using(io : IO)) -> Impl(Future(Result(TempFile, IOError)))) ...;
TempFile.new_in :: (fn(parent: Path, using(io : IO)) -> Impl(Future(Result(TempFile, IOError)))) ...;
TempFile.path :: (fn(self: Self) -> Path) ...;
TempFile.remove :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
```

**Tests**: File read/write round-trip, buffered I/O, read_to_string, metadata queries, create_dir_all, remove_dir_all, directory walk, temp file/dir auto-cleanup.

---

## Phase 2: High-Level Networking (`std/net`) — Priority: Critical — ✅ Done

**Goal**: Provide ergonomic async TCP/UDP client and server types. This is the second most important module for building real applications.

**Depends on**: `std/sys/tcp`, `std/sys/udp`, `std/sys/dns`, `std/sys/socket`, `std/string`

### 2.1 `std/net/errors.yo` — Network Errors

```yo
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
  IO(err: IOError),
  Other(msg: String)
);

// Helpers
NetError.from_io :: (fn(err: IOError) -> Self) ...;        // Maps IOError variants to NetError
NetError.from_result :: (fn(result: i32) -> Result(i32, Self)) ...;  // Converts raw result codes
```

### 2.2 `std/net/addr.yo` — Network Addresses

```yo
IpAddr :: enum(
  V4(a: u8, b: u8, c: u8, d: u8),
  V6(segments: Array(u16, usize(8)))
);

IpAddr.parse_v4 :: (fn(s: String) -> Result(IpAddr, NetError)) ...;
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

```yo
TcpListener :: object(
  _fd         : i32,
  _local_addr : SocketAddr
);

TcpListener.bind :: (fn(addr: SocketAddr, using(io : IO)) -> Impl(Future(Result(TcpListener, NetError), IO))) ...;
TcpListener.accept :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(TcpStream, NetError), IO))) ...;
TcpListener.local_addr :: (fn(self: Self) -> SocketAddr) ...;
TcpListener.close :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, NetError), IO))) ...;
TcpListener.fd :: (fn(self: Self) -> i32) ...;
// Implements Dispose

TcpStream :: object(
  _fd        : i32,
  _peer_addr : SocketAddr,
  _is_closed : bool
);

TcpStream.connect :: (fn(addr: SocketAddr, using(io : IO)) -> Impl(Future(Result(TcpStream, NetError), IO))) ...;
TcpStream.read :: (fn(self: Self, buf: *(u8), size: usize, using(io : IO)) -> Impl(Future(Result(i32, NetError), IO))) ...;
TcpStream.write_str :: (fn(self: Self, data: str, using(io : IO)) -> Impl(Future(Result(i32, NetError), IO))) ...;
TcpStream.write :: (fn(self: Self, data: String, using(io : IO)) -> Impl(Future(Result(i32, NetError), IO))) ...;
TcpStream.write_bytes :: (fn(self: Self, data: ArrayList(u8), using(io : IO)) -> Impl(Future(Result(i32, NetError), IO))) ...;
TcpStream.read_all :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(ArrayList(u8), NetError), IO))) ...;
TcpStream.shutdown :: (fn(self: Self, how: i32, using(io : IO)) -> Impl(Future(Result(unit, NetError), IO))) ...;
TcpStream.close :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, NetError), IO))) ...;
TcpStream.peer_addr :: (fn(self: Self) -> SocketAddr) ...;
TcpStream.fd :: (fn(self: Self) -> i32) ...;
TcpStream.set_nodelay :: (fn(self: Self, nodelay: bool, using(io : IO)) -> Impl(Future(Result(unit, NetError), IO))) ...;
TcpStream.set_keepalive :: (fn(self: Self, enabled: bool, using(io : IO)) -> Impl(Future(Result(unit, NetError), IO))) ...;
// Implements Dispose
```

### 2.4 `std/net/udp.yo` — UDP Socket

```yo
UdpSocket :: object(
  _fd         : i32,
  _local_addr : SocketAddr,
  _is_closed  : bool
);

UdpSocket.bind :: (fn(addr: SocketAddr, using(io : IO)) -> Impl(Future(Result(UdpSocket, NetError), IO))) ...;
UdpSocket.send_to :: (fn(self: Self, data: ArrayList(u8), addr: SocketAddr, using(io : IO)) -> Impl(Future(Result(i32, NetError), IO))) ...;
UdpSocket.recv :: (fn(self: Self, buf: *(u8), size: usize, using(io : IO)) -> Impl(Future(Result(i32, NetError), IO))) ...;
UdpSocket.recv_from :: (fn(self: Self, buf: *(u8), size: usize, src_addr: *(u8), src_addr_len: *(u32), using(io : IO)) -> Impl(Future(Result(i32, NetError), IO))) ...;
UdpSocket.send :: (fn(self: Self, data: ArrayList(u8), using(io : IO)) -> Impl(Future(Result(i32, NetError), IO))) ...;
UdpSocket.close :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, NetError), IO))) ...;
UdpSocket.set_broadcast :: (fn(self: Self, enabled: bool, using(io : IO)) -> Impl(Future(Result(unit, NetError), IO))) ...;
UdpSocket.local_addr :: (fn(self: Self) -> SocketAddr) ...;
UdpSocket.fd :: (fn(self: Self) -> i32) ...;
// Implements Dispose
```

### 2.5 `std/net/dns.yo` — DNS Resolution

```yo
lookup_host :: (fn(host: String, using(io : IO)) -> Impl(Future(Result(ArrayList(IpAddr), NetError), IO))) ...;
resolve :: (fn(host: String, port: u16, using(io : IO)) -> Impl(Future(Result(ArrayList(SocketAddr), NetError), IO))) ...;
```

**Tests**: TCP echo server/client with typed API, UDP datagram exchange, DNS lookup, address parsing/formatting, connection error handling.

**Test files** (all passing):

- `tests/net/addr.test.yo` — 13 tests (IpAddr parsing, loopback, SocketAddr, ToString)
- `tests/net/errors.test.yo` — 9 tests (NetError variants, from_io, from_result, ToString)
- `tests/net/tcp.test.yo` — 10 tests (bind/close, local_addr, connect/accept, write_str/read echo, write String, write_bytes, set_nodelay/set_keepalive, shutdown, peer_addr, read_all)
- `tests/net/udp.test.yo` — 5 tests (bind/close, local_addr, send_to/recv, recv_from, set_broadcast)
- `tests/net/dns.test.yo` — 3 tests (lookup_host localhost, invalid host, resolve)

---

## Phase 3: Time and Duration (`std/time`) — Priority: High

**Goal**: Rich time support with Duration, Instant (monotonic), and DateTime (wall clock). Essential for benchmarking, logging, timeouts, and scheduling.

**Depends on**: `std/sys/clock`, `std/sys/timer`, `std/string`, `std/fmt`

### 3.1 `std/time/duration.yo` — Time Duration

```yo
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

```yo
Instant :: struct(
  secs : i64,
  nanos : i64
);

Instant.now :: (fn() -> Instant) ...;
Instant.elapsed :: (fn(self: *(Self)) -> Duration) ...;
Instant.duration_since :: (fn(self: *(Self), earlier: Instant) -> Duration) ...;
```

### 3.3 `std/time/datetime.yo` — Wall Clock Time

```yo
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

## Phase 4: String Formatting (`std/fmt`) — Not Planned

**Status**: Not planned. The existing template string approach (`` `Hello ${name}` ``) and `ToString` trait provide sufficient string formatting for current use cases. A dedicated formatting engine can be revisited later if needed.

---

## Phase 5: Encoding & Serialization (`std/encoding`) — ✅ Done

**Goal**: Common data encoding/decoding formats essential for network protocols, file formats, and data interchange.

**Depends on**: `std/string`, `std/collections/array_list`

**Status**: All modules implemented and tested (71 tests total).

### 5.1 `std/encoding/hex.yo` — Hexadecimal (11 tests)

```yo
hex_encode :: (fn(data: ArrayList(u8)) -> String) ...;
hex_decode :: (fn(s: str) -> Result(ArrayList(u8), EncodingError)) ...;
```

### 5.2 `std/encoding/base64.yo` — Base64 (13 tests)

```yo
base64_encode :: (fn(data: ArrayList(u8)) -> String) ...;
base64_decode :: (fn(s: str) -> Result(ArrayList(u8), EncodingError)) ...;
base64_encode_url :: (fn(data: ArrayList(u8)) -> String) ...;
base64_decode_url :: (fn(s: str) -> Result(ArrayList(u8), EncodingError)) ...;
```

### 5.3 `std/encoding/json.yo` — JSON (35 tests)

Uses `ArrayList` pairs for Object (keys + values) instead of `HashMap` due to `HashMap(String, Self)` not being supported with recursive enum types.

```yo
JsonValue :: enum(
  Null,
  Bool(value: bool),
  Number(value: f64),
  Str(value: String),
  Array(items: ArrayList(Self)),
  Object(keys: ArrayList(String), values: ArrayList(Self))
);

json_parse :: (fn(s: str) -> Result(JsonValue, JsonError)) ...;
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

```yo
utf8_to_utf16 :: (fn(s: str) -> ArrayList(u16)) ...;
utf16_to_utf8 :: (fn(data: ArrayList(u16)) -> Result(String, EncodingError)) ...;
```

**Tests**: `tests/encoding/hex.test.yo` (11), `tests/encoding/base64.test.yo` (13), `tests/encoding/json.test.yo` (35), `tests/encoding/utf16.test.yo` (12) — all passing.

---

## Phase 6: Cryptographic Hashing & Random (`std/crypto`) — ✅ Done

**Goal**: Common hash functions and cryptographically secure random number generation. Essential for security, checksums, and unique ID generation.

**Depends on**: `std/string`, `std/collections/array_list`

**Status**: All modules implemented and tested (33 tests total).

### 6.1 `std/crypto/sha256.yo` — SHA-256

```yo
Sha256 :: object(state: ...);
Sha256.new :: (fn() -> Sha256) ...;
Sha256.update :: (fn(self: Self, data: ArrayList(u8)) -> Self) ...;
Sha256.finish :: (fn(self: Self) -> Array(u8, usize(32))) ...;

sha256 :: (fn(data: ArrayList(u8)) -> Array(u8, usize(32))) ...;
sha256_hex :: (fn(data: ArrayList(u8)) -> String) ...;
```

### 6.2 `std/crypto/md5.yo` — MD5

```yo
md5 :: (fn(data: ArrayList(u8)) -> Array(u8, usize(16))) ...;
md5_hex :: (fn(data: ArrayList(u8)) -> String) ...;
```

### 6.3 `std/crypto/random.yo` — Secure Random

```yo
random_bytes :: (fn(buf: *(u8), size: usize) -> Result(unit, CryptoError)) ...;
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

## Phase 7: Math Extensions (`std/math`) — Not Planned

**Status**: Not planned. The `std/libc/math.yo` already exposes all standard math functions (`sin`, `cos`, `sqrt`, `pow`, `floor`, `ceil`, `fabs`, etc.) from C's `math.h`. A separate math module is unnecessary since libc already provides these.

---

## Phase 8: Error Handling (`std/error`) — Not Planned

**Status**: Not planned. The existing `Result(T, E)` pattern with domain-specific error enums (e.g., `IOError`, `JsonError`, `EncodingError`, `NetError`) provides sufficient error handling. A generic `Error` trait can be revisited if cross-cutting error abstraction becomes necessary.

---

## Phase 9: Logging (`std/log`) — Not Planned

**Status**: Not planned. `println` and `eprintln` are sufficient for current logging needs. A structured logging module can be revisited when more complex applications require it.

---

## Phase 10: Testing Utilities (`std/testing`) — Not Planned

**Status**: Not planned. The built-in `assert(condition)` and `assert(condition, message)` combined with the `test "name", { ... };` syntax provide sufficient testing capabilities.

---

## Phase 11: Advanced Collections (`std/collections`) — Priority: Low

**Goal**: Additional data structures beyond the existing ArrayList, HashMap, HashSet, LinkedList.

**Depends on**: `std/allocator`, `std/fmt`

### 11.1 `std/collections/deque.yo` — Double-Ended Queue

```yo
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

```yo
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

```yo
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

```yo
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

on_signal :: (fn(sig: Signal, handler: SignalHandler) -> Result(unit, IOError)) ...;
off_signal :: (fn(sig: Signal) -> Result(unit, IOError)) ...;
```

### 12.2 `std/os/env.yo` — Environment Utilities

```yo
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

**Note**: Thread/Worker integration tests were removed after fixing `Send` trait enforcement. `Channel(T)` is an `object` type (non-atomic RC) which does not implement `Send`, so it cannot be captured in thread closures. Cross-thread channel tests require either `Iso(Channel(T))` wrapping or making Channel use atomic RC. See `plans/MULTI_CLOSURE_RC_BUG.md` for details.

### Design Decision: Sync (blocking) vs Async

The Channel uses **blocking** `send`/`recv` via condition variables rather than async/await (`using(io : IO)`). Rationale:

1. **Works everywhere**: Channels are used with both `Thread` and `Worker`. Neither requires an IO effect context, so a sync Channel is more universally applicable.
2. **Simpler mental model**: `send()` blocks when the buffer is full; `recv()` blocks when the buffer is empty. No need to manage IO effects or futures for basic message passing.
3. **Channel is a synchronization primitive, not I/O**: Like Mutex and Cond, Channel belongs in `std/sync`, not `std/sys`.
4. **Async wrapping is easy**: If async semantics are needed, users can wrap `recv()` in `io.async(...)`:
   ```yo
   // Async recv — non-blocking in IO context
   async_recv := io.async((using(io : IO)) => {
     return ch.recv();
   });
   ```
5. **Precedent**: Go channels are synchronous. Rust's `std::sync::mpsc` is synchronous. Async channels (like Tokio's) are a separate abstraction.

### 13.1 `std/sync/channel.yo` — Bounded MPMC Channel

```yo
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

```yo
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

```yo
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

```yo
Once :: object(
  _done  : bool,
  _mutex : Mutex
);

Once.new :: (fn() -> Once) ...;
Once.call :: (fn(self: Self, f: Fn(() -> unit)) -> unit) ...;
```

### 14.4 `std/url/` — URL Parsing (Priority: Low, Future)

Parse and manipulate URLs.

```yo
Url :: object(
  scheme : String,
  host   : String,
  port   : Option(u16),
  path   : String,
  query  : Option(String),
  fragment : Option(String)
);

Url.parse :: (fn(s: str) -> Result(Url, UrlError)) ...;
Url.to_string :: (fn(self: Self) -> String) ...;
```

### 14.5 `std/sys/bufio/` — Buffered I/O (Priority: Medium, Future)

Buffered reader/writer wrappers for any file descriptor.

```yo
BufReader :: object(fd: i32, buf: ArrayList(u8), pos: usize);
BufWriter :: object(fd: i32, buf: ArrayList(u8));

BufReader.read_line :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(Option(String), IOError)))) ...;
BufWriter.flush :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
```

---

## Recommended Implementation Order

| Order | Phase    | Module                                             | Priority | Est. Effort | Status         |
| ----- | -------- | -------------------------------------------------- | -------- | ----------- | -------------- |
| 1     | Phase 8  | `std/error` — Error trait                          | —        | —           | ⏸ Not Planned |
| 2     | Phase 4  | `std/fmt` — Writer + Display                       | —        | —           | ⏸ Not Planned |
| 3     | Phase 3  | `std/time` — Duration, Instant, DateTime           | High     | Medium      | ✅ Done        |
| 4     | Phase 1  | `std/fs` — File, Metadata, Dir, Walker, Temp       | Critical | Large       | ✅ Done        |
| 5     | Phase 2  | `std/net` — TcpListener, TcpStream, UdpSocket, DNS | Critical | Large       | ✅ Done        |
| 6     | Phase 7  | `std/math` — Functions, PRNG                       | —        | —           | ⏸ Not Planned |
| 7     | Phase 5  | `std/encoding` — Base64, Hex, JSON, UTF-16         | Medium   | Medium      | ✅ Done        |
| 8     | Phase 6  | `std/crypto` — SHA-256, MD5, Random                | Medium   | Medium      | ✅ Done        |
| 9     | Phase 10 | `std/testing` — Assertions, Bench                  | —        | —           | ⏸ Not Planned |
| 10    | Phase 9  | `std/log` — Structured logging                     | —        | —           | ⏸ Not Planned |
| 11    | Phase 11 | `std/collections` — Deque, BTreeMap, PriorityQueue | Low      | Medium      | ✅ Done        |
| 12    | Phase 12 | `std/os` — Signals, Env dirs                       | Low      | Small       | ✅ Done        |
| 13    | Phase 13 | `std/sync/channel` — Bounded MPMC Channel          | Critical | Small       | ✅ Done        |
| 14    | Phase 14 | `std/sync/rwlock` — Reader-Writer Lock             | Medium   | Small       | ✅ Done        |
| 15    | Phase 14 | `std/sync/waitgroup` — WaitGroup                   | Medium   | Small       | ✅ Done        |
| 16    | Phase 14 | `std/sync/once` — One-Time Init                    | Low      | Small       | ✅ Done        |
| —     | Phase 14 | `std/url/` — URL parsing                           | Low      | Small       | ✅ Done        |
| —     | Phase 14 | `std/sys/bufio/` — Buffered I/O                    | Medium   | Medium      | ✅ Done        |
| —     | —        | `std/regex` — Regular expressions                  | Medium   | Large       | 📋 Planned     |

**Rationale**: Error trait and fmt/Writer come first because they're dependencies of almost everything else. Time comes before fs/net because Duration/Instant are useful for timeouts and logging. fs and net are the largest, most impactful modules. Math/encoding/crypto are independent utilities. Testing, logging, and advanced collections are low priority since the existing tools work.

## Design Principles

1. **Build on `std/sys`, don't duplicate**: High-level modules call into `std/sys/*` for all system operations. No direct C externs in high-level modules.

2. **Return `Result`, not raw `i32`**: High-level APIs use `Result(T, Error)` for all fallible operations. Async fallible I/O operations return `Impl(Future(Result(T, Error)))`. Callers use `io.await(fn(...))` to get back a `Result` and then pattern-match or propagate using the `?(...)` operator. The `std/sys` errno-based pattern stays in `std/sys`.

3. **Use `Path` for filesystem paths**: High-level APIs that accept filesystem paths use `Path` as the default parameter type. Variants with `_str` and `_cstr` suffixes accept `str` and `*(u8)` respectively. Internally, `Path` is converted to `*(u8)` via `.to_string().to_cstr()` for the `std/sys` layer.

4. **Objects with `Dispose`**: Resources (File, TcpStream, TempDir) are `object` types implementing `Dispose` for automatic cleanup through reference counting.

5. **Async-first for I/O via Algebraic Effects**: File and network operations use `using(io : IO)` and `io.await(...)`. Callers must have an IO effect in scope (e.g., via `test ... using(io : IO), { ... }` or `main :: (fn(using(io : IO)) -> unit)(...)`).

6. **Cross-platform by default**: All APIs must work on Linux, macOS, and Windows. Platform-specific behavior is documented but never exposed in the type signatures.

7. **No barrel re-exports**: Import specific modules directly: `{ File } :: import "std/fs/file"`, `{ TcpStream } :: import "std/net/tcp"`.

8. **`ArrayList(u8)` for byte buffers**: Prefer `ArrayList(u8)` over `Slice(u8)` for owned byte data. Use `*(u8)` with an explicit size for raw buffer parameters.

## Notes

- **`Path` for filesystem paths**: `std/fs` functions use `Path` (from `std/path`) as the default path parameter type. `Path` provides cross-platform normalization, joining, and component extraction. For convenience, `_str` suffixed variants accept `str` directly (e.g., `read_file_str("data.txt", ...)`) and `_cstr` variants accept `*(u8)`. Internally, paths are converted to `*(u8)` via `path.to_string().to_cstr()` for the `std/sys` layer.

- **Buffered I/O strategy**: `File` objects use internal `ArrayList(u8)` buffers (default 8KB). Reads fill the buffer in one syscall; subsequent reads drain from buffer. Writes accumulate in buffer until `flush()` or buffer full. This amortizes syscall overhead for small reads/writes.

- **JSON as a value type**: `JsonValue` is an `enum` rather than a trait/interface. This keeps the API simple (parse → walk → extract) without requiring codegen or reflection. Type-safe serialization of custom structs can be added later via a `Serialize`/`Deserialize` trait.

- **Cryptographic disclaimer**: `std/crypto` provides common hash functions, NOT a full cryptographic library. For production security needs (TLS, encryption), users should FFI to OpenSSL/libsodium.

- **PRNG vs CSPRNG**: `std/math/random` provides a fast PRNG (xoshiro256\*\*) for games/simulations. `std/crypto/random` provides cryptographically secure random using OS entropy. The two should never be confused.

- **IO effect propagation**: Any function that calls an async I/O operation must either handle the `IO` effect (by providing `given(io)`) or propagate it via `using(io : IO)` in its own signature. Errors are returned as `Result(T, E)` values. The `main` function automatically receives IO from the runtime.
