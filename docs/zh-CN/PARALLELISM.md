# 并行性 - Yo 的多线程执行

## 设计理念

Yo 提供两种并行执行机制：

1. **Thread** - 专用操作系统线程（对 pthread 的封装）
2. **Worker** - 在具有线程亲和性的线程池上运行的任务

线程间通信通过 **Channel**（`std/sync/channel.yo`）完成——一个有界的多生产者多消费者队列，支持阻塞式发送/接收。

这类似于：

- **Go**：goroutine（Worker）+ channel
- **Rust**：std::thread（Thread）+ mpsc channel
- **Java**：Thread + ExecutorService（Worker）+ BlockingQueue

**核心思想**：通过将执行（Thread/Worker）与通信（Channel）分离，我们获得了更简洁、更灵活的设计。

## 并发与并行

| 概念     | 机制              | 描述                         |
| -------- | ----------------- | ---------------------------- |
| **并发** | `async/await`     | 多个任务在同一线程上交替执行 |
| **并行** | `Thread`/`Worker` | 多个任务在不同线程上同时执行 |

详见 `ASYNC_AWAIT.md` 了解单线程并发。

## 每线程事件循环

每个操作系统线程（包括 Thread 和 Worker）都拥有自己的异步事件循环：

- **Linux**：每线程独立的 `io_uring` 实例
- **macOS**：每线程独立的 `kqueue` 描述符
- **Windows**：每线程独立的 IOCP 句柄
- **WASM**：不适用——WASM 是单线程的；不支持并行（`Thread.spawn`、Worker）。请改用 `io.async`/`io.await` 进行协作式并发。

这意味着派生的线程和 Worker 任务可以通过 `io.async`/`io.await` 执行异步 I/O，且无需竞争——每个线程的事件循环完全独立。

运行时会在线程启动时自动初始化事件循环（`__yo_async_scheduler_init()`），并在闭包执行完成后排空待处理的任务（`__yo_async_wait_all()`）。I/O 后端状态为 `_Thread_local`，因此不需要同步。

## Thread - 专用操作系统线程

`Thread` 是对操作系统线程的简单封装（Unix 上为 pthread，Windows 上为 Windows 线程）。

### API

```rust
Thread :: struct(
  handle : __yo_thread_t
);
impl(Thread,
  // 派生一个新的操作系统线程，运行给定的闭包。
  // 该闭包会获得自己的每线程 Io 事件循环。
  spawn : (fn(cb : Impl(Fn(io : Io) -> unit, Send)) -> Self),

  // 等待线程完成（阻塞）
  join : (fn(inout(self) : Self) -> unit)
);
```

### 用法

```rust
{ Thread } :: import "std/thread";
{ yield } :: import "std/async";

// 派生一个专用线程（不使用异步）
thread := Thread.spawn((io) => {
  printf("Hello from thread\n");
});
thread.join();

// 派生一个支持异步 I/O 的线程
thread := Thread.spawn((io : Io) => {
  task := io.async((io : Io) => {
    io.await(yield());
    return i32(42);
  });
  result := io.await(task);
  assert(result == i32(42), "async result");
});
thread.join();
```

### 何时使用 Thread

- 长时间运行的后台任务
- 需要专用操作系统线程的任务（例如阻塞式 I/O）
- UI 应用程序（主线程 + 工作线程）
- 需要显式控制线程生命周期时

## Worker - 线程池任务

`Worker` 在具有**线程亲和性**的**线程池**上派生任务。每个任务固定在分配的操作系统线程上执行（无工作窃取）。

### API

```rust
Worker :: import "std/worker";

// 在线程池上派生一个任务
Worker.spawn : (fn(cb : Impl(Fn(io : Io) -> unit, Send)) -> unit);

// 配置线程池大小（需在首次 spawn 之前调用）
Worker.set_num_threads : (fn(num : usize) -> unit);

// 获取线程池中的线程数（默认值：硬件线程数）
Worker.get_num_threads : (fn() -> usize);
```

### 用法

```rust
Worker :: import "std/worker";
{ yield } :: import "std/async";

// 在线程池上运行简单任务
Worker.set_num_threads(4);
Worker.spawn(() => {
  do_work();
});

// 在线程池上运行异步任务
Worker.spawn((io : Io) => {
  task := io.async((io : Io) => {
    io.await(yield());
  });
  io.await(task);
});
```

### 线程池设计

```
┌────────────────────────────────────────────────────────────────┐
│                           线程池                                │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ OS 线程 0    │  │ OS 线程 1    │  │ OS 线程 2    │  ...     │
│  │ (CPU 0)      │  │ (CPU 1)      │  │ (CPU 2)      │          │
│  ├──────────────┤  ├──────────────┤  ├──────────────┤          │
│  │ 事件循环     │  │ 事件循环     │  │ 事件循环     │          │
│  │ 任务队列     │  │ 任务队列     │  │ 任务队列     │          │
│  │ [A, D, G]    │  │ [B, E, H]    │  │ [C, F, I]    │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                │
│  - 每核一线程：每个 CPU 核心一个操作系统线程                      │
│  - 线程亲和性：任务固定在分配的线程上                             │
│  - 每线程事件循环：异步 I/O 无竞争                               │
│  - 无工作窃取：行为可预测，缓存友好                               │
└────────────────────────────────────────────────────────────────┘
```

### 何时使用 Worker

- 大量短期任务
- CPU 密集型并行工作
- 不需要等待单个任务完成时
- 任务并行（MapReduce 风格）

## Channel - 线程间通信

Channel（`std/sync/channel.yo`）提供有界的多生产者多消费者线程间通信。

```rust
{ Channel } :: import "std/sync/channel";

// 创建一个有界 Channel（容量为 10）
ch := Channel(i32).new(usize(10));

// 生产者线程
Thread.spawn((io) => {
  ch.send(i32(42));
});

// 消费者线程
Thread.spawn((io) => {
  val := ch.recv();
  cond(
    val.is_some() => printf("Got %d\n", val.unwrap()),
    true => ()
  );
});
```

`Channel` 现在是一个 `atomic(ref(struct(...)))`，因此可以直接跨线程共享，
不再需要额外的 `arc()` 包装。

Channel 内部使用 `Mutex` + `CondVar` 进行同步。当 Channel 满时 send 阻塞；当 Channel 空时 recv 阻塞。

## 可发送类型

只有实现了 `Send` 的类型才能跨越线程边界：

- **可发送**：基本类型（`i32`、`bool` 等）、由 Send 字段组成的值类型结构体
- **不可发送**：`ref(struct(...))`、`ref(enum(...))`、`Dyn`、捕获了非 Send 值的闭包

```rust
// ✅ 可发送
Point :: struct(x: i32, y: i32);
Thread.spawn((io) => {
  p := Point(1, 2);  // OK：在线程内部创建
});

// ❌ 不可发送
Node :: ref(struct(value: i32));
node := Node(42);
Thread.spawn((io) => {
  // 错误：无法捕获 `node`（ref(struct(...)) 不是 Send）
  // node.value;
});
```

## 内存模型

### 线程局部 GC

每个操作系统线程拥有：

- **独立堆**：GC 管理的内存分配是线程局部的
- **非原子引用计数**：引用计数使用非原子操作
- **线程局部循环收集器**：GC 在每个线程上独立运行
- **线程局部事件循环**：I/O 状态为 `_Thread_local`

这意味着：

- GC 管理的值不会产生数据竞争（它们无法被共享）
- 引用计数无原子操作开销
- 没有全局停顿（stop-the-world）的 GC 暂停
- 异步 I/O 无竞争

## 对比：Thread 与 Worker

| 方面       | Thread             | Worker                 |
| ---------- | ------------------ | ---------------------- |
| OS 线程    | 专用（1:1）        | 共享（线程池）         |
| 生命周期   | 显式管理（join）   | 即发即忘               |
| 开销       | 较高（需创建线程） | 较低（复用线程）       |
| 适用场景   | 长时间运行的任务   | 短期任务               |
| 线程亲和性 | 不适用             | 是（任务固定在线程上） |
| 异步 I/O   | 拥有独立事件循环   | 共享每线程事件循环     |

## 总结

| 组件        | 用途             | API                   |
| ----------- | ---------------- | --------------------- |
| **Thread**  | 专用操作系统线程 | `spawn`、`join`       |
| **Worker**  | 线程池任务       | `spawn`               |
| **Channel** | 阻塞式通信       | `new`、`send`、`recv` |

### 快速参考

```rust
{ Thread } :: import "std/thread";
Worker :: import "std/worker";
{ Channel } :: import "std/sync/channel";

// 带异步 I/O 的专用线程
thread := Thread.spawn((io : Io) => {
  // 此线程拥有自己的事件循环
  task := io.async((io : Io) => { io.await(yield()); });
  io.await(task);
});
thread.join();

// 线程池任务
Worker.spawn(() => { /* 工作 */ });

// 通信
ch := Channel(i32).new(usize(10));
ch.send(i32(42));
val := ch.recv();
```

### 核心原则

1. **关注点分离** - Thread/Worker = 执行，Channel = 通信
2. **Send trait** - 只有 Send 类型可以跨越线程边界
3. **线程局部 GC** - 无跨线程 GC 协调
4. **非原子引用计数** - 线程局部对象无原子操作开销
5. **线程亲和性** - Worker 任务固定在分配的操作系统线程上
6. **每线程事件循环** - 每个线程拥有独立的异步 I/O
