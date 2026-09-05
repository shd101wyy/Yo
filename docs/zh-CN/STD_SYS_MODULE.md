# std/sys 模块

## 设计理念

Yo 将平台原生的异步 I/O API 与单线程 async/await 事件循环集成：

| 平台        | 后端     | 状态      | 描述                                                                       |
| ----------- | -------- | --------- | -------------------------------------------------------------------------- |
| **Linux**   | io_uring | ✅ 已完成 | 内核执行 I/O 操作的真正异步 I/O（内核 5.1+）                               |
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
├── externs.yo      — 所有 C extern 函数声明
├── fallocate.yo    — fallocate（预分配文件空间）
├── fcntl.yo        — getfl/setfl/getfd/setfd（文件描述符标志）
├── file.yo         — 异步 + 同步文件操作（openat、read、write、stat、fsync 等）
├── future.yo       — IoFuture extern 类型，包装 __yo_io_future_t
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

```rust
file   :: import "std/sys/file";
dir    :: import "std/sys/dir";
tcp    :: import "std/sys/tcp";
timer  :: import "std/sys/timer";
```

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
| IoFuture    | `future.yo`     | ✅ 已完成 | 包装 `__yo_io_future_t` 的 extern 类型                   |
| Externs     | `externs.yo`    | ✅ 已完成 | 所有 C extern 函数声明                                   |
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
| `runtime_core.yo`       | 核心调度器：continuation 队列、spawn、wait、并发辅助函数                   |
| `runtime_io_linux.yo`   | Linux io_uring 异步 I/O                                                    |
| `runtime_io_macos.yo`   | macOS kqueue 异步 I/O（socket/pipe 非阻塞，常规文件同步 pread/pwrite）     |
| `runtime_io_windows.yo` | Windows IOCP 异步 I/O                                                      |
| `runtime_io_common.yo`  | 跨平台：stat 辅助函数、定时器、文件扩展功能、DNS、信号、TTY、FS 事件、poll |

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
| **readlink**                | ✅（同步）            | ✅（同步）            | ✅ (GetFinalPathNameByHandleW)                     |
| **dup/dup2/pipe**           | ✅（同步）            | ✅（同步）            | ✅（同步）                                         |
| **Socket 操作**             | ✅                    | ✅（kqueue 就绪通知） | ✅ (IOCP WSASend/WSARecv)                          |
| **定时器 (sleep)**          | ✅ (timerfd+io_uring) | ✅ (EVFILT_TIMER)     | ✅（IOCP 等待超时）                                |
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

io_uring 是 Linux 的现代异步 I/O 接口（内核 5.1+）：

- **提交队列 (SQ)**：用于提交 I/O 请求的环形缓冲区
- **完成队列 (CQ)**：用于已完成 I/O 结果的环形缓冲区
- **零拷贝**：用户空间与内核之间的共享内存
- **批处理**：每次系统调用可提交多个 I/O 操作
- **真正异步**：由内核执行 I/O，而非仅通知

**liburing 依赖**：Yo 使用 liburing（由 Jens Axboe 维护的约 5KB 轻量封装）而非原始 io_uring 系统调用。通过包管理器安装：

```bash
# Arch Linux / Manjaro
sudo pacman -S liburing

# Ubuntu / Debian
sudo apt-get install liburing-dev

# Fedora / RHEL
sudo dnf install liburing-devel
```

Yo 编译器通过 `pkg-config liburing --cflags --libs` 检测 liburing。在 Linux 上使用异步 I/O 时需链接 `-luring`。

**内核版本要求：**

| 内核版本  | 功能                                |
| --------- | ----------------------------------- |
| **5.1+**  | 基本 io_uring（read、write、fsync） |
| **5.6+**  | 注册缓冲区、链式操作                |
| **5.11+** | 更好的性能、更多操作                |

### macOS：kqueue

macOS 使用 `kqueue` 进行异步 I/O——一种单线程、拉取式的事件通知机制。

对于**文件 I/O**，macOS 对常规文件使用同步 `pread`/`pwrite`（得益于统一缓冲区缓存，在 macOS 上速度很快）。对于 pipe、socket 和 TTY，使用 `EVFILT_READ`/`EVFILT_WRITE` 就绪通知的非阻塞 I/O。

对于 **socket I/O**，所有 socket 都设置为 `O_NONBLOCK`：

- 每次 `accept`/`recv`/`recvfrom` 首先尝试非阻塞调用；如果返回 `EAGAIN`/`EWOULDBLOCK`，则注册带有 `EV_ONESHOT` 的 `EVFILT_READ` kevent
- `connect`/`send`/`sendto` 使用带有 `EV_ONESHOT` 的 `EVFILT_WRITE`；连接完成后检查 `SO_ERROR`
- 所有完成事件通过 `kevent()` 在事件循环线程上收集——无需跨线程同步

**定时器**：`EVFILT_TIMER` 配合 `EV_ONESHOT` 和 `NOTE_USECONDS` 提供一次性定时器触发。

### Windows：IOCP

IOCP 是 Windows 原生的异步 I/O 机制：

- **基于完成**：在 I/O 操作完成时通知
- **真正异步**：由内核执行 I/O 操作
- **重叠 I/O**：使用 OVERLAPPED 结构管理异步状态
- Socket 在创建/accept 时关联到 IOCP
- TCP send/recv 使用带 OVERLAPPED 的 `WSASend`/`WSARecv`
- 文件句柄在打开时通过 `CreateIoCompletionPort` 关联；重复关联会被容忍（第二次调用的 `ERROR_INVALID_PARAMETER` 被忽略）
- Winsock 通过 `__yo_io_init()` 中的 `WSAStartup` 延迟初始化

**头文件冲突保护**：Windows 上每个生成的 C 文件都会输出 `WIN32_LEAN_AND_MEAN` 和 `_WINSOCKAPI_`，以防止 `winsock.h`/`winsock2.h` 重定义错误。

### 状态机集成

当代码生成遇到 `await __yo_async_read(...)` 时，生成的 C 状态机如下：

```c
case STATE_AWAIT_READ:
  // 首次进入：提交 I/O 并挂起
  if (!sm->io_state.completed) {
    sm->io_state.state_machine = sm;
    sm->io_state.resume_fn = (void(*)(void*))this_resume_fn;
    sm->io_state.completed = false;

    __yo_async_read_start(sm->fd, sm->buffer, sm->size, sm->offset, &sm->io_state);

    // 挂起——暂不加入就绪队列
    // 平台后端完成后会唤醒我们
    return;
  }

  // I/O 完成后恢复执行
  sm->result = sm->io_state.result;
  sm->io_state.completed = false;
  sm->state = STATE_NEXT;
  // 继续执行下一个状态...
```

---

## 性能特征

### 内存使用

**10,000 个并发异步 I/O 操作：**

| 资源                         | 开销                             |
| ---------------------------- | -------------------------------- |
| 状态机                       | 10,000 × ~200 字节 = **约 2 MB** |
| io_uring SQE（环形，可复用） | 256 × 64 字节 = **16 KB**        |
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
| kqueue kevent() | ~200–500 ns |
| IOCP 完成       | ~100–300 ns |

---

## 已知的 Windows 限制

- **符号链接需要提升权限**：`CreateSymbolicLinkW` 需要管理员权限或开发者模式。`lutime` 符号链接测试在未提升权限时预期会失败。
- **NTFS 纳秒精度为 100 ns**：FILETIME 以 100 纳秒为间隔存储时间。不能被 100 整除的纳秒值会被截断（例如 123456789 ns → 123456700 ns）。
- **UDP sendto/recvfrom 是同步的**：与 TCP send/recv (IOCP) 不同，UDP 使用阻塞的 Winsock 调用（数据报在实践中会立即完成）。

---

## 已修复的已知问题

- **errno 命名冲突**：枚举变体解构（`.Other(errno)`）现在会在 C 代码生成中对变量名进行清洁化处理，以避免与 C 的 `errno` 宏冲突。
- **定时器资源泄漏（Linux）**：timerfd 和读取缓冲区现在通过扩展 future 结构上的 `dispose_fn` 被正确跟踪和清理。
- **c_include 常量上的位或运算**：`c_include` 常量（O_WRONLY、O_CREAT 等）持有 `UnknownValue`，导致选择了 `ComptimeBitOr`。在 `identifer-and-operator.ts` 中修复，将 extern "c" unknown 视为运行时值。
- **导入命名空间常量的 C 代码生成访问**：像 `fcntl_io.O_NONBLOCK` 这样的表达式生成了无效的 C 代码（`/* skip generating: namespace */.FIELD`），因为导入的编译期命名空间值不会作为运行时表达式生成。在 `src/codegen/exprs/property-access.ts` 中修复。
- **移除了 barrel 重导出**：`std/sys/index.yo` 已移除以避免命名冲突。用户直接导入子模块。
- **异步循环中 SSA 变量突变**：循环内的变量重赋值创建了新的 SSA 变量 ID（例如 `offset` → `offset_1`），但循环条件始终读取原始 ID，导致无限循环。通过在 await 分析中添加 `variableIdRemapping` 修复。同时修复了异步 while 循环中 `break` 跳出 C `switch` 而非循环的问题。
- **macOS 异步 continuation 线程模型**：从 GCD 迁移到 kqueue。所有 I/O 完成事件现在都在事件循环线程上处理——不再需要跨线程 continuation 队列。
- **macOS getdents 链接器修复**：将不可用的 `getdirentries` 替换为基于 `readdir` 的模拟，使用 `dup(fd)` + `fdopendir` 以避免 arm64 上的 64 位 inode 存根符号。
- **Windows 测试运行器缺少 ws2_32**：测试运行器在 Windows 上未链接 `-lws2_32`。在 `src/test-runner.ts` 中修复。
- **Windows tty 测试的 unistd 头文件**：`tests/io/tty.test.yo` 无条件导入了 `std/libc/unistd`，在 Windows 上包含了 `<unistd.h>`。修复为将导入移到非 Windows 分支中。
- **Windows 临时目录打开需要 `O_DIRECTORY`**：`openat` 仅在设置了 `O_DIRECTORY` 时才启用 `FILE_FLAG_BACKUP_SEMANTICS`（目录所需）。修复 `tests/io/temp.test.yo` 使用 `(O_RDONLY | O_DIRECTORY)` 打开 mkdtemp 结果。
- **Windows 信号支持**：将存根替换为处理器注册和本地信号传递。`kill(pid=0, signum)` 传递到当前进程；`kill(pid, 0)` 探测进程是否存在；`kill(pid, SIGKILL)` 使用 `OpenProcess(PROCESS_TERMINATE)`。
- **Windows AT_FDCWD**：在 Windows IOCP 运行时中添加了 `#ifndef AT_FDCWD / #define AT_FDCWD -100 / #endif`。
- **Windows IOCP 重复句柄关联**：`__yo_win_associate_handle` 现在容忍已关联的句柄（`ERROR_INVALID_PARAMETER` → 返回 true）。
- **Windows winsock 头文件冲突**：每个 Windows 生成的 C 文件顶部都输出 `WIN32_LEAN_AND_MEAN` 和 `_WINSOCKAPI_`。
- **Windows 文件测试路径**：将硬编码的 `/tmp/` 替换为跨平台的 `temp_dir()` + `path_join()`。
- **编译期常量 C 宏名冲突**：仅在编译期使用的常量（例如 `AF_INET`）作为函数参数传递时创建了与头文件宏冲突的本地 C 变量。在 `src/codegen/exprs/other-fn-call.ts` 中通过直接内联字面量修复。
- **指针到可空指针的代码生成错误**：`*(?*(T))` 生成了 `uint8_t*` 而非 `uint8_t**`。在 `src/codegen/utils/index.ts` 的 `getTypeString()` 中修复。
- **异步状态机悬空重赋值临时变量**：begin 块内的重赋值输出了未声明的临时变量引用。在 `src/codegen/exprs/assignment.ts` 中修复，当 `skippedTempVar` 为 true 时返回 `""`。
- **macOS socket 操作异步化**：`accept`、`connect`、`send`、`recv`、`sendto`、`recvfrom` 使用 kqueue `EVFILT_READ`/`EVFILT_WRITE` 配合 `EV_ONESHOT` 进行就绪通知。
- **macOS getnameinfo NI_NUMERICHOST 值错误**：在 `std/sys/socket.yo` 中添加了平台感知的 `NI__*` 常量。
- **编译期常量未在异步状态机中内联**：两个错误：(1) atom.ts 状态机变量查找回退未检查 `isCompileTimeOnly`；(2) 内联的字面量被错误地通过 `sanitizeForCIdentifier` 清洁化。均已修复。
- **Windows socket 关闭使用了 `_close()` 而非 `closesocket()`**：在 `__yo_async_close_start` 中修复。
- **Windows socket 常量使用了 Linux 值**：为所有平台感知的 socket 常量条件添加了 `Platform.Win32` 分支。
- **Windows `__yo_sockaddr_in_set_addr` 中重复 `htonl`**：移除了多余的 `htonl` 调用（Yo 代码在传递给 extern 之前已进行字节序转换）。
- **Windows TCP send/recv 现在真正异步**：使用通过 IOCP 的 `WSASend`/`WSARecv` 配合 OVERLAPPED I/O。
- **Windows DNS `WSANOTINITIALISED`**：`__yo_async_getaddrinfo_start` 和 `__yo_async_getnameinfo_start` 现在提前调用 `__yo_io_init()`。
- **Windows `_waccess` 不支持 `X_OK`**：在调用 `_waccess` 之前剥离 X_OK（Windows 没有可执行位）。
- **Windows `fchown(-1,-1)` 返回 `-ENOSYS`**：现在对无变更的哨兵值返回 0。
- **Windows `futime` 在只读 fd 上失败**：现在通过 `GetFinalPathNameByHandleW` 以 `FILE_WRITE_ATTRIBUTES` 重新打开文件路径。
- **Windows statx 纳秒时间戳始终为 0**：引入了 `__yo_win_stat_t`，其 nsec 字段来自 `GetFileAttributesExW`（100 ns FILETIME 精度，包括创建时间）。
- **Windows Win32 错误码未映射到 POSIX errno**：在 `__yo_win_last_error_to_errno` 中添加了正确的映射（例如 `ERROR_FILE_NOT_FOUND` → `ENOENT`）。
- **macOS 上 path 测试的规范化问题（`/tmp` vs `/private/tmp`）**：`tests/io/path.test.yo` 现在将 `realpath(input)` 与 `realpath(expected_target)` 进行比较。
- **macOS FS 事件目录修改/删除检测**：在 kqueue 标志之外添加了基于快照的差异比较用于目录监视，对内容更新报告 `FS_EVENT_CHANGE`，对创建/删除报告 `FS_EVENT_RENAME`。
- **macOS 上 `flock` EWOULDBLOCK errno**：macOS 上 `EWOULDBLOCK` 为 35，Linux 上为 11。更新 `tests/io/lock.test.yo` 使用平台感知的预期 errno。
- **Windows 目录扫描**：将 `-ENOSYS` 存根替换为 `opendir`/`readdir`/`closedir`/`scandir` 中的 `FindFirstFileW`/`FindNextFileW`。
- **Windows TTY 操作**：将 `-ENOSYS` 存根替换为 Console API（`SetConsoleMode`、`GetConsoleScreenBufferInfo`、`ENABLE_VIRTUAL_TERMINAL_INPUT`）。
- **Windows FS 事件操作**：将 `-ENOSYS` 存根替换为 `ReadDirectoryChangesW`（目录）和 `FindFirstChangeNotificationW`（文件），在 `__yo_io_poll`/`__yo_io_wait` 中轮询。
- **Windows poll 操作**：将 `-ENOSYS` 存根替换为 socket 的 `select()` 和 pipe 的 `PeekNamedPipe`/`WaitForSingleObject`。`__yo_poll_and_fs_event_tick` 从 `__yo_io_poll`（非阻塞）和 `__yo_io_wait`（有活跃监视时上限 50 ms）调用。

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
