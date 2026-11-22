# 并行性 - Yo 的多线程执行

## 设计理念

Yo 提供两种并行执行机制：

1. **Thread** - 专用操作系统线程（对 pthread 的封装）
2. **ThreadPool** - 拥有自己工作线程的线程池；任务在一个共享队列中等待，`spawn_on` 把任务固定到某个工作线程

线程间通信通过 **Channel**（`std/sync/channel.yo`）完成——一个有界的多生产者多消费者队列，支持阻塞式发送/接收。

这类似于：

- **Go**：goroutine（ThreadPool）+ channel
- **Rust**：std::thread（Thread）+ mpsc channel
- **Java**：Thread + ExecutorService（ThreadPool）+ BlockingQueue

**核心思想**：通过将执行（Thread/ThreadPool）与通信（Channel）分离，我们获得了更简洁、更灵活的设计。

## 并发与并行

| 概念     | 机制              | 描述                         |
| -------- | ----------------- | ---------------------------- |
| **并发** | `async/await`     | 多个任务在同一线程上交替执行 |
| **并行** | `Thread`/`ThreadPool` | 多个任务在不同线程上同时执行 |

详见 `ASYNC_AWAIT.md` 了解单线程并发。

## 每线程事件循环

每个操作系统线程（包括 Thread 和 ThreadPool 的工作线程）都拥有自己的异步事件循环：

- **Linux**：每线程独立的 `io_uring` 实例
- **macOS**：每线程独立的 `kqueue` 描述符
- **Windows**：每线程独立的 IOCP 句柄
- **WASM**：不适用——WASM 是单线程的；不支持并行（`Thread(T).spawn`、线程池）。请改用 `io.async`/`io.await` 进行协作式并发。

这意味着派生的线程和线程池任务可以通过 `io.async`/`io.await` 执行异步 I/O，且无需竞争——每个线程的事件循环完全独立。

运行时会在线程启动时自动初始化事件循环（`__yo_async_scheduler_init()`），并在闭包执行完成后排空待处理的任务（`__yo_async_wait_all()`）。I/O 后端状态为 `_Thread_local`，因此不需要同步。

## Thread - 专用操作系统线程

`Thread` 是对操作系统线程的简单封装（Unix 上为 pthread，Windows 上为 Windows 线程）。

### API

```yo
// `T` 是线程体产出的类型。`Thread(unit)` 即无返回值的线程；
// 任何满足 `Send` 的类型都可以被带出线程。
Thread :: (
  fn(comptime(T) : Type, where(T <: Send)) -> comptime(Type)
)(struct(_cell : Box(_ThreadState(T))));
impl(
  generic(T : Type),
  Thread(T),
  where(T <: Send),
  // 派生一个新的操作系统线程，运行给定的闭包。
  // 该闭包会获得自己的每线程 Io 事件循环。
  spawn : (fn(sink(cb) : Impl(FnOnce(io : Io) -> T, Send)) -> Self),
  // 等待线程完成（阻塞），并取回它的结果。第二次调用会 panic。
  join : (fn(self : &Self) -> T),
  is_joined : (fn(self : &Self) -> bool)
);
```

线程体只运行一次，所以 `spawn` 以 `FnOnce` 接收并拥有它（`sink(cb)`）。带捕获列表的闭包
（`{ t }(io : Io) => ...`）可以把捕获的值移出，而不必克隆，例如交给一个 `sink` 参数，或通过
Channel 发送（该值必须是 `Send`）。没有移出的捕获值在线程体返回时被释放。普通闭包同样可以传入，因为 `Fn` 蕴含 `FnOnce`。

```yo
Job :: struct(id : i32);
run :: (fn(sink(j) : Job) -> i32)(j.id);
job := Job(id : i32(7));
t := Thread(i32).spawn({ job }(io : Io) => run(job)); // job 移入线程，无需克隆
n := t.join(); // 7
```

`Thread` 是只能移动（move-only）的值：它的操作系统句柄、joined 标志和结果通道都放在一个
`Box` 里，因此每个线程恰好只有一个句柄，未 join 就被释放时只会 detach 一次。`t2 := t`
会移动句柄，留下两个所有者的复制是 E0901。用 `&t` 借出，或把它移动到要 join 的地方。由于
`join` 通过 `&Self` 在 box 内标记句柄，`Thread` 是 `Send`，但永远不是 `Sync`。

### 把值带出线程

`join()` 返回线程体的返回值，途径是句柄自己持有的容量为 1 的 `Channel(T)`：

```yo
{ Thread } :: import("std/thread");

t := Thread(i32).spawn((io : Io) => i32(42));
answer := t.join(); // 42
```

`Thread(unit)` 就是下文示例使用的无返回值线程，它的 `join()` 返回 `()`。
`ThreadPool` 的任务仍然不携带返回值——请用 `Channel` 把值传回。

### 用法

```yo
{ Thread } :: import("std/thread");
{ yield } :: import("std/async");

// 派生一个专用线程（不使用异步）
thread := Thread(unit).spawn(io => {
  printf("Hello from thread\n");
});
thread.join();

// 派生一个支持异步 I/O 的线程
thread := Thread(unit).spawn((io : Io) => {
  task := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(42));
  });
  result := io.await(task, io);
  assert(result == i32(42), "async result");
});
thread.join();
```

### 何时使用 Thread

- 长时间运行的后台任务
- 需要专用操作系统线程的任务（例如阻塞式 I/O）
- UI 应用程序（主线程 + 工作线程）
- 需要显式控制线程生命周期时

## ThreadPool - 线程池任务

`ThreadPool` 拥有 `n` 个工作线程：它们由 `new(n)` 创建，在线程池被丢弃或 `shutdown` 时被 join。

每个工作线程都有自己的异步事件循环，因此任务可以在交给它的 `io` 上使用 `io.async`/`io.await`。已开始的任务绝不会移动到另一个线程：`Io` 和 `JoinHandle` 是 `!Send` 的，引用计数是每线程、非原子的。

尚未开始的任务在一个由所有工作线程共享的队列中等待。`spawn(&pool, cb)` 由第一个空闲的工作线程取走，因此慢任务不会推迟排在它后面的任何任务，CPU 密集型工作也会自动均衡。

必须在特定工作线程上运行的任务（因为分片本地状态或每工作线程缓存）通过 `spawn_on(&pool, i, cb)` 显式放置，只有该工作线程会取走它（`pool.worker_count()`、`worker_id()`）。

每个工作线程一次只运行一个任务，并运行到结束，包括该任务派生的异步工作。`join_all` 是该线程池所提交任务的完成计数器。

没有工作窃取，也没有 CPU 亲和性：运行时从不把线程绑定到某个核心，已开始的任务也从不迁移。

### API

```yo
{ ThreadPool, spawn, spawn_on, worker_id } :: import("std/thread");

// 创建一个恰好拥有 num_threads 个工作线程的线程池
ThreadPool.new : (fn(num_threads : usize) -> ThreadPool);

// 创建每个硬件线程一个工作线程的线程池
ThreadPool.with_hardware_threads : (fn() -> ThreadPool);

// 线程池拥有的工作线程数
ThreadPool.worker_count : (fn(self : &ThreadPool) -> usize);

// 把任务交给线程池的共享队列：第一个空闲的工作线程取走它。
// 这是模块级函数，不是方法。
spawn : (fn(pool : &ThreadPool, sink(cb) : Impl(FnOnce(io : Io) -> unit, Send)) -> unit);

// 只把任务交给工作线程 worker（0 <= worker < pool.worker_count()）
spawn_on : (fn(pool : &ThreadPool, worker : usize, sink(cb) : Impl(FnOnce(io : Io) -> unit, Send)) -> unit);

// 正在运行的线程池任务所在的工作线程；在其他线程上为 .None
worker_id : (fn() -> Option(usize));

// 阻塞直到此前提交的所有任务完成；线程池保持开放
ThreadPool.join_all : (fn(self : &ThreadPool) -> unit);

// 拒绝新任务，运行已提交的任务，join 工作线程。可重复调用。
ThreadPool.shutdown : (fn(self : &ThreadPool) -> unit);
ThreadPool.is_shutdown : (fn(self : &ThreadPool) -> bool);

// impl(ThreadPool, Drop(...))：丢弃线程池即 `shutdown`
```

### 用法

```yo
{ ThreadPool, spawn, spawn_on, worker_id } :: import("std/thread");
{ yield } :: import("std/async");

pool := ThreadPool.new(usize(4));

// 在线程池上运行简单任务
spawn(&pool, (io : Io) => {
  do_work();
});

// 在线程池上运行异步任务——每个工作线程都有自己的事件循环
spawn(&pool, (io : Io) => {
  task := io.async((io : Io) => {
    io.await(yield(io), io);
  });
  io.await(task, io);
});

// 每个工作线程一个任务，各自处理自己的分片
(mut(i) : usize) = usize(0);
while(i < pool.worker_count(), {
  spawn_on(&pool, i, (io : Io) => {
    shard := worker_id().unwrap();
    work_on_shard(shard);
  });
  i = (i + usize(1));
});

// 等待此前提交的所有任务
pool.join_all();

// `pool` 在其作用域结束时被丢弃：拒绝新任务，运行已提交的任务，并 join 工作线程。
```

`join_all` 是一个**完成计数器**：`spawn` 把任务计入，任务的包装函数在任务返回后将其计出，因此当通过该线程池提交的所有任务（以及这些任务再提交进同一线程池的任务）都完成时，`join_all` 才返回。请勿在同一线程池的任务内部调用 `join_all`——该任务会等待它自己。

### 共享线程池

`ThreadPool` 是仅可移动（move-only）的值。用 `&pool` 借出，或以 `Arc(ThreadPool)` 在线程和任务之间共享：

```yo
pool := Arc.new(ThreadPool.new(usize(4)));
spawn(&pool.*, { pool : Arc.clone(pool) }(io : Io) => {
  // 向自己所在的线程池提交更多工作的任务
  spawn(&pool.*, (io : Io) => { do_work(); });
});
```

线程池在最后一个所有者丢弃它时关闭。如果这个所有者是线程池自己的某个任务，丢弃无法等待它所在的那个任务：它关闭线程池后返回，工作线程运行完已提交的任务后退出。

保存在模块全局变量中的线程池永远不会被丢弃：它的工作线程一直存活到进程退出，而进程退出时不会等待它们，与分离（detached）的 `Thread` 相同。

### 线程池设计

```
┌───────────────────────────────────────────────────────────────────┐
│                           ThreadPool                              │
│                                                                   │
│  共享队列：[D, E, F, ...]   （由第一个空闲的工作线程取走）        │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ 工作线程 0   │  │ 工作线程 1   │  │ 工作线程 2   │  ...        │
│  ├──────────────┤  ├──────────────┤  ├──────────────┤             │
│  │ 事件循环     │  │ 事件循环     │  │ 事件循环     │             │
│  │ 固定队列     │  │ 固定队列     │  │ 固定队列     │             │
│  │ (spawn_on)   │  │ (spawn_on)   │  │ (spawn_on)   │             │
│  └──────────────┘  └──────────────┘  └──────────────┘             │
│                                                                   │
│  - 恰好 n 个工作线程，归线程池所有，在线程池被丢弃时 join         │
│  - 工作线程先取自己的固定队列，再取共享队列                       │
│  - 每个工作线程一次运行一个任务，直到结束                         │
│  - 无工作窃取，无 CPU 亲和性；已开始的任务从不移动                │
└───────────────────────────────────────────────────────────────────┘
```

### 何时使用 ThreadPool

- 大量短期任务
- CPU 密集型并行工作
- 按批次等待，而不是等待单个任务时
- 任务并行（MapReduce 风格）

## Channel - 线程间通信

Channel（`std/sync/channel.yo`）提供有界的多生产者多消费者线程间通信。

```yo
{ Channel } :: import("std/sync/channel");

// 创建一个有界 Channel（容量为 10）
ch := Channel(i32).new(usize(10));

// 生产者线程：持有自己的队列句柄
tx := ch.clone();
producer := Thread(unit).spawn({ tx }(io : Io) => {
  _ := tx.send(i32(42));
});

// 消费者线程
rx := ch.clone();
consumer := Thread(unit).spawn({ rx }(io : Io) => {
  val := rx.recv();
  cond(
    val.is_some() => printf("Got %d\n", val.unwrap()),
    true => ()
  );
});
producer.join();
consumer.join();
```

`Channel(T)` 是持有队列 `Arc` 的值，当 `T` 是 `Send` 时它是 `Send` 且 `Sync` 的。`ch.clone()` 是同一个
队列上的另一个句柄（不需要额外的 `Arc.new()` 包装），队列随最后一个句柄释放。隐式复制（`ch2 := ch`
之后仍使用 `ch`）是 E0901：为每个需要它的线程克隆一次，并按值捕获这个克隆。

Channel 内部使用 `Mutex` + `CondVar` 进行同步。当 Channel 满时 send 阻塞；当 Channel 空时 recv 阻塞。

### Sender / Receiver - 无需手动 `close()` 的流结束信号

`Channel` 是两端共享的同一个句柄，只有有人调用 `close()` 它才会关闭。当消费者需要知道生产者
**已经结束**时，请改用 `Sender`/`Receiver` 拆分：队列会统计存活的 sender，最后一个被丢弃时
自动关闭 Channel。

```yo
{ Channel } :: import("std/sync/channel");

rx := Channel(i32).receiver(usize(4)); // 队列及其唯一的消费者
{
  tx := rx.sender(); // 一个被计数的生产者
  tx.send(i32(1));
  tx.send(i32(2));
}; // 最后一个 sender 被丢弃 -> Channel 关闭
rx.recv().unwrap(); // 1  - 已缓冲的值先被取出
rx.recv().unwrap(); // 2
rx.recv(); // .Err(TryRecvError.Disconnected)
```

- `Sender` 可克隆（`tx.clone()`）；每个克隆都是又一个被计数的生产者，只有**最后**一个被丢弃时
  才关闭队列。
- 丢弃 `Receiver` 后，之后的每次 `send` 都会失败并把未发送的值交还给调用者，而不是阻塞在一个
  没人消费的队列上。
- `Receiver.recv()` 返回 `Result(T, TryRecvError)`；错误恒为 `Disconnected`，并且只有在缓冲区
  被取空之后才会报告，因此已经被接受的值不会丢失。
- `Channel(T).pair(capacity)` 以元组形式一次返回两端，写法更接近 Rust，但元组会在其整个作用域内
  持有两个句柄——所以提前丢弃 sender **并不会**关闭 Channel。只要流的结束时机重要，就优先使用
  `receiver()` + `sender()`。

`Sender` 是持有自己 `Channel` 句柄的值：`tx.clone()` 挂上一个被计数的生产者，丢弃一个就摘下一个，
隐式复制是 E0901（它会绕过计数）。`Receiver` 没有 `Clone`，复制它也是 E0901，因此唯一的消费者始终
只有一个。对于位于其他线程的生产者，请把一个属于该线程的 `Sender` 移入它的闭包：

```yo
rx := Channel(i32).receiver(usize(16));
{
  tx := rx.sender();
  tx2 := tx.clone(); // 第二个被计数的生产者
  w1 := Thread(unit).spawn({ tx }(io : Io) => {
    _ := tx.send(i32(7));
  });
  w2 := Thread(unit).spawn({ tx2 }(io : Io) => {
    _ := tx2.send(i32(8));
  });
  w1.join();
  w2.join();
}; // 两个 sender 都随各自的线程被丢弃 -> Channel 关闭
```

**移入** `Thread(T).spawn` 闭包的 `Sender` 若是最后一个，就会关闭 Channel：线程体返回时，spawn
包装函数会释放该线程的捕获结构体，因此该 sender 的丢弃逻辑会执行
（issues/fixed/spawn-closure-captures-never-dropped-leak.md；捕获本身又是闭包的情况见
issues/fixed/a-closure-typed-slot-never-releases-its-captures.md）。异步任务
（`std/async/channel`，在单个事件循环上提供同样的 `receiver()`/`sender()`/`pair()` API）以同样的
方式释放捕获。

## 可发送类型

只有实现了 `Send` 的类型才能被移动到另一个线程，只有实现了 `Sync` 的类型才能在线程之间共享（`Arc` 的载荷、模块级全局变量）；见 `THREAD_SAFETY.md` 的“Send 与 Sync 特质”：

- **可发送**：基本类型（`i32`、`bool` 等）、由 Send 字段组成的值类型结构体/枚举/元组、`String`、`T` 为 Send 时的 `ArrayList(T)` 与 `HashSet(T)`、`K` 与 `V` 为 Send 时的 `HashMap(K, V)`（各自唯一地拥有自己的缓冲区）、`Arc(T)`（其载荷是 `Send` 且 `Sync` 的）、`std/sync` 的类型（`T` 为 Send 时的 `Mutex(T)` 与 `Channel(T)`、`Atomic*` 包装器以及其他锁）、`Box(Dyn(Trait, Send))`（具体类型在 `dyn(...)` 处检查；在 v0.2.77 中，拥有型载荷仍使用原子引用计数），以及捕获值全部为 Send、且代码不触及任何非 Send 模块级全局变量的函数值（具名函数或闭包）—— 在编译器能看到该值的地方按值判断：派生闭包体、`Impl(Fn(...), Send)` 或 `Impl(FnOnce(...), Send)` 参数、泛型 `where(T <: Send)` 参数、被捕获的变量
- **不可发送**：`Rc(T)`（非原子引用计数）以及持有它的值、未选择加入的裸指针及持有裸指针的类型、约束中不含 `Send` 的 `Box(Dyn(Trait))`、`Io`、`JoinHandle`、借用其捕获的闭包，捕获了上述任一值或触及非 Send 全局变量的函数值，以及在该处不知道其值的裸 `fn(...)` 类型（结构体字段、`Channel(fn() -> unit)` 的载荷）—— 见 `THREAD_SAFETY.md` 的“跨线程的函数与闭包”

`Rc` 对象图只属于它所在的线程（Rust 的规则）。`String`，以及元素为 `Send` 的集合，本身是 `Send` 的：按值移动到另一个线程；多个线程都要读取的数据则通过 `Arc` 共享。

```yo
// ✅ 可发送
Point :: struct(x : i32, y : i32);
Thread(unit).spawn(io => {
  p := Point(1, 2); // OK：在线程内部创建
});

// ❌ 不可发送
node := Rc.new(i32(42));
Thread(unit).spawn(io => {
  // 错误：无法捕获 `node`（`Rc` 不是 Send）
  // node.*;
});
```

## 内存模型

### 线程局部引用计数

每个操作系统线程拥有：

- **线程局部的值**：非原子引用单元（`ref`、`Rc`）不会离开它的线程
- **非原子引用计数**：引用计数使用非原子操作
- **线程局部事件循环**：I/O 状态为 `_Thread_local`

这意味着：

- 引用计数的值不会产生数据竞争（它们无法被共享）
- 引用计数无原子操作开销
- 没有垃圾回收暂停：不存在回收器
- 异步 I/O 无竞争

## 对比：Thread 与 ThreadPool

| 方面       | Thread             | ThreadPool             |
| ---------- | ------------------ | ---------------------- |
| OS 线程    | 专用（1:1）        | 线程池自己的 `n` 个工作线程 |
| 生命周期   | 显式管理（`join`） | 按批次（`join_all`）；丢弃即 `shutdown` |
| 开销       | 较高（需创建线程） | 较低（复用线程）       |
| 适用场景   | 长时间运行的任务   | 短期任务               |
| 固定       | 不适用             | 显式（`spawn_on`）     |
| 异步 I/O   | 拥有独立事件循环   | 每个工作线程自己的事件循环 |

`Thread(T).join()` 返回线程的 `T`。`ThreadPool.join_all` 不携带值：要从线程池任务返回结果，请通过 `Channel` 传回。

## 总结

| 组件        | 用途             | API                   |
| ----------- | ---------------- | --------------------- |
| **Thread**  | 专用操作系统线程 | `spawn`、`join`       |
| **ThreadPool** | 线程池        | `new`、`spawn`、`spawn_on`、`join_all`、`shutdown` |
| **Channel** | 阻塞式通信       | `new`、`send`、`recv` |

### 快速参考

```yo
{ Thread, ThreadPool, spawn } :: import("std/thread");
{ Channel } :: import("std/sync/channel");

// 带异步 I/O 的专用线程
thread := Thread(unit).spawn((io : Io) => {
  // 此线程拥有自己的事件循环
  task := io.async((io : Io) => {
    io.await(yield(io), io);
  });
  io.await(task, io);
});
thread.join();

// 线程池任务
pool := ThreadPool.new(usize(4));
spawn(&pool, (io : Io) => { /* 工作 */ });
pool.join_all();

// 通信
ch := Channel(i32).new(usize(10));
ch.send(i32(42));
val := ch.recv();
```

### 核心原则

1. **关注点分离** - Thread/ThreadPool = 执行，Channel = 通信
2. **Send trait** - 只有 Send 类型可以跨越线程边界
3. **线程局部 RC** - 非原子计数无需跨线程协调
4. **非原子引用计数** - 线程局部对象无原子操作开销
5. **共享队列，显式固定** - 空闲的工作线程取走下一个任务；`spawn_on` 固定一个任务；已开始的任务从不移动
6. **每线程事件循环** - 每个线程拥有独立的异步 I/O
