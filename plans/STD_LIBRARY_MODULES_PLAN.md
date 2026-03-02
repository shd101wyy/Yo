# Yo Standard Library Modules Plan

## Overview

With the low-level `std/io` async I/O foundation complete (37 modules covering file, socket, process, mmap, signals, TTY, DNS, etc.), this plan covers building the **high-level standard library** that makes Yo battery-included. These modules sit on top of `std/io` and provide ergonomic, type-safe APIs for common programming tasks.

## Algebraic Effects and IO

Async I/O in Yo is expressed via the **`IO` algebraic effect** for suspension/resumption via `io.await(...)`. Errors are propagated using the **`Result(T, E)` data type** — the standard approach for fallible operations.

Async functions that perform I/O take `using(io : IO)` as an implicit parameter. Fallible async operations return `Impl(Future(Result(T, E)))` — the `Impl(Future(...))` wrapper makes the async nature explicit at the type level, and `Result` makes errors explicit. Callers use `io.await(fn(...))` to drive execution and get back `Result(T, E)`.

```yo
// Async + Result style:
File.create :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;

// Sync functions that cannot fail return T directly:
File.position :: (fn(self: Self) -> i64) ...;

// Sync functions that can fail return Result:
File.seek :: (fn(self: Self, offset: i64, whence: i32) -> Result(i64, IOError)) ...;
```

Byte buffers use `ArrayList(u8)` (not `Slice(u8)`).

## Current Standard Library Status

### What's Done

| Module             | File(s)              | Status      | Notes                                                                                 |
| ------------------ | -------------------- | ----------- | ------------------------------------------------------------------------------------- |
| **Prelude**        | `std/prelude.yo`     | ✅ Complete | Core types, traits, operators, Box, Option, Result, Array, Slice; IO algebraic effect |
| **String**         | `std/string/`        | ✅ Complete | Immutable UTF-8 `String`, `rune` (Unicode code point)                                 |
| **Collections**    | `std/collections/`   | ✅ Complete | `ArrayList`, `HashMap`, `HashSet`, `LinkedList`, `Deque`, `BTreeMap`, `PriorityQueue` |
| **Path**           | `std/path.yo`        | ✅ Complete | Cross-platform path manipulation (join, parent, extension, normalize)                 |
| **Process**        | `std/process.yo`     | ✅ Complete | Platform/arch detection, args, env, cwd, chdir, exit                                  |
| **Allocator**      | `std/allocator.yo`   | ✅ Complete | `GlobalAllocator` (mimalloc/libc), `CustomAllocator` trait                            |
| **Format**         | `std/fmt/`           | ✅ Complete | `ToString` trait, `Writer`, `Display`; `println`/`print`/`eprintln`                   |
| **Hash**           | `std/alg/hash.yo`    | ✅ Complete | FNV-1a hash function                                                                  |
| **Sync**           | `std/sync.yo`        | ✅ Complete | `Mutex`, `Cond` (stack + GC-managed variants)                                         |
| **Thread**         | `std/thread.yo`      | ✅ Complete | `Thread` (spawn/join), hardware thread count                                          |
| **Worker**         | `std/worker.yo`      | ✅ Complete | Thread pool with round-robin task distribution                                        |
| **GC**             | `std/gc.yo`          | ✅ Complete | `collect`, `tracked_count`                                                            |
| **Async**          | `std/async.yo`       | ✅ Minimal  | Only `yield`; async/await uses IO algebraic effect                                    |
| **Time**           | `std/time.yo`        | 🔸 Minimal  | Only `sleep`; see `std/time/` for Duration, Instant, DateTime                         |
| **Time (rich)**    | `std/time/`          | ✅ Complete | `Duration`, `Instant` (monotonic), `DateTime` (wall clock)                            |
| **Error**          | `std/error/`         | ✅ Complete | `Error` trait for typed error propagation                                             |
| **IO (low-level)** | `std/io/` (37 files) | ✅ Complete | Full async I/O: file, socket, process, mmap, DNS, signals, TTY, etc.                  |
| **Libc bindings**  | `std/libc/`          | ✅ Complete | stdio, stdlib, string, math, errno, signal, etc.                                      |
| **FS**             | `std/fs/`            | ✅ Complete | `File`, `Metadata`, `TempDir`, `TempFile`, directory walker                           |
| **Net**            | `std/net/`           | ✅ Complete | `TcpStream`, `TcpListener`, `UdpSocket`, `IpAddr`, DNS lookup                         |
| **OS**             | `std/os/`            | ✅ Complete | Signal handling, environment directory utilities                                      |
| **Encoding**       | `std/encoding/`      | ✅ Complete | Base64, hex, JSON, UTF-16                                                             |
| **Crypto**         | `std/crypto/`        | ✅ Complete | SHA-256, MD5, secure random, UUID v4                                                  |
| **Math**           | `std/math/`          | ✅ Complete | Generic min/max/clamp, lerp, PRNG (xoshiro256\*\*)                                    |
| **Log**            | `std/log/`           | ✅ Complete | Structured logger with level filtering and output routing                             |
| **Testing**        | `std/testing/`       | ✅ Complete | Rich assertion helpers, micro-benchmarking                                            |

### What's Missing

The major gaps for a "battery-included" standard library — all now implemented:

1. **`std/fs`** ✅ — High-level filesystem API (buffered reader/writer, file objects, directory walker)
2. **`std/net`** ✅ — High-level networking (TCP/UDP client/server objects, DNS lookup)
3. **`std/os`** ✅ — OS-level utilities (environment directory utilities, typed signal handling)
4. **`std/time`** ✅ — Rich time library (Duration, Instant, DateTime, formatting)
5. **`std/fmt`** ✅ — String formatting (Writer, Display trait, println/print/eprintln)
6. **`std/encoding`** ✅ — Base64, hex, JSON, UTF-16
7. **`std/crypto`** ✅ — Hashing (SHA-256, MD5), secure random, UUID v4
8. **`std/math`** ✅ — Generic min/max/clamp, lerp, PRNG (xoshiro256\*\*)
9. **`std/testing`** ✅ — Test utilities (rich assertions, micro-benchmarks)
10. **`std/log`** ✅ — Structured logging with level filtering
11. **`std/regex`** — Regular expressions (still missing)

---

## Phase 1: High-Level File System (`std/fs`) — Priority: Critical

**Goal**: Provide ergonomic async file I/O with buffered readers/writers, file objects, and directory traversal. This is the most important module — every non-trivial program needs file I/O.

**Depends on**: `std/io/file`, `std/io/dir`, `std/io/seek`, `std/io/path`, `std/io/statx`, `std/io/perm`, `std/io/temp`, `std/path`, `std/string`

### 1.1 `std/fs/file.yo` — File Object

A high-level `File` object wrapping a file descriptor with buffered I/O.

```yo
File :: object(
  fd : i32,
  path : String,
  _read_buf : ArrayList(u8),
  _write_buf : ArrayList(u8),
  _position : i64,
  _is_closed : bool
);

// Static constructors
File.open :: (fn(path: String, flags: i32, mode: i32, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;
File.create :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;
File.open_read :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;
File.open_append :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(File, IOError)))) ...;

// Instance methods
File.read :: (fn(self: Self, buf: *(u8), size: usize, using(io : IO)) -> Impl(Future(Result(i32, IOError)))) ...;
File.write :: (fn(self: Self, data: String, using(io : IO)) -> Impl(Future(Result(i32, IOError)))) ...;
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
read_file :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(ArrayList(u8), IOError)))) ...;
read_to_string :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(String, IOError)))) ...;
write_file :: (fn(path: String, data: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
write_bytes :: (fn(path: String, data: ArrayList(u8), using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
append_file :: (fn(path: String, data: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
exists :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(bool, IOError)))) ...;
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

// Convenience
metadata :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(Metadata, IOError)))) ...;
symlink_metadata :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(Metadata, IOError)))) ...;
```

### 1.3 `std/fs/dir.yo` — Directory Operations

```yo
// High-level directory operations
create_dir :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
create_dir_all :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
remove_dir :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
remove_dir_all :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
remove_file :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
rename :: (fn(from: String, to: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
hard_link :: (fn(src: String, dst: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
symlink :: (fn(src: String, dst: String, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;

// Directory listing
DirEntry :: struct(
  name : String,
  path : String,
  file_type : FileType,
  ino : u64
);

FileType :: enum(File, Directory, Symlink, Other);   // note: no leading dots in enum declaration

read_dir :: (fn(path: String, using(io : IO)) -> Impl(Future(Result(ArrayList(DirEntry), IOError)))) ...;
```

### 1.4 `std/fs/walker.yo` — Recursive Directory Traversal

```yo
WalkEntry :: struct(
  path : String,
  name : String,
  depth : u32,
  file_type : FileType
);

WalkOptions :: struct(
  max_depth : ?u32,
  follow_symlinks : bool,
  include_dirs : bool
);

walk :: (fn(root: String, using(io : IO)) -> Impl(Future(Result(ArrayList(WalkEntry), IOError)))) ...;
walk_with :: (fn(root: String, options: WalkOptions, using(io : IO)) -> Impl(Future(Result(ArrayList(WalkEntry), IOError)))) ...;
```

### 1.5 `std/fs/temp.yo` — Temporary Files and Directories

```yo
TempDir :: object(
  _path : String,
  _removed : bool
);
TempDir.new :: (fn(using(io : IO)) -> Impl(Future(Result(TempDir, IOError)))) ...;
TempDir.new_in :: (fn(parent: String, using(io : IO)) -> Impl(Future(Result(TempDir, IOError)))) ...;
TempDir.path :: (fn(self: Self) -> String) ...;
TempDir.remove :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;

TempFile :: object(
  file : File,
  _path : String
);
TempFile.new :: (fn(using(io : IO)) -> Impl(Future(Result(TempFile, IOError)))) ...;
TempFile.new_in :: (fn(parent: String, using(io : IO)) -> Impl(Future(Result(TempFile, IOError)))) ...;
TempFile.path :: (fn(self: Self) -> String) ...;
TempFile.remove :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, IOError)))) ...;
```

**Tests**: File read/write round-trip, buffered I/O, read_to_string, metadata queries, create_dir_all, remove_dir_all, directory walk, temp file/dir auto-cleanup.

---

## Phase 2: High-Level Networking (`std/net`) — Priority: Critical

**Goal**: Provide ergonomic async TCP/UDP client and server types. This is the second most important module for building real applications.

**Depends on**: `std/io/tcp`, `std/io/udp`, `std/io/unix`, `std/io/dns`, `std/io/sockinfo`, `std/io/socketpair`, `std/string`

### 2.1 `std/net/addr.yo` — Network Addresses

```yo
IpAddr :: enum(
  V4(a: u8, b: u8, c: u8, d: u8),
  V6(segments: Array(u16, usize(8)))
);

SocketAddr :: struct(
  ip : IpAddr,
  port : u16
);

IpAddr.parse :: (fn(s: str) -> Result(IpAddr, NetError)) ...;
IpAddr.loopback_v4 :: (fn() -> IpAddr) ...;
IpAddr.loopback_v6 :: (fn() -> IpAddr) ...;
IpAddr.any_v4 :: (fn() -> IpAddr) ...;
IpAddr.is_loopback :: (fn(self: *(Self)) -> bool) ...;
IpAddr.is_multicast :: (fn(self: *(Self)) -> bool) ...;
IpAddr.to_string :: (fn(self: *(Self)) -> String) ...;

SocketAddr.new :: (fn(ip: IpAddr, port: u16) -> SocketAddr) ...;
SocketAddr.parse :: (fn(s: str) -> Result(SocketAddr, NetError)) ...;
```

### 2.2 `std/net/tcp.yo` — TCP Client and Server

```yo
TcpListener :: object(
  fd : i32,
  local_addr : SocketAddr
);
TcpListener.bind :: (fn(addr: SocketAddr, using(io : IO)) -> Impl(Future(Result(TcpListener, NetError)))) ...;
TcpListener.accept :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(TcpStream, NetError)))) ...;
TcpListener.local_addr :: (fn(self: Self) -> SocketAddr) ...;
TcpListener.close :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, NetError)))) ...;

TcpStream :: object(
  fd : i32,
  local_addr : SocketAddr,
  peer_addr : SocketAddr,
  _read_buf : ArrayList(u8),
  _write_buf : ArrayList(u8)
);
TcpStream.connect :: (fn(addr: SocketAddr, using(io : IO)) -> Impl(Future(Result(TcpStream, NetError)))) ...;
TcpStream.read :: (fn(self: Self, buf: *(u8), size: usize, using(io : IO)) -> Impl(Future(Result(i32, NetError)))) ...;
TcpStream.write :: (fn(self: Self, data: String, using(io : IO)) -> Impl(Future(Result(i32, NetError)))) ...;
TcpStream.write_bytes :: (fn(self: Self, data: ArrayList(u8), using(io : IO)) -> Impl(Future(Result(i32, NetError)))) ...;
TcpStream.flush :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, NetError)))) ...;
TcpStream.read_all :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(ArrayList(u8), NetError)))) ...;
TcpStream.shutdown :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, NetError)))) ...;
TcpStream.close :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, NetError)))) ...;
TcpStream.local_addr :: (fn(self: Self) -> SocketAddr) ...;
TcpStream.peer_addr :: (fn(self: Self) -> SocketAddr) ...;
TcpStream.set_nodelay :: (fn(self: Self, nodelay: bool, using(io : IO)) -> Impl(Future(Result(unit, NetError)))) ...;
TcpStream.set_keepalive :: (fn(self: Self, enabled: bool, using(io : IO)) -> Impl(Future(Result(unit, NetError)))) ...;
```

### 2.3 `std/net/udp.yo` — UDP Socket

```yo
UdpSocket :: object(
  fd : i32,
  local_addr : SocketAddr
);
UdpSocket.bind :: (fn(addr: SocketAddr, using(io : IO)) -> Impl(Future(Result(UdpSocket, NetError)))) ...;
UdpSocket.send_to :: (fn(self: Self, data: ArrayList(u8), addr: SocketAddr, using(io : IO)) -> Impl(Future(Result(i32, NetError)))) ...;
UdpSocket.recv_from :: (fn(self: Self, buf: *(u8), size: usize, using(io : IO)) -> Impl(Future(Result(struct(len: i32, addr: SocketAddr), NetError)))) ...;
UdpSocket.connect :: (fn(self: Self, addr: SocketAddr, using(io : IO)) -> Impl(Future(Result(unit, NetError)))) ...;
UdpSocket.send :: (fn(self: Self, data: ArrayList(u8), using(io : IO)) -> Impl(Future(Result(i32, NetError)))) ...;
UdpSocket.recv :: (fn(self: Self, buf: *(u8), size: usize, using(io : IO)) -> Impl(Future(Result(i32, NetError)))) ...;
UdpSocket.close :: (fn(self: Self, using(io : IO)) -> Impl(Future(Result(unit, NetError)))) ...;
UdpSocket.set_broadcast :: (fn(self: Self, enabled: bool, using(io : IO)) -> Impl(Future(Result(unit, NetError)))) ...;
```

### 2.4 `std/net/dns.yo` — DNS Resolution

```yo
lookup_host :: (fn(host: String, using(io : IO)) -> Impl(Future(Result(ArrayList(IpAddr), NetError)))) ...;
resolve :: (fn(host: String, port: u16, using(io : IO)) -> Impl(Future(Result(ArrayList(SocketAddr), NetError)))) ...;
```

### 2.5 `std/net/errors.yo` — Network Errors

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
```

**Tests**: TCP echo server/client with typed API, UDP datagram exchange, DNS lookup, address parsing/formatting, connection error handling.

---

## Phase 3: Time and Duration (`std/time`) — Priority: High

**Goal**: Rich time support with Duration, Instant (monotonic), and DateTime (wall clock). Essential for benchmarking, logging, timeouts, and scheduling.

**Depends on**: `std/io/clock`, `std/io/timer`, `std/string`, `std/fmt`

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

---

## Phase 4: String Formatting (`std/fmt`) — Priority: High

**Goal**: A type-safe string formatting/interpolation engine, like Rust's `format!` or Python's f-strings. The `ToString` trait is already implemented; this phase adds composable formatting.

**Depends on**: `std/string`, `std/fmt/to_string`

### 4.1 `std/fmt/writer.yo` — String Writer

```yo
Writer :: object(
  buf : ArrayList(u8)
);

Writer.new :: (fn() -> Writer) ...;
Writer.with_capacity :: (fn(cap: usize) -> Writer) ...;
Writer.write_str :: (fn(self: Self, s: str) -> Self) ...;
Writer.write_string :: (fn(self: Self, s: String) -> Self) ...;
Writer.write_byte :: (fn(self: Self, b: u8) -> Self) ...;
Writer.write_bytes :: (fn(self: Self, data: ArrayList(u8)) -> Self) ...;
Writer.write_rune :: (fn(self: Self, r: rune) -> Self) ...;
Writer.write_i64 :: (fn(self: Self, n: i64) -> Self) ...;
Writer.write_u64 :: (fn(self: Self, n: u64) -> Self) ...;
Writer.write_f64 :: (fn(self: Self, n: f64, precision: i32) -> Self) ...;
Writer.write_bool :: (fn(self: Self, b: bool) -> Self) ...;
Writer.write_hex :: (fn(self: Self, n: u64) -> Self) ...;
Writer.write_octal :: (fn(self: Self, n: u64) -> Self) ...;
Writer.write_binary :: (fn(self: Self, n: u64) -> Self) ...;
Writer.write_padded :: (fn(self: Self, s: str, width: usize, pad: rune, align: Alignment) -> Self) ...;
Writer.to_string :: (fn(self: Self) -> String) ...;
Writer.to_str :: (fn(self: Self) -> str) ...;
Writer.len :: (fn(self: Self) -> usize) ...;

Alignment :: enum(Left, Right, Center);
```

### 4.2 `std/fmt/display.yo` — Display Trait

```yo
Display :: (fn(comptime(T) : Type) -> comptime(Type))
  trait(
    display :: (fn(self: *(T), writer: Writer) -> Writer)
  )
;
```

Default implementations for all primitive types, String, rune, bool. Collections can implement Display for pretty-printing.

**Tests**: Writer chaining, numeric formatting (hex, octal, binary), padding/alignment, Display trait for custom types.

---

## Phase 5: Encoding & Serialization (`std/encoding`) — Priority: Medium

**Goal**: Common data encoding/decoding formats essential for network protocols, file formats, and data interchange.

**Depends on**: `std/string`, `std/collections/array_list`

### 5.1 `std/encoding/base64.yo` — Base64

```yo
base64_encode :: (fn(data: ArrayList(u8)) -> String) ...;
base64_decode :: (fn(s: str) -> Result(ArrayList(u8), EncodingError)) ...;
base64_encode_url :: (fn(data: ArrayList(u8)) -> String) ...;
base64_decode_url :: (fn(s: str) -> Result(ArrayList(u8), EncodingError)) ...;
```

### 5.2 `std/encoding/hex.yo` — Hexadecimal

```yo
hex_encode :: (fn(data: ArrayList(u8)) -> String) ...;
hex_decode :: (fn(s: str) -> Result(ArrayList(u8), EncodingError)) ...;
```

### 5.3 `std/encoding/json.yo` — JSON

```yo
JsonValue :: enum(
  Null,
  Bool(value: bool),
  Number(value: f64),
  Str(value: String),
  Array(items: ArrayList(JsonValue)),
  Object(fields: HashMap(String, JsonValue))
);

json_parse :: (fn(s: str) -> Result(JsonValue, JsonError)) ...;
json_stringify :: (fn(value: JsonValue) -> String) ...;
json_stringify_pretty :: (fn(value: JsonValue, indent: usize) -> String) ...;

JsonValue.get :: (fn(self: Self, key: str) -> ?JsonValue) ...;
JsonValue.at :: (fn(self: Self, index: usize) -> ?JsonValue) ...;
JsonValue.as_bool :: (fn(self: Self) -> ?bool) ...;
JsonValue.as_number :: (fn(self: Self) -> ?f64) ...;
JsonValue.as_string :: (fn(self: Self) -> ?String) ...;
JsonValue.as_array :: (fn(self: Self) -> ?ArrayList(JsonValue)) ...;
JsonValue.as_object :: (fn(self: Self) -> ?HashMap(String, JsonValue)) ...;
```

### 5.4 `std/encoding/utf16.yo` — UTF-16

```yo
utf8_to_utf16 :: (fn(s: str) -> ArrayList(u16)) ...;
utf16_to_utf8 :: (fn(data: ArrayList(u16)) -> Result(String, EncodingError)) ...;
```

**Tests**: Base64 encode/decode round-trip, hex encode/decode, JSON parse/stringify, UTF-16 conversion including surrogate pairs.

---

## Phase 6: Cryptographic Hashing & Random (`std/crypto`) — Priority: Medium

**Goal**: Common hash functions and cryptographically secure random number generation. Essential for security, checksums, and unique ID generation.

**Depends on**: `std/string`, `std/collections/array_list`

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

**Tests**: Hash known test vectors, random distribution basic sanity, UUID format validation.

---

## Phase 7: Math Extensions (`std/math`) — Priority: Medium

**Goal**: Math utilities beyond libc. The `std/libc/math.yo` already exposes `sin`, `cos`, `sqrt`, etc. This phase adds higher-level math types and algorithms.

**Depends on**: `std/libc/math`, `std/fmt`

### 7.1 `std/math/functions.yo` — Additional Math Functions

```yo
abs :: (fn(forall(T : Type), x: T) -> T) ...;
min :: (fn(forall(T : Type), a: T, b: T) -> T) ...;
max :: (fn(forall(T : Type), a: T, b: T) -> T) ...;
clamp :: (fn(forall(T : Type), x: T, lo: T, hi: T) -> T) ...;
lerp :: (fn(a: f64, b: f64, t: f64) -> f64) ...;
map_range :: (fn(value: f64, in_min: f64, in_max: f64, out_min: f64, out_max: f64) -> f64) ...;

PI :: f64(3.14159265358979323846);
E :: f64(2.71828182845904523536);
TAU :: f64(6.28318530717958647692);

is_nan :: (fn(x: f64) -> bool) ...;
is_inf :: (fn(x: f64) -> bool) ...;
is_finite :: (fn(x: f64) -> bool) ...;
```

### 7.2 `std/math/random.yo` — PRNG (Non-Cryptographic)

```yo
Rng :: object(state: u64);
Rng.new :: (fn(seed: u64) -> Rng) ...;
Rng.next_u32 :: (fn(self: Self) -> u32) ...;
Rng.next_u64 :: (fn(self: Self) -> u64) ...;
Rng.next_f64 :: (fn(self: Self) -> f64) ...;
Rng.next_range :: (fn(self: Self, min: i64, max: i64) -> i64) ...;
Rng.shuffle :: (fn(forall(T : Type), self: Self, list: ArrayList(T)) -> unit) ...;
```

Uses xoshiro256\*\* or similar fast PRNG algorithm.

**Tests**: Min/max/clamp, NaN/Inf detection, PRNG determinism with same seed, shuffle coverage.

---

## Phase 8: Error Handling (`std/error`) — Priority: High

**Goal**: Standard error types and error handling patterns beyond `Result` and `IOError`.

**Depends on**: `std/string`, `std/fmt`

### 8.1 `std/error/error.yo` — Error Trait

```yo
Error :: (fn(comptime(T) : Type) -> comptime(Type))
  trait(
    message :: (fn(self: *(T)) -> String),
    source :: (fn(self: *(T)) -> ?Box(dyn(Error)))
  )
;
```

### 8.2 `std/error/panic.yo` — Panic & Recovery

```yo
panic :: (fn(msg: str) -> !) ...;
```

**Tests**: Error trait implementation, error chaining, panic message capture.

---

## Phase 9: Logging (`std/log`) — Priority: Low

**Goal**: Structured logging with levels, filtering, and pluggable outputs.

**Depends on**: `std/time`, `std/fmt`, `std/string`, `std/io/file`

### 9.1 `std/log/log.yo` — Logging API

```yo
Level :: enum(Trace, Debug, Info, Warn, Error);

Logger :: object(
  level : Level,
  output : LogOutput
);

LogOutput :: enum(
  Stderr,
  Stdout,
  File(path: String)
);

log :: (fn(level: Level, msg: str) -> unit) ...;
trace :: (fn(msg: str) -> unit) ...;
debug :: (fn(msg: str) -> unit) ...;
info :: (fn(msg: str) -> unit) ...;
warn :: (fn(msg: str) -> unit) ...;
error :: (fn(msg: str) -> unit) ...;

set_level :: (fn(level: Level) -> unit) ...;
set_output :: (fn(output: LogOutput) -> unit) ...;
```

**Tests**: Log level filtering, output to stderr/file, structured log format.

---

## Phase 10: Testing Utilities (`std/testing`) — Priority: Low

**Goal**: Testing helpers beyond the built-in `assert`. Provides structured assertions, test fixtures, and basic benchmarking.

**Depends on**: `std/fmt`, `std/string`, `std/time`

### 10.1 `std/testing/assert.yo` — Rich Assertions

```yo
assert_eq :: (fn(forall(T : Type), actual: T, expected: T, msg: str) -> unit) ...;
assert_ne :: (fn(forall(T : Type), actual: T, expected: T, msg: str) -> unit) ...;
assert_gt :: (fn(forall(T : Type), actual: T, expected: T, msg: str) -> unit) ...;
assert_lt :: (fn(forall(T : Type), actual: T, expected: T, msg: str) -> unit) ...;
assert_ge :: (fn(forall(T : Type), actual: T, expected: T, msg: str) -> unit) ...;
assert_le :: (fn(forall(T : Type), actual: T, expected: T, msg: str) -> unit) ...;
assert_contains :: (fn(haystack: str, needle: str, msg: str) -> unit) ...;
assert_starts_with :: (fn(s: str, prefix: str, msg: str) -> unit) ...;
assert_approx :: (fn(actual: f64, expected: f64, epsilon: f64, msg: str) -> unit) ...;
```

### 10.2 `std/testing/bench.yo` — Benchmarking

```yo
bench :: (fn(name: str, iterations: u64, body: Fn(() -> unit)) -> BenchResult) ...;

BenchResult :: struct(
  name : String,
  iterations : u64,
  total_ns : i64,
  avg_ns : i64,
  min_ns : i64,
  max_ns : i64
);
```

**Tests**: Assertion failure messages, benchmark timing accuracy.

---

## Phase 11: Advanced Collections (`std/collections`) — Priority: Low

**Goal**: Additional data structures beyond the existing ArrayList, HashMap, HashSet, LinkedList.

**Depends on**: `std/allocator`, `std/fmt`

### 11.1 `std/collections/deque.yo` — Double-Ended Queue

```yo
Deque :: (fn(comptime(T) : Type) -> comptime(Type))
  object(
    _buf : ?(*(T)),
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

## Phase 12: OS Utilities (`std/os`) — Priority: Low

**Goal**: OS-level utilities that don't fit in `std/io` or `std/process`.

**Depends on**: `std/io/signal`, `std/io/sysinfo`, `std/string`

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

on_signal :: (fn(sig: Signal, handler: Fn(() -> unit)) -> Result(unit, IOError)) ...;
off_signal :: (fn(sig: Signal) -> Result(unit, IOError)) ...;
```

### 12.2 `std/os/env.yo` — Environment Utilities

```yo
home_dir :: (fn() -> ?String) ...;
config_dir :: (fn() -> ?String) ...;
cache_dir :: (fn() -> ?String) ...;
temp_dir :: (fn() -> String) ...;
exe_path :: (fn() -> Result(String, IOError)) ...;
```

**Tests**: Signal registration/delivery, home_dir resolution, temp_dir validity.

---

## Dependency Graph

```
Phase 1  (std/fs)          ← CRITICAL — every program needs file I/O
  └── Depends on: std/io/file, std/io/dir, std/io/seek, std/io/statx, std/io/perm
                  std/io/temp, std/path, std/string, std/collections

Phase 2  (std/net)         ← CRITICAL — needed for any networked application
  └── Depends on: std/io/tcp, std/io/udp, std/io/unix, std/io/dns
                  std/io/sockinfo, std/string, std/collections

Phase 3  (std/time)        ← HIGH — needed for benchmarks, logging, scheduling
  └── Depends on: std/io/clock, std/io/timer

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
  └── Depends on: std/io/signal, std/io/sysinfo, std/string
```

## Recommended Implementation Order

| Order | Phase    | Module                                             | Priority | Est. Effort |
| ----- | -------- | -------------------------------------------------- | -------- | ----------- |
| 1     | Phase 8  | `std/error` — Error trait                          | High     | Small       |
| 2     | Phase 4  | `std/fmt` — Writer + Display                       | High     | Medium      |
| 3     | Phase 3  | `std/time` — Duration, Instant, DateTime           | High     | Medium      |
| 4     | Phase 1  | `std/fs` — File, Metadata, Dir, Walker             | Critical | Large       |
| 5     | Phase 2  | `std/net` — TcpListener, TcpStream, UdpSocket      | Critical | Large       |
| 6     | Phase 7  | `std/math` — Functions, PRNG                       | Medium   | Small       |
| 7     | Phase 5  | `std/encoding` — Base64, Hex, JSON                 | Medium   | Medium      |
| 8     | Phase 6  | `std/crypto` — SHA-256, MD5, Random                | Medium   | Medium      |
| 9     | Phase 10 | `std/testing` — Assertions, Bench                  | Low      | Small       |
| 10    | Phase 9  | `std/log` — Structured logging                     | Low      | Small       |
| 11    | Phase 11 | `std/collections` — Deque, BTreeMap, PriorityQueue | Low      | Medium      |
| 12    | Phase 12 | `std/os` — Signals, Env dirs                       | Low      | Small       |

**Rationale**: Error trait and fmt/Writer come first because they're dependencies of almost everything else. Time comes before fs/net because Duration/Instant are useful for timeouts and logging. fs and net are the largest, most impactful modules. Math/encoding/crypto are independent utilities. Testing, logging, and advanced collections are low priority since the existing tools work.

## Design Principles

1. **Build on `std/io`, don't duplicate**: High-level modules call into `std/io/*` for all system operations. No direct C externs in high-level modules.

2. **Return `Result`, not raw `i32`**: High-level APIs use `Result(T, Error)` for all fallible operations. Async fallible I/O operations return `Impl(Future(Result(T, Error)))`. Callers use `io.await(fn(...))` to get back a `Result` and then pattern-match or propagate using the `?` operator. The `std/io` errno-based pattern stays in `std/io`.

3. **Use `str` and `String`, not `*(u8)`**: High-level APIs accept `str` (for literal/borrowed strings) and `String` (for owned strings). Path conversion to `*(u8)` via `.to_cstr()` is done internally.

4. **Objects with `Dispose`**: Resources (File, TcpStream, TempDir) are `object` types implementing `Dispose` for automatic cleanup through reference counting.

5. **Async-first for I/O via Algebraic Effects**: File and network operations use `using(io : IO)` and `io.await(...)`. Callers must have an IO effect in scope (e.g., via `test ... using(io : IO), { ... }` or `main :: (fn(using(io : IO)) -> unit)(...)`).

6. **Cross-platform by default**: All APIs must work on Linux, macOS, and Windows. Platform-specific behavior is documented but never exposed in the type signatures.

7. **No barrel re-exports**: Import specific modules directly: `{ File } :: import "std/fs/file"`, `{ TcpStream } :: import "std/net/tcp"`.

8. **`ArrayList(u8)` for byte buffers**: Prefer `ArrayList(u8)` over `Slice(u8)` for owned byte data. Use `*(u8)` with an explicit size for raw buffer parameters.

## Notes

- **`str` vs `String` for paths**: `std/fs` functions accept `str` (byte slice) for paths since most paths come from string literals or template strings. Internally, `str.to_cstr()` converts to a null-terminated `*(u8)` for the `std/io` layer. Users working with dynamic paths can use `String.to_str()` to get a `str`.

- **Buffered I/O strategy**: `File` objects use internal `ArrayList(u8)` buffers (default 8KB). Reads fill the buffer in one syscall; subsequent reads drain from buffer. Writes accumulate in buffer until `flush()` or buffer full. This amortizes syscall overhead for small reads/writes.

- **JSON as a value type**: `JsonValue` is an `enum` rather than a trait/interface. This keeps the API simple (parse → walk → extract) without requiring codegen or reflection. Type-safe serialization of custom structs can be added later via a `Serialize`/`Deserialize` trait.

- **Cryptographic disclaimer**: `std/crypto` provides common hash functions, NOT a full cryptographic library. For production security needs (TLS, encryption), users should FFI to OpenSSL/libsodium.

- **PRNG vs CSPRNG**: `std/math/random` provides a fast PRNG (xoshiro256\*\*) for games/simulations. `std/crypto/random` provides cryptographically secure random using OS entropy. The two should never be confused.

- **IO effect propagation**: Any function that calls an async I/O operation must either handle the `IO` effect (by providing `given(io)`) or propagate it via `using(io : IO)` in its own signature. Errors are returned as `Result(T, E)` values. The `main` function automatically receives IO from the runtime.
