# std/sys 模块

## 设计理念

Yo 将平台原生的异步 I/O API 与单线程 async/await 事件循环集成：

| 平台        | 后端     | 状态      | 描述                                                                       |
| ----------- | -------- | --------- | -------------------------------------------------------------------------- |
| **Linux**   | io_uring | ✅ 已完成 | 内核执行 I/O 操作的真正异步 I/O（内核 5.6+；环形层已内嵌，无库依赖）        |
| **macOS**   | kqueue   | ✅ 已完成 | kqueue 事件循环：socket/pipe 使用非阻塞 I/O，常规文件使用同步 pread/pwrite |
| **Windows** | IOCP     | ✅ 已完成 | 使用重叠 I/O 的 I/O 完成端口                                               |
| **FreeBSD** | kqueue   | 🔜 计划中 | 事件通知 + 非阻塞 I/O                                                      |

所有异步 I/O 操作都在与其他异步任务**相同的线程**上运行——不涉及工作线程。

### 为什么不用 libuv？

我们考虑过使用 **libuv**（Node.js 的跨平台异步 I/O 库），但最终选择了手动实现各平台方案：

| 因素         | libuv                | 手动方案（Yo）                  |
| ------------ | -------------------- | ------------------------------- |
| **事件循环** | 拥有自己的事件循环   | 与 Yo 的 async/await 调度器集成 |
| **依赖项**   | 需要 libuv 运行时    | 无运行时依赖（静态链接）        |
| **性能**     | 良好，但有抽象层开销 | 最优——直接使用原生 API          |
| **控制力**   | 受限于 libuv 的模型  | 完全控制状态机集成              |
| **复杂度**   | 初期较低，集成时较高 | 初期较高，长期更简洁            |

**核心洞察**：Yo 的 async/await 编译为状态机。平台原生异步 I/O（io_uring、kqueue、IOCP）与此模型完美契合——完成事件直接唤醒状态机。libuv 基于回调的设计需要一个尴尬的桥接层。

## 设计目标

1. **单线程**：所有异步 I/O 在事件循环线程上运行
2. **非原子 RC**：无同步开销（单线程）
3. **跨平台**：Linux/macOS/Windows 统一 API
4. **高效**：使用平台原生后端（io_uring/kqueue/IOCP）
5. **简洁 API**：async/await 语法，无回调
6. **内存高效**：每个操作仅需状态机（约 200 字节）

---

## 模块结构

`std/sys/` 目录提供底层异步 I/O 基础设施。用户直接导入子模块——没有 barrel `index.yo`：

```
std/sys/
├── advise.yo       — fadvise/madvise 文件建议提示
├── clock.yo        — clock_gettime（实时时钟 + 单调时钟）
├── constants.yo    — 文件模式、权限、AT_*、DT_*、open 标志、O_*
├── copy.yo         — copyfile、sendfile
├── dir.yo          — mkdir、unlink、rename、symlink、link、readlink、getdents/readdir
├── dns.yo          — getaddrinfo、getnameinfo、addrinfo 访问器
├── errors.yo       — IoError 枚举与 errno 映射、ToString 实现
├── events.yo       — TTY/poll/FS 事件常量 + FS 事件/poll 包装器
├── externs.yo      — 运行时辅助 extern（同步系统调用、访问器、waker）
├── fallocate.yo    — fallocate（预分配文件空间）
├── fcntl.yo        — getfl/setfl/getfd/setfd（文件描述符标志）
├── file.yo         — 异步 + 同步文件操作（openat、read、write、stat、fsync 等）
├── future.yo       — park、yield、completed（IoFuture 在 prelude 中）
├── iov.yo          — readv/writev/preadv/pwritev + iovec 辅助函数
├── lock.yo         — flock 建议性锁
├── mmap.yo         — mmap、munmap、mprotect、msync
├── path.yo         — realpath
├── perm.yo         — fchmod、chmodat、fchown、chownat、access
├── pipe.yo         — pipe、dup、dup2
├── process.yo      — spawn、waitpid、kill
├── seek.yo         — lseek 包装器
├── signal.yo       — on_signal、off_signal、kill
├── signals.yo      — 平台感知的 POSIX 信号编号常量
├── socket.yo       — 平台感知的 AF_*、SOCK_*、SO_*、TCP_* 常量 + NI_* 常量
├── socketpair.yo   — 已连接的 socket 对
├── sockinfo.yo     — getsockname、getpeername、getsockopt、setsockopt
├── statfs.yo       — statfs + 访问器（同步）
├── statx.yo        — 文件元数据访问器对象（包装 __yo_statx_t）
├── sysinfo.yo      — uname、gethostname
├── tcp.yo          — Socket、bind、listen、accept、connect、send、recv、close
├── temp.yo         — mkdtemp、mkstemp
├── time.yo         — utime、futime、lutime（文件时间戳操作）
├── timer.yo        — sleep(ms)
├── tty.yo          — tty 初始化/模式/窗口大小/isatty
├── udp.yo          — Socket、bind、sendto、recvfrom、send、recv、close
├── umask.yo        — 进程文件创建掩码
└── unix.yo         — Unix 域 socket
```

**导入模式**：使用命名空间导入以避免命名冲突，例如：

```yo
file :: import("std/sys/file");
dir :: import("std/sys/dir");
tcp :: import("std/sys/tcp");
timer :: import("std/sys/timer");
```

**每个操作都接收 `Io`。** 返回 `IoFuture` 的函数（`openat`、`read`、`accept`、
`sleep` 等）把它运行所在的 `Io` 作为最后一个参数，并调用该 `Io` 的表
（`io.vtable.*.read(io.ctx, …)`，即 prelude 的 `IoVTable`）。`events.yo` 中的监视注册
（`poll_*`、`fs_event_*`）也接收它。在创建操作的地方就 await 它：

```yo
pragma(Pragma.AllowUnsafe);
file :: import("std/sys/file");
{ AT_FDCWD, O_RDONLY } :: import("std/sys/constants");

main :: (fn(io : Io) -> unit)({
  fd := io.await(file.openat(AT_FDCWD, (*u8)("/etc/hostname"), O_RDONLY, i32(0), io), io);
  if(fd >= i32(0), {
    _c := io.await(file.close(fd, io), io);
  });
});
export(main);
```

同步辅助函数（`open_sync`、`fcntl`、`mmap`、地址与 stat 访问器）是阻塞调用，不接收 `Io`。

---

## 组件状态

### Yo 模块（`std/sys/`）

| 组件        | 文件            | 状态      | 备注                                                     |
| ----------- | --------------- | --------- | -------------------------------------------------------- |
| 常量        | `constants.yo`  | ✅ 已完成 | 文件模式、权限、AT*\*、DT*\*、open 标志                  |
| Socket 常量 | `socket.yo`     | ✅ 已完成 | 平台感知的 AF*\*、SOCK*\_、SO\_\_、TCP*\*、NI*\*         |
| 信号        | `signals.yo`    | ✅ 已完成 | 平台感知的 POSIX 信号编号                                |
| 事件        | `events.yo`     | ✅ 已完成 | TTY/poll/FS 事件常量 + FS/poll 包装器                    |
| IoError     | `errors.yo`     | ✅ 已完成 | 枚举与 errno 映射、ToString 实现                         |
| Future      | `future.yo`     | ✅ 已完成 | `park`、`yield`、`completed`；`IoFuture` 在 prelude 中   |
| Externs     | `externs.yo`    | ✅ 已完成 | 运行时辅助 extern；操作经过 `Io`                         |
| Statx       | `statx.yo`      | ✅ 已完成 | 文件元数据访问器对象                                     |
| Timer       | `timer.yo`      | ✅ 已完成 | `sleep(ms)`                                              |
| File        | `file.yo`       | ✅ 已完成 | 异步+同步文件操作（openat、read、write 等）              |
| Dir         | `dir.yo`        | ✅ 已完成 | mkdir、unlink、rename、symlink、link、readlink、getdents |
| TCP         | `tcp.yo`        | ✅ 已完成 | Socket、bind、listen、accept、connect、send、recv、close |
| UDP         | `udp.yo`        | ✅ 已完成 | Socket、bind、sendto、recvfrom、send、recv、close        |
| Unix        | `unix.yo`       | ✅ 已完成 | Unix 域 socket + 测试                                    |
| Process     | `process.yo`    | ✅ 已完成 | spawn、waitpid、kill + 测试                              |
| DNS         | `dns.yo`        | ✅ 已完成 | getaddrinfo、getnameinfo、addrinfo 访问器                |
| Perm        | `perm.yo`       | ✅ 已完成 | fchmod、chmodat、fchown、chownat、access                 |
| Time        | `time.yo`       | ✅ 已完成 | utime、futime、lutime（文件时间戳操作）                  |
| Pipe        | `pipe.yo`       | ✅ 已完成 | pipe、dup、dup2 + 测试                                   |
| Copy        | `copy.yo`       | ✅ 已完成 | copyfile、sendfile + 测试                                |
| Signal      | `signal.yo`     | ✅ 已完成 | on_signal、off_signal、kill + 测试                       |
| TTY         | `tty.yo`        | ✅ 已完成 | tty 初始化/模式/窗口大小/isatty + 测试                   |
| Temp        | `temp.yo`       | ✅ 已完成 | mkdtemp、mkstemp + 测试                                  |
| Path        | `path.yo`       | ✅ 已完成 | realpath + 测试                                          |
| Statfs      | `statfs.yo`     | ✅ 已完成 | statfs + 访问器（同步）                                  |
| Fcntl       | `fcntl.yo`      | ✅ 已完成 | getfl/setfl/getfd/setfd + 测试                           |
| Mmap        | `mmap.yo`       | ✅ 已完成 | mmap、munmap、mprotect、msync + 测试                     |
| Lock        | `lock.yo`       | ✅ 已完成 | flock 建议性锁 + 测试                                    |
| SockInfo    | `sockinfo.yo`   | ✅ 已完成 | getsockname、getpeername、getsockopt、setsockopt + 测试  |
| SocketPair  | `socketpair.yo` | ✅ 已完成 | 已连接的 socket 对 + 测试                                |
| Clock       | `clock.yo`      | ✅ 已完成 | clock_gettime（实时时钟 + 单调时钟）+ 测试               |
| SysInfo     | `sysinfo.yo`    | ✅ 已完成 | uname、gethostname + 测试                                |
| Umask       | `umask.yo`      | ✅ 已完成 | 进程文件创建掩码 + 测试                                  |
| Iov         | `iov.yo`        | ✅ 已完成 | readv/writev/preadv/pwritev + iovec 辅助函数 + 测试      |
| Seek        | `seek.yo`       | ✅ 已完成 | lseek 包装器                                             |
| Fallocate   | `fallocate.yo`  | ✅ 已完成 | fallocate（预分配文件空间）                              |
| Advise      | `advise.yo`     | ✅ 已完成 | fadvise/madvise 文件建议提示                             |

### API 覆盖范围

| 类别               | API                                                                                   | 状态      |
| ------------------ | ------------------------------------------------------------------------------------- | --------- |
| **定时器**         | `sleep`                                                                               | ✅ 已完成 |
| **文件 I/O**       | `read`、`write`、`open`、`close`、`stat`、`truncate`、`fsync`、`fdatasync`            | ✅ 已完成 |
| **文件扩展**       | `access`、`realpath`、`utime`、`mkdtemp`、`mkstemp`、`copyfile`、`sendfile`、`statfs` | ✅ 已完成 |
| **文件建议**       | `fadvise`、`madvise`、`fallocate`、`lseek`                                            | ✅ 已完成 |
| **目录操作**       | `mkdir`、`unlink`、`rename`、`symlink`、`link`、`readdir`、`getdents`                 | ✅ 已完成 |
| **权限**           | `chmod`、`chown`、`access`                                                            | ✅ 已完成 |
| **文件描述符操作** | `dup`、`dup2`、`pipe`、`fcntl`                                                        | ✅ 已完成 |
| **内存映射**       | `mmap`、`munmap`、`mprotect`、`msync`                                                 | ✅ 已完成 |
| **文件锁**         | `flock`                                                                               | ✅ 已完成 |
| **Socket**         | `socket`、`bind`、`listen`、`accept`、`connect`、`send`、`recv`、`sendto`、`recvfrom` | ✅ 已完成 |
| **Socket 选项**    | `setsockopt`、`getsockopt`、`shutdown`、`getsockname`、`getpeername`、`socketpair`    | ✅ 已完成 |
| **DNS**            | `getaddrinfo`、`getnameinfo`                                                          | ✅ 已完成 |
| **信号**           | `on_signal`、`off_signal`、`kill`                                                     | ✅ 已完成 |
| **TTY**            | `tty_init`、`tty_set_mode`、`tty_reset_mode`、`tty_get_winsize`、`isatty`             | ✅ 已完成 |
| **FS 事件**        | `fs_event_init`、`fs_event_start`、`fs_event_stop`、`fs_event_close`                  | ✅ 已完成 |
| **Poll**           | `poll_init`、`poll_start`、`poll_stop`、`poll_close`                                  | ✅ 已完成 |
| **时钟**           | `clock_gettime`（实时时钟 + 单调时钟）                                                | ✅ 已完成 |
| **系统信息**       | `uname`、`gethostname`、`umask`                                                       | ✅ 已完成 |
| **进程**           | `spawn`、`waitpid`、`kill`                                                            | ✅ 已完成 |
| **向量化 I/O**     | `readv`、`writev`、`preadv`、`pwritev`                                                | ✅ 已完成 |

---

## C 运行时架构

C 运行时被拆分为 `src/codegen/async/` 下的多个专注模块：

| 文件                    | 职责                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `runtime.yo`            | 轻量协调器——调用其他运行时模块                                             |
| `runtime-core.yo`       | 核心调度器：continuation 队列、spawn、wait、并发辅助函数                   |
| `runtime-io-linux.yo`   | Linux io_uring 异步 I/O                                                    |
| `runtime-io-macos.yo`   | macOS kqueue 异步 I/O（socket/pipe 非阻塞，常规文件同步 pread/pwrite）     |
| `runtime-io-windows.yo` | Windows IOCP 异步 I/O                                                      |
| `runtime-io-common.yo`  | 跨平台：stat 辅助函数、定时器、文件扩展功能、DNS、信号、TTY、FS 事件、poll |

### 各平台功能矩阵

| 类别                        | Linux (io_uring)      | macOS (kqueue)        | Windows (IOCP)                                     |
| --------------------------- | --------------------- | --------------------- | -------------------------------------------------- |
| **事件循环集成**            | ✅                    | ✅                    | ✅ (IOCP)                                          |
| **文件读写**                | ✅                    | ✅                    | ✅ (IOCP)                                          |
| **文件打开/关闭**           | ✅                    | ✅                    | ✅（同步包装器）                                   |
| **Stat**                    | ✅ (statx)            | ✅ (struct stat)      | ✅ (\_\_yo_win_stat_t + FILETIME 100ns 精度)       |
| **fstat（按描述符）**       | ✅ (statx + `AT_EMPTY_PATH`) | ✅ (`fstat`)   | ✅ (`_fstat64` + GetFileInformationByHandle)       |
| **mkdir/unlink/rename**     | ✅                    | ✅（同步包装器）      | ✅（同步包装器）                                   |
| **symlink/link**            | ✅                    | ✅（同步包装器）      | ✅ (CreateSymbolicLinkW/CreateHardLinkW)           |
| **fsync/fdatasync**         | ✅                    | ✅（同步包装器）      | ✅ (`_commit`)                                     |
| **ftruncate**               | ✅                    | ✅（同步包装器）      | ✅ (`_chsize_s`)                                   |
| **chmod/chown**             | ✅（同步）            | ✅（同步）            | ✅（同步；仅 chmod；chown 对 -1/-1 返回 0）        |
| **readlink**                | ✅（同步）            | ✅（同步）            | ✅ (同步，FSCTL_GET_REPARSE_POINT)                 |
| **dup/dup2/pipe**           | ✅（同步）            | ✅（同步）            | ✅（同步）                                         |
| **Socket 操作**             | ✅                    | ✅（kqueue 就绪通知） | ✅ (IOCP WSASend/WSARecv)                          |
| **定时器 (sleep)**          | ✅（每线程定时器堆，限定 io_uring/epoll 的等待） | ✅ (EVFILT_TIMER)     | ✅（IOCP 等待超时）                                |
| **getdents/readdir**        | ✅ (getdents64)       | ✅（readdir 模拟）    | ✅ (FindFirstFileW/FindNextFileW)                  |
| **access/realpath**         | ✅（同步）            | ✅（同步）            | ✅（同步）                                         |
| **utime**                   | ✅（同步）            | ✅（同步）            | ✅（同步，FILE_WRITE_ATTRIBUTES 重新打开）         |
| **mkdtemp/mkstemp**         | ✅（同步）            | ✅（同步）            | ✅（同步）                                         |
| **copyfile/sendfile**       | ✅（同步）            | ✅（同步）            | ✅ (CopyFileW；sendfile 通过 read/write 实现)      |
| **statfs**                  | ✅（同步）            | ✅（同步）            | ✅ (GetDiskFreeSpaceEx)                            |
| **DNS**                     | ✅（同步）            | ✅（同步）            | ✅（同步，WSAStartup 自动初始化）                  |
| **信号**                    | ✅（同步）            | ✅（同步）            | ✅（本地处理器 + kill(pid=0) + kill(pid,SIGKILL)） |
| **TTY**                     | ✅（同步）            | ✅（同步）            | ✅ (Console API, GetConsoleScreenBufferInfo)       |
| **Unix socket**             | ✅ (sockaddr_un)      | ✅ (sockaddr_un)      | ✅ (AF_UNIX Win10 1803+)                           |
| **进程 spawn**              | ✅ (posix_spawn)      | ✅ (posix_spawn)      | ✅ (CreateProcessW)                                |
| **fcntl**                   | ✅（同步）            | ✅（同步）            | ✅（尽力抽象）                                     |
| **mmap**                    | ✅（同步）            | ✅（同步）            | ✅ (CreateFileMapping/MapViewOfFile)               |
| **flock**                   | ✅（同步）            | ✅（同步）            | ✅ (LockFileEx/UnlockFileEx)                       |
| **FS 事件**                 | ✅ (inotify)          | ✅ (kqueue+快照)      | ✅ (ReadDirectoryChangesW)                         |
| **Poll**                    | ✅ (poll)             | ✅ (poll)             | ✅ (select/PeekNamedPipe)                          |
| **lseek**                   | ✅（同步）            | ✅（同步）            | ✅ (`_lseeki64`)                                   |
| **getsockname/getpeername** | ✅（同步）            | ✅（同步）            | ✅（同步，Winsock）                                |
| **socketpair**              | ✅（同步）            | ✅（同步）            | ✅（回环模拟）                                     |
| **clock_gettime**           | ✅（同步）            | ✅（同步）            | ✅（实时 FILETIME + 单调 QPC）                     |
| **uname/gethostname**       | ✅（同步）            | ✅（同步）            | ✅（Winsock gethostname + uname 模拟）             |
| **umask**                   | ✅（同步）            | ✅（同步）            | ✅（自定义模拟——CRT `_umask` 存在缺陷）            |
| **readv/writev**            | ✅（同步）            | ✅（同步）            | ✅ (Win32 ReadFile/WriteFile + WSA 用于 socket)    |
| **fallocate**               | ✅（同步）            | ✅（同步）            | ✅ (FileAllocationInfo)                            |
| **fadvise/madvise**         | ✅（同步）            | ✅（同步）            | ✅（fadvise 无操作 + MADV_DONTNEED 尽力实现）      |

---

## 架构

### 带异步 I/O 的事件循环

```
┌────────────────────────────────────────────────────────────────┐
│                    事件循环（主线程）                           │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                      就绪队列                           │   │
│  │  ┌─────┐ ┌─────┐ ┌─────┐                               │   │
│  │  │任务1│ │任务2│ │任务3│  ...                          │   │
│  │  └─────┘ └─────┘ └─────┘                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                      │
│                         ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              取出下一个就绪任务                          │   │
│  │    - 运行直到 await                                     │   │
│  │    - 若为 I/O await，提交到平台后端                      │   │
│  │    - 若已就绪，继续执行                                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                      │
│                         ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              I/O 完成检查（非阻塞轮询）                  │   │
│  │    - 提取结果（读写字节数、错误）                        │   │
│  │    - 唤醒等待中的状态机                                  │   │
│  │    - 加入就绪队列                                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                      │
│                         ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │    若无就绪任务但有待处理 I/O，阻塞在后端上              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 平台抽象层

```c
// 初始化平台后端（事件循环启动时调用一次）
void __yo_io_init(void);
void __yo_io_cleanup(void);

// 检查待处理 I/O
bool __yo_has_pending_io(void);

// 轮询/等待完成
int __yo_io_poll(void);   // 非阻塞，返回完成数量
int __yo_io_wait(void);   // 阻塞，等待至少一个完成
```

### Linux：io_uring

io_uring 是 Linux 的现代异步 I/O 接口（内核 5.1 引入；本运行时的版本下限见下表）：

- **提交队列 (SQ)**：用于提交 I/O 请求的环形缓冲区
- **完成队列 (CQ)**：用于已完成 I/O 结果的环形缓冲区
- **零拷贝**：用户空间与内核之间的共享内存
- **批处理**：每次系统调用可提交多个 I/O 操作
- **真正异步**：由内核执行 I/O，而非仅通知

**无库依赖**：环形层（setup/mmap、提交、完成、SQE prep 辅助函数）以内嵌方式生成到 C 代码中，使用 `__yo_uring_*` 命名空间（`plans/reference/DROP_LIBURING.md`）。编译出的程序只链接 libc——无需安装任何东西，是否存在 io_uring 由内核而非构建机器决定。

**内核版本要求：**

| 内核版本            | 功能                                                                |
| ------------------- | ------------------------------------------------------------------- |
| **5.6+**           | 核心操作集：read/write、openat/close/statx/fsync、socket（accept/connect/send/recv/sendmsg/recvmsg） |
| **5.11+**          | `renameat` / `unlinkat`（重命名、删除文件或目录）                    |
| **5.15+**          | `mkdirat` / `symlinkat` / `linkat`（创建目录、符号链接、硬链接）      |
| **5.19 / 6.0 / 6.1** | `COOP_TASKRUN` / `SINGLE_ISSUER` / `DEFER_TASKRUN` 设置标志——一并请求，内核拒绝时自动降级重试 |
| **6.14+**          | 异步 `ftruncate`（更早的内核通过 future 返回 `-EINVAL`）              |

若内核支持 io_uring 但早于某项操作所在行的版本，运行时会像 epoll 回退那样同步完成该操作。它在建立环形队列时向内核查询一次支持哪些操作码（`IORING_REGISTER_PROBE`），因此该操作仍然可用，而不会以 `-EINVAL` 失败。若 io_uring 完全无法初始化（Docker 默认 seccomp 配置、gVisor、加固内核等），运行时改用 epoll 回退，名称类操作以同步方式完成（见 `docs/zh-CN/ASYNC_AWAIT.md` 中的后端阶梯）。

### macOS：kqueue

macOS 使用 `kqueue` 进行异步 I/O——一种单线程、拉取式的事件通知机制。

对于**文件 I/O**，macOS 对常规文件使用同步 `pread`/`pwrite`（得益于统一缓冲区缓存，在 macOS 上速度很快）。`pread` 返回 `ESPIPE`（pipe、socket、FIFO）或 `ENXIO`（TTY）时，操作改用带 `EVFILT_READ`/`EVFILT_WRITE` 就绪通知的非阻塞 I/O；以 `O_APPEND` 打开的描述符写在文件末尾（macOS 的 `pwrite` 会遵循给定的偏移）。

对于 **socket I/O**，运行时创建的每个 socket 都设置为 `O_NONBLOCK`：

- 每次 `accept`/`recv`/`recvfrom`/`send`/`sendto` 首先尝试非阻塞调用（`MSG_DONTWAIT`），除非同一描述符上仍有更早的同方向操作在挂起；返回 `EAGAIN`/`EWOULDBLOCK` 时挂起在该描述符的注册上
- 每个描述符每个方向一个 `EV_DISPATCH` knote，每次挂起时重新启用（`EV_ADD|EV_ENABLE`，随事件循环的下一次 `kevent()` 一并提交）；挂起的操作按方向排成 FIFO，通过按 fd 索引的槽位表以 `(ident, filter)` 查找；`connect` 完成后检查 `SO_ERROR`
- 中止任务会取消其挂起的操作（`-ECANCELED`）；关闭描述符或对其执行 `dup2` 会让其上挂起的操作以 `-EBADF` 失败
- 所有完成事件通过 `kevent()` 在事件循环线程上收集——无需跨线程同步

**定时器**：每线程定时器堆；事件循环阻塞的 `kevent()` 以最早的截止时间为界，因此设置与取消一次 sleep 都不需要系统调用。

### Windows：IOCP

IOCP 是 Windows 原生的异步 I/O 机制：

- **基于完成**：在 I/O 操作完成时通知
- **真正异步**：由内核执行 I/O 操作
- **重叠 I/O**：使用 OVERLAPPED 结构管理异步状态
- Socket 在创建/accept 时关联到 IOCP
- TCP send/recv 使用带 OVERLAPPED 的 `WSASend`/`WSARecv`
- 文件句柄在打开时通过 `CreateIoCompletionPort` 关联；重复关联会被容忍（第二次调用的 `ERROR_INVALID_PARAMETER` 被忽略）
- Winsock 通过 `__yo_io_init()` 中的 `WSAStartup` 延迟初始化
- Winsock 错误码在每个 socket 错误出口处被翻译成 errno（`__yo_wsa_to_errno`），因此 `IoError.from_errno` 在 Windows 上也能像其他平台一样分类：`WSAEADDRINUSE` 表现为 `AddressInUse`，would-block 表现为 `WouldBlock`，没有 errno 对应项的错误码表现为 `EIO`（2026-10；此前 socket 失败以 `os error 10048` 形式的"unknown I/O error"返回）
- `readlink` 读取重解析点（`FSCTL_GET_REPARSE_POINT`）：符号链接/联接（junction）返回去掉对象管理器前缀的 substitute 名称，非链接抛出 `EINVAL` —— 与 POSIX `readlink` 契约一致（2026-10；旧的 `GetFinalPathNameByHandleW` 垫片返回的是链接自身的路径，且从不抛出）

**头文件冲突保护**：Windows 上每个生成的 C 文件都会输出 `WIN32_LEAN_AND_MEAN` 和 `_WINSOCKAPI_`，以防止 `winsock.h`/`winsock2.h` 重定义错误。

### 状态机集成

任务内的 `io.await(file.read(fd, buf, n, offset, io), io)` 调用该 `Io` 的 `read`
条目；对原生 `Io` 而言，它把操作提交给本线程的后端并返回其 `IoFuture`
（`__yo_io_future_t`，布局与状态机相同：future 前缀加 `result`）。随后 await 读取
future 的 `state`：已经完成的操作（`-1`，macOS 和 Windows 上普通文件的常见情况）
内联继续；否则任务把自己登记为该 future 的续体并返回事件循环，由后端的完成事件唤醒它。

---

## 性能特征

### 内存使用

**10,000 个并发异步 I/O 操作：**

| 资源                         | 开销                             |
| ---------------------------- | -------------------------------- |
| 状态机                       | 10,000 × ~200 字节 = **约 2 MB** |
| io_uring SQE（环形，可复用） | 1024 × 64 字节 = **64 KB**       |
| **合计**                     | **约 2 MB**                      |

对比 10,000 个阻塞线程 × 1 MB 栈空间 = **10 GB** ❌

### 吞吐量

- io_uring 批量提交：减少系统调用次数
- 许多操作零拷贝（Linux）
- 无线程上下文切换（单线程）
- 状态机恢复执行：约 10–50 ns

### 延迟

| 阶段            | 大致开销    |
| --------------- | ----------- |
| io_uring 提交   | ~50–100 ns  |
| io_uring 完成   | ~100–200 ns |
| kqueue kevent() | 有就绪事件时约 200 ns；零超时且什么也没找到时约 12 µs（macOS 26），运行时以约 0.2 µs 的 `select()` 探测避免这种调用 |
| IOCP 完成       | ~100–300 ns |

---

## 已知的 Windows 限制

- **符号链接需要提升权限**：`CreateSymbolicLinkW` 需要管理员权限或开发者模式。`lutime` 符号链接测试在未提升权限时预期会失败。
- **NTFS 纳秒精度为 100 ns**：FILETIME 以 100 纳秒为间隔存储时间。不能被 100 整除的纳秒值会被截断（例如 123456789 ns → 123456700 ns）。
- **UDP sendto/recvfrom 是同步的**：与 TCP send/recv (IOCP) 不同，UDP 使用阻塞的 Winsock 调用（数据报在实践中会立即完成）。

---

## 参考资料

### Linux (io_uring)

- [io_uring 文档](https://kernel.dk/io_uring.pdf)
- [liburing](https://github.com/axboe/liburing)
- [io_uring man pages](https://man7.org/linux/man-pages/man7/io_uring.7.html)

### macOS (kqueue)

- [kqueue(2) man page](https://www.freebsd.org/cgi/man.cgi?query=kqueue&sektion=2)
- [Apple kqueue 文档](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kqueue.2.html)

### Windows (IOCP)

- [I/O 完成端口 (MSDN)](https://learn.microsoft.com/en-us/windows/win32/fileio/i-o-completion-ports)
- [Winsock 2 参考](https://learn.microsoft.com/en-us/windows/win32/winsock/winsock-reference)
