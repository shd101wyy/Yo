# Async/Await — Yo 的单线程并发模型

## 设计理念

Yo 使用基于**代数效应**的 **async/await 状态机变换**来实现高效的**单线程并发**。这是一种无栈协程模型，类似于 JavaScript 的事件循环——所有异步代码都在与调用方**相同的线程**上运行。

**核心思想**：`io.async`/`io.await` 提供的是**并发**（交替执行），而非**并行**（同时执行）。如需并行执行，请参阅 `PARALLELISM.md` 中描述的 `Task.spawn` API，它提供隔离的多线程执行。

```rust
{ yield } :: import "std/async";

// 所有异步代码运行在同一线程上
main :: (fn(io : Io) -> unit)({
  task1 := io.async((io : Io)=> {
    io.await(yield());
    return i32(1);
  });
  task2 := io.async((io : Io)=> {
    io.await(yield());
    return i32(2);
  });
  // spawn 启动两个任务但不等待完成，返回 JoinHandle
  handle1 := io.spawn(task1);
  handle2 := io.spawn(task2);
  // 通过 handle 等待并提取结果（Option(T)）
  result1 := handle1.await(io);
  result2 := handle2.await(io);
});
export main;
```

## 并发 vs 并行

| 概念     | 机制                  | 描述                         |
| -------- | --------------------- | ---------------------------- |
| **并发** | `io.async`/`io.await` | 多个任务在同一线程上交替执行 |
| **并行** | `Task.spawn`          | 多个任务在不同线程上同时执行 |

```rust
// 并发：同一线程，交替执行
main :: (fn(io : Io) -> unit)({
  a := io.async((io : Io)=> { /* ... */ });
  b := io.async((io : Io)=> { /* ... */ });
  io.spawn(a);  // 启动 a 但不等待（返回 JoinHandle）
  io.spawn(b);  // 启动 b 但不等待（返回 JoinHandle）
  io.await(a);
  io.await(b);
});

// 并行：不同线程，真正的同时执行
task := Task(i32, bool).spawn((parent) -> {
  // 运行在不同线程上！
  // 完全隔离——无共享内存
});
```

## 执行模型：基于代数效应的惰性启动

Yo 的 async 使用**代数效应**和 `Io` 效应类型。异步任务是**惰性**的——在被显式 await 或 spawn 之前不会启动：

- `io.async(fn)` 创建一个**冷 Future**——函数体尚未执行
- `io.await(task)` 启动冷任务并顺序运行至完成
- `io.spawn(task)` 启动冷任务但**不等待**其完成，返回 `JoinHandle(T)`

```rust
{ yield } :: import "std/async";

main :: (fn(io : Io) -> unit)({
  counter := Box(i32)(0);

  // 惰性创建——两个任务都尚未启动
  task1 := io.async((io : Io)=> {
    counter.* = (counter.* + 1);   // 启动时执行
    io.await(yield());              // 让出控制权给事件循环
    counter.* = (counter.* + 1);   // 其他任务让出后恢复执行
  });

  task2 := io.async((io : Io)=> {
    counter.* = (counter.* + 10);
    io.await(yield());
    counter.* = (counter.* + 10);
  });

  // 此时 counter 仍为 0——任务尚未启动
  assert((counter.* == i32(0)), "tasks are lazy");

  // spawn 启动两个任务但不等待：
  // 1. task1 运行：counter=0→1，让出
  // 2. task2 运行：counter=1→11，让出
  handle1 := io.spawn(task1);
  handle2 := io.spawn(task2);

  // handle.await 等待完成并返回 Option(T)：
  // 3. task1 恢复：counter=11→12
  // 4. task2 恢复：counter=12→22
  handle1.await(io);
  handle2.await(io);

  assert((counter.* == i32(22)), "both tasks interleaved and completed");
});
export main;
```

**与急切模型（旧版 Yo、C#、C++）的关键区别：**

- 急切模型：`let f = async_fn()` 立即运行直到第一个 `await`
- 惰性模型（当前）：`task := io.async(fn)` 在 `io.await(task)` 或 `io.spawn(task)` 之前不会执行

## 设计动机

### 为什么选择单线程异步？

1. **简单性**：无需考虑线程安全，异步不需要 Send trait
2. **无数据竞争**：所有异步代码在同一线程上运行
3. **内存高效**：每个任务的状态机只需约 100-500 字节
4. **海量并发**：可处理数百万个并发任务
5. **零成本抽象**：编译期进行状态机变换
6. **熟悉的模型**：类似 JavaScript 的事件循环——经过验证且直观
7. **无需原子操作**：引用计数不需要原子操作
8. **代数效应**：通过 `io : Io` 显式声明 Io 能力

### 为什么不用多线程异步？

多线程异步（如 Rust 的 tokio）增加了复杂性：

- 需要 `Send` trait 来验证线程安全
- 需要原子引用计数
- 需要跨线程同步
- 工作窃取带来额外开销

Yo 的策略：保持 async 简单（单线程），使用 `Task.spawn` 实现并行（隔离线程）。

## 语言语法

```rust
{ yield } :: import "std/async";

// 异步任务创建（惰性——在 await/spawn 之前不会运行）
task := io.async((io : Io)=> {
  io.await(yield());  // 让出控制权给事件循环
  return i32(42);
});

// 顺序 await：启动任务，运行至完成
result := io.await(task);

// 并发：spawn 启动任务但不等待，返回 JoinHandle(T)
handle1 := io.spawn(task1);
handle2 := io.spawn(task2);
handle3 := io.spawn(task3);

// 然后通过 handle.await 提取结果，类型为 Option(T)
r1 := handle1.await(io);
r2 := handle2.await(io);
r3 := handle3.await(io);
```

### Io 效应与 Using

异步操作需要 `Io` 效应，通过 `io : Io` 传递：

```rust
// main 函数接收 Io 效应
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io)=> {
    // 此处可使用 io.await、io.async、io.spawn
    io.await(yield());
  });
  io.await(task);
});
export main;

// 测试块自动提供 `io : Io`
test "my test", {
  task := io.async((io : Io)=> { /* ... */ });
  io.await(task);
};
```

### API

```rust
io.async(fn)                  // 创建冷 Future（惰性，不会立即启动）
io.await(future)              // 若为冷任务则启动，等待完成，返回结果
io.state(future)              // 查询 Future 的当前状态（返回 FutureState）
io.spawn(future)              // 启动冷 Future 但不等待，返回 JoinHandle(T)
handle.await(io)       // 等待已 spawn 的任务，返回 Option(T)（unwind 时返回 .None）
yield()                       // 创建预完成的 Future（将控制权让给事件循环）
```

**重要规则**：

1. `io.async(fn)` 创建**惰性** Future——函数体在 await 或 spawn 之前不会执行
2. `io.await(future)` 启动冷 Future 并顺序运行至完成
3. `io.state(future)` 返回当前 `FutureState`，不会阻塞或启动 Future
4. `io.spawn(future)` 启动冷 Future 但不等待——返回 `JoinHandle(T)` 以便后续 await
5. `handle.await(io)` 等待已 spawn 的任务，返回 `Option(T)`——完成时返回 `.Some(result)`，unwind（中止）时返回 `.None`
6. 对已**中止**的 Future 进行 spawn 会导致 **panic**
7. 所有异步代码运行在**同一线程**上——不会创建新线程
8. `yield()` 挂起当前任务，将控制权让给事件循环中其他就绪的任务
9. `io.await(future)` 可以对同一 Future **多次调用**——每次调用返回相同的结果
10. 对被代数效应处理器**中止**的 Future 进行 await 会导致 **panic**

### 执行模型

```rust
// 三个任务全部运行在同一线程上
main :: (fn(io : Io) -> unit)({
  // 惰性——任务为冷状态，尚未运行
  t1 := io.async((io : Io)=> { /* task1 的函数体 */ });
  t2 := io.async((io : Io)=> { /* task2 的函数体 */ });
  t3 := io.async((io : Io)=> { /* task3 的函数体 */ });

  // spawn 启动每个任务但不等待：
  // - t1 运行到第一个 yield，挂起
  // - t2 运行到第一个 yield，挂起
  // - t3 运行到第一个 yield，挂起
  h1 := io.spawn(t1);
  h2 := io.spawn(t2);
  h3 := io.spawn(t3);

  // handle.await 等待完成并返回 Option(T)：
  // - 事件循环以轮询方式恢复 t1、t2、t3
  r1 := h1.await(io);
  r2 := h2.await(io);
  r3 := h3.await(io);
});
```

### Future 类型

```rust
// `io.async(fn)` 返回 `Impl(Future(T))`——指向堆分配状态机的指针。
// 状态机存储：
//   - state: int（0 = 冷，1..N = 中间状态，-1 = 已完成，-2 = 已中止）
//   - continuation_fn / continuation_sm（完成后恢复谁）
//   - result: T（完成时的结果；unit 类型省略）
//   - 捕获的变量 + 跨 await 点的局部变量
// 丢弃/销毁 Future 时释放状态机。
```

#### 带效应的 Future

`Future(T)` 可以携带代数效应信息。形态为：

```rust
Future(T)        // 无效应
Future(T, E)     // 携带效应包 E 的 Future，产出 T
```

`E` 是单个类型——通常是一个把异步体所需的所有效应（处理器字段加上类似
`Io` 的记录）打包到一起的 struct。作者自行把效应打包；语言不会再把多个
类型参数拼接为效应集合。

```rust
// 一个把异步任务所需的全部效应打包在一起的 struct。
TaskCtx :: struct(io : Io, raise : Raise, log : Log);
```

**匹配规则**

1. **按效应包类型相等。** 当 `E1` 与 `E2` 兼容时，`Future(T, E1)` 与
   `Future(T, E2)` 匹配。不再存在「顺序无关的集合匹配」——没有集合，
   只有一个效应包。
2. **带注解与不带注解可以互通。** `Future(T)`（无效应包）与
   `Future(T, E)`（任意效应包）兼容。当调用方不需要引用具体效应类型时
   使用不带注解的形式。
3. **使用 await 的异步体需要 Io。** 任何调用 `io.await` / `yield`
   的异步体都需要在效应包中包含 `Io`，因此效应包 struct 通常会有一个
   `io : Io` 字段。

**示例：通过 async 传递打包后的效应**

```rust
{ yield } :: import "std/async";
Raise :: (fn(generic(T : Type), msg : String) -> T);
Log :: (fn(msg : String) -> unit);
TaskCtx :: struct(io : Io, raise : Raise, log : Log);

main :: (fn(io : Io) -> unit)({
  (raise : Raise) = ((msg) -> { return(i32(0)); });
  (log : Log) = ((msg) -> { println(msg); });
  ctx := TaskCtx(io: io, raise: raise, log: log);

  (task : Impl(Future(i32, TaskCtx))) = io.async((ctx : TaskCtx) => {
    ctx.log(`doing work`);
    ctx.io.await(yield(), ctx.io);
    i32(42)
  });

  result := io.await(task, ctx);
});
export main;
```

`Io` 效应记录本身就是一个效应包形态的 struct，由异步运行时提供：

```rust
Io :: struct(
  async : (fn(generic(T : Type, E : Type.Struct), action : Impl(Fn(e : E) -> T)) -> Impl(Future(T, E))),
  await : (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> T),
  state : (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E))) -> FutureState),
  spawn : (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> JoinHandle(T))
);
```

为什么需要堆分配？

- Future 可以在 `await` 处挂起并在稍后恢复；状态机必须在当前 C 栈帧返回后仍有稳定的地址。
- 运行时将续体排入队列，形式为 `(resume_fn, state_machine_ptr)`，因此状态机必须比调度点存活更久。

这是一个实现选择，而非语义上的必要要求。

### 多次 Await

同一个 Future 可以被**多次** await。每次对同一 Future 调用 `io.await` 都会返回相同的结果：

```rust
main :: (fn(io : Io) -> unit) {
  task := io.async(() => {
    return 42;
  });
  result1 := io.await(task);
  result2 := io.await(task);
  result3 := io.await(task);
  assert((result1 == 42), "first await returns 42");
  assert((result2 == 42), "second await returns 42");
  assert((result3 == 42), "third await returns 42");
};
export main;
```

Future 在完成后保留其结果。对于引用计数类型的结果，每次 `io.await` 调用会对结果进行 dup，使调用方获得自己的引用。Future 的 dispose 函数在状态机被释放时 drop 原始值。

### 中止的 Future

当代数效应处理器在异步任务内调用 `unwind` 时，Future 被标记为**已中止**（内部状态 = -2）。任务的续体被丢弃，不会存储结果。

**使用 `io.await`**：对已中止的 Future 调用 `io.await` 会导致 **panic**。

**使用 `handle.await`**：`JoinHandle.await` 返回 `Option(T)`——中止时返回 `.None`，安全地捕获 unwind：

```rust
main :: (fn(io : Io) -> unit) {
  Raise :: (fn(generic(T : Type), msg : String) -> T);
  task := io.async((io : Io, raise : Raise) => {
    raise(`something went wrong`);
    return i32(42);
  });

  (raise : Raise) = (msg) -> { unwind (); };
  handle := io.spawn(task, io, raise);
  result := handle.await(io);
  // result 是 Option(i32).None——任务已被中止
  assert(result.is_none(), "aborted task returns None");
};
export main;
```

**Future 状态机的状态：**

| 状态值 | 含义                                      | `FutureState` 枚举值    |
| ------ | ----------------------------------------- | ----------------------- |
| 0      | 冷——尚未启动                              | `FutureState.Pending`   |
| 1..N   | 中间状态——在 await/yield 点挂起           | `FutureState.Running`   |
| -1     | 已完成——结果可用                          | `FutureState.Completed` |
| -2     | 已中止——效应处理器调用了 `unwind`，无结果 | `FutureState.Aborted`   |

### 查询 Future 状态

`io.state(future)` 返回当前 `FutureState`，不会阻塞或启动 Future。适用于轮询或诊断：

```rust
FutureState :: enum(
  Pending = 0,     // 冷——尚未启动
  Running = 1,     // 执行中——在 await/yield 点挂起
  Completed = -(1), // 已完成——结果可用
  Aborted = -(2)   // 已中止——效应处理器调用了 unwind
);
```

```rust
main :: (fn(io : Io) -> unit) {
  task := io.async((io : Io)=> {
    io.await(yield());
    return i32(42);
  });

  // 启动前：Pending
  assert((io.state(task) == FutureState.Pending), "cold future is Pending");

  io.await(task);

  // 完成后：Completed
  assert((io.state(task) == FutureState.Completed), "done future is Completed");
};
export main;
```

**要点：**

- `io.state` 是对 Future 内部状态字段的**非阻塞**、**同步**读取
- 原始状态机值 1..N（中间挂起状态）全部映射为 `FutureState.Running`
- `io.state` **不会**启动冷 Future——仅做观察
- 对同一 Future 多次调用 `io.state` 的结果是一致的

## 状态机变换

编译器在每个 `await` 点将异步函数变换为状态机。

### 变换示例

**输入的 Yo 代码：**

```rust
task := io.async((io : Io)=> {
  response := io.await(http_get(url));
  data := io.await(response.read());
  return data;
});
```

**概念上的变换：**

1. **状态机结构体**：

   - 跟踪当前状态（0, 1, 2...）
   - 捕获函数参数（url）
   - 存储跨 await 点使用的局部变量（response, data）
   - 持有待处理的 Future

2. **Poll 函数**：

   - 每个状态对应一个 case 的 switch 语句
   - 状态 0：调用 http_get，检查是否就绪
   - 状态 1：提取 response 结果，调用 read，检查是否就绪
   - 状态 2：提取 data 结果，返回 Ready(data)

3. **Resume 函数（惰性启动）**：
   - 状态 0（冷）：Future 已创建但尚未启动
   - 当 `io.await` 或 `io.spawn` 触发首次 resume 时：
     - 状态 0：调用 http_get，检查是否就绪
     - 状态 1：提取 response 结果，调用 read，检查是否就绪
     - 状态 2：提取 data 结果，返回 Ready(data)
   - 在每个 yield/await 点，任务让出以确保公平性

### 要点

- 每个 `await` 变为一次状态转换
- 跨 `await` 使用的局部变量被捕获到状态结构体中
- Poll 函数是逐步推进各状态的 switch 语句
- 不涉及线程——所有轮询都在同一线程上进行

### `io.async` 内部 `await` 可以出现的位置

每个 `await` 都是一次状态转换，因此它必须位于函数体能够被**切分**的位置。分支主体
天然可切分。条件与 `match` 被匹配值在选择分支之前求值，因此会被**提升**到状态边界
之外；而 `while` 的条件每轮迭代都要重新求值，于是整个循环在一个状态中循环往复。

```rust
// ✓ 支持
cond(needs_write => { io.await(write_string(p, data, io), io); }, true => ());
if(io.await(exists(p, io), io), { ... });
cond(io.await(ready(io), io) => ..., true => ...);
match(io.await(num(io), io), 42 => ..., _ => ...);
while(io.await(more(io), io), { ... });
while(c, { ... io.await(f, io) ... }, { ... });   // 三参数形式的步进（第 2 个参数）

// ✗ 拒绝：await 被**嵌套**在更大的条件表达式中
if(!(io.await(exists(p, io), io)), { ... });
// ✓ 先绑定到局部变量
found := io.await(exists(p, io), io);
if(!(found), { ... });

// ✗ 拒绝：位于**靠后**的 cond 分支。`cond` 惰性求值，提升它会导致即使前面的分支
//   命中也仍然执行 await——这改变的是语义，而不只是时机。
cond(c1 => ..., io.await(f, io) => ..., true => ...);
```

这些都是真正的挂起：在 await 条件之前 spawn 的任务，会在当前任务挂起期间运行。

该限制**仅适用于 `io.async` 内部**。在普通 `fn` 体中，`io.await` 会同步驱动事件
循环，可以出现在任何允许表达式的位置。

## 事件循环

异步运行时使用简单的**单线程事件循环**：

```
┌─────────────────────────────────────────────┐
│              事件循环（主线程）               │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │             就绪队列                │    │
│  │  ┌─────┐ ┌─────┐ ┌─────┐           │    │
│  │  │任务1│ │任务2│ │任务3│  ...      │    │
│  │  └─────┘ └─────┘ └─────┘           │    │
│  └─────────────────────────────────────┘    │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐    │
│  │         轮询下一个就绪任务            │    │
│  │   - 运行直到 await                  │    │
│  │   - 若 Io 待处理，注册唤醒器         │    │
│  │   - 若已就绪，继续执行               │    │
│  └─────────────────────────────────────┘    │
│                    │                        │
│                    ▼                        │
│  ┌─────────────────────────────────────┐    │
│  │          Io 完成检查                │    │
│  │   - 检查 epoll/kqueue/IOCP          │    │
│  │   - 唤醒已完成的任务                 │    │
│  │   - 加入就绪队列                    │    │
│  └─────────────────────────────────────┘    │
│                                             │
└─────────────────────────────────────────────┘
```

### 事件循环步骤

1. 从就绪队列中**出队**一个就绪任务
2. **轮询**该任务的状态机
3. **若 await 的 Io 未完成**：注册唤醒器，任务休眠
4. **若 await 的 Future 已就绪**：继续到下一状态
5. **若已完成**：将 Future 标记为就绪，唤醒等待者
6. **检查 Io**：向操作系统查询已完成的 Io 事件
7. **唤醒任务**：将被唤醒的任务移入就绪队列
8. **重复**直到所有任务完成

### 线程局部事件循环

每个操作系统线程有自己的事件循环。所有异步运行时状态都是线程局部的（POSIX 上为 `_Thread_local`，Windows 上为 `__declspec(thread)`）：

```c
// 每线程任务队列
static _Thread_local __yo_async_task_queue_t __yo_thread_async_queue = {NULL, NULL, 0};

// 每线程事件循环状态
static _Thread_local bool __yo_async_scheduler_initialized = false;
static _Thread_local bool __yo_io_initialized = false;
static _Thread_local size_t __yo_pending_io_count = 0;
static _Thread_local size_t __yo_active_watch_count = 0;

// 每线程 I/O 后端（以 Linux 为例）
static _Thread_local struct io_uring __yo_io_ring;
```

这意味着：

- **主线程**：拥有自己的事件循环，用于 `io.async`/`io.await` 任务
- **工作线程**（来自 `Task.spawn`）：各自获得独立的事件循环
- **同一线程上的多个 Worker**：同一操作系统线程上的 Worker 协作共享该线程的事件循环
- **无跨线程任务迁移**：任务始终在创建它的线程上运行
- **无需加锁**：队列操作在设计上是单线程的
- **进程全局状态**（信号处理器、WSA 初始化、TTY 设置）保持 `static`——所有线程共享

### 运行时初始化

异步运行时是条件生成的——**仅在程序使用 async/await 时**才生成：

- 编译器在代码生成阶段扫描 `io.async`、`io.await` 和 `io.spawn` 调用
- 若无异步代码，运行时（调度器、I/O 子系统、续体队列）**完全不会生成**，`main()` 直接调用用户函数
- 若有异步代码，`main()` 初始化调度器并等待所有任务完成：

```c
int main(int argc, char** argv) {
  __yo_async_scheduler_init();   // 轻量级：仅设置一个标志
  __yo_user_main();
  __yo_async_wait_all();         // 排空队列；若队列为空则立即返回
  return 0;
}
```

**I/O 初始化是惰性的**：`__yo_io_init()` 在首次实际 I/O 操作（文件打开、socket 连接等）时才被调用，而非程序启动时。这意味着仅使用 `yield()` 和纯计算的程序不会产生任何 I/O 初始化开销。

类似地，**并行运行时**（线程池、Worker 创建、硬件检测）仅在程序使用 `Thread.spawn` 或 `worker.spawn` 时才生成。非并行程序可节省约 450 行生成的 C 代码。

**同步系统辅助函数**（stat/dirent 访问器、sendfile/copyfile、同步文件操作、mmap/madvise、fcntl、flock、socket 地址辅助函数、信号处理器、TTY）始终通过 `generateSysRuntime()` 生成，其中包括跨平台辅助函数和平台特定的同步辅助函数（`generatePlatformSysRuntime{MacOS,Linux,Windows}`）。这些**不依赖 IoFuture**。所有函数均为 `static`，因此未使用的函数会被 C 编译器的死代码消除机制剥离。这确保了使用信号、stat、mmap、TTY 等功能的非异步程序在编译时不会引入完整的异步运行时。

### 平台特定的 I/O 后端

| 平台    | 后端                                            | 文件                    |
| ------- | ----------------------------------------------- | ----------------------- |
| Linux   | `io_uring`（通过 liburing）                     | `runtime-io-linux.ts`   |
| macOS   | `kqueue`（kevent 就绪通知 + 同步 pread/pwrite） | `runtime-io-macos.ts`   |
| Windows | I/O 完成端口（IOCP）                            | `runtime-io-windows.ts` |
| WASM    | POSIX I/O（NODERAWFS）+ 定时器队列              | `runtime-io-wasm.ts`    |

#### WASM 异步支持

WASM 目标（通过 emcc 的 `wasm32-emscripten`）支持核心异步调度器和真正的定时器支持——`io.async()`、`io.await()`、`io.spawn()`、`JoinHandle.await()` 和 `sleep()`（来自 `std/sys/timer`）均可正常工作。调度器使用 NODERAWFS 的 POSIX I/O 进行文件操作，使用排序定时器队列实现非阻塞 sleep。

WASM 上可用的功能：

- `io.async()` — 创建惰性 Future
- `io.await()` — 等待 Future
- `io.spawn()` / `JoinHandle.await()` — 创建并等待任务
- `yield()` — 任务间的协作式让出
- 异步中的代数效应
- `sleep()`（来自 `std/sys/timer`）— 通过排序定时器队列实现基于定时器的延迟
- 文件 I/O（`File.open`、`read`、`write`，来自 `std/fs/file` 和 `std/sys/file`）— 通过 NODERAWFS（Node.js）或 Emscripten FS

WASM 上不可用的功能：

- DNS、TCP、UDP — Emscripten 中无网络栈
- 进程创建、信号、文件系统事件 — 无操作系统级 API
- 并行（`Thread.spawn`）— 需要 pthread 支持（实验性）

并发辅助函数返回合理的默认值：`__yo_thread_get_hardware_threads()` 返回 1，`__yo_get_thread_id()` 返回 0，`__yo_thread_yield()` 为空操作。

## 内存管理

### 非原子引用计数

由于所有异步代码在同一线程上运行：

- 引用计数无需原子操作
- 简单的递增/递减
- 无同步开销

```c
// 非原子引用计数（单线程）
struct __yo_ref_header {
  size_t ref_count;  // 普通 size_t，不是原子类型！
};

// 递增——无需原子操作！
static inline void yo_rc_inc(__yo_ref_header_t* header) {
  header->ref_count++;
}

// 递减——无需原子操作！
static inline bool yo_rc_dec(__yo_ref_header_t* header) {
  return --header->ref_count == 0;
}
```

### Future 的生命周期管理

Future（异步块状态机）使用**引用计数**来处理任务在被 await 之前就完成的情况：

**生命周期模式："事件循环持有引用"**

```rust
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io)=> {
    /* 工作 */
  });
  // task 为冷状态（refcount=1），尚未启动

  io.spawn(task);
  // spawn 启动任务，返回 JoinHandle(T)（非持有视图）
  // __yo_incr_rc（refcount=2）
  // 一个引用属于用户代码（task），一个属于运行中的任务（事件循环）

  io.await(task);
  // 等待完成，提取结果
  // 任务完成，事件循环释放引用（refcount=1）
  // task 离开作用域（refcount=0，被释放）
});
export main;
```

**引用计数生命周期：**

1. **创建**：`io.async(fn)` 分配状态机，`refcount = 1`
2. **启动（通过 await/spawn）**：启动前 `__yo_incr_rc()`（refcount = 2）
   - 一个引用属于用户代码（`task` 变量）
   - 一个引用属于运行中的任务（由事件循环持有）
3. **用户释放**：当 `task` 离开作用域时，`__yo_decr_rc()`（refcount = 1）
4. **任务完成**：状态机调用 `__yo_decr_rc()`（refcount = 0，被释放）

**核心洞察**：即使用户代码提前释放任务，任务也会保持存活直到完成！

**实现细节：**

状态机结构体的第一个字段是 `__yo_ref_header_t`：

```c
struct async_block_state_t {
  __yo_ref_header_t header;  // 必须是第一个字段，以使 __yo_decr_rc 正常工作
  int state;
  // ... 其他字段 ...
};
```

`Impl(Future(T))` 类型使用 `__yo_sometype_drop`，它调用 `__yo_decr_rc`：

```c
void fn_id12345___drop(async_block_state_t* self) {
  if (self != NULL) { __yo_decr_rc((void*)self); };
}
```

**类型系统集成：**

求值器的 `getMethodsByNameFromEnv` 函数对 Future 类型有特殊处理——它**不**使用 `resolvedConcreteType` 进行方法查找。这确保调用 `task.___drop()` 时使用的是 SomeType 自身的 `___drop` 方法（调用 `__yo_sometype_drop`），而非捕获结构体的 drop 函数。

### 状态机生命周期

```c
// 1. 创建——分配带状态机的 Future（冷，refcount=1）
FunctionName_Future* future = __yo_malloc(sizeof(FunctionName_Future));
future->header.ref_count = 1;
future->state = 0;  // 冷——尚未启动
// 初始化状态机字段...

// 2. 启动（惰性）——由 io.await 或 io.spawn 触发
__yo_incr_rc(future);  // refcount = 2
future->__yo_resume_fn(future);  // 运行到首次 yield/await
// 任务在 yield 处挂起，被加入事件循环队列

// 3. 事件循环——运行就绪任务
while (not_complete) {
  __yo_async_run_ready_tasks();  // 恢复排队的任务
}

// 4. 完成
future->state = -1;  // 标记为已完成
future->result = final_value;
__yo_decr_rc(future);  // 释放运行中任务的引用
// 唤醒续体（如果有的话）

// 5. 清理——当用户释放时，refcount 达到 0，被释放
```

### `Impl(Future(T))` 的分派与分配模型

**`Impl(Future(T))` 始终是堆分配的，使用非原子引用计数。**

这**不是**静态分派（即具体类型已知且在栈上分配的情况）。实际上：

1. **堆分配**：`io.async(fn)` 调用 `__yo_malloc(sizeof(state_machine_struct))` 并返回指针。这是必要的，因为：

   - Future 跨 C 栈帧挂起和恢复——状态机必须比创建它的栈帧存活更久
   - 事件循环将续体排入队列，形式为 `(resume_fn, state_machine_ptr)` 对——需要稳定的地址
   - 可以同时存在多个引用（用户代码 + 事件循环）

2. **引用计数**：每个状态机的第一个字段是 `__yo_ref_header_t`。引用计数是非原子的，因为所有异步代码运行在单线程上。典型的生命周期为：

   - 创建：`refcount = 1`（用户持有）
   - 启动（await/spawn）：`refcount = 2`（用户 + 事件循环）
   - 任务完成：事件循环递减 → `refcount = 1`
   - 用户作用域退出：用户递减 → `refcount = 0` → 通过 dispose 函数释放

3. **指针语义**：在生成的 C 代码中，`Impl(Future(T))` 编译为 `state_machine_struct*`（指针）。Yo 类型系统将其视为不透明的——用户代码无法检查结构体字段。

4. **Dispose 函数**：每个状态机类型都有一个自定义的 dispose 函数：

   - 丢弃捕获结构体（外部作用域变量）
   - 丢弃结果值（如果已完成且结果包含引用计数类型）
   - 丢弃局部变量（如果在执行中途被中止）
   - 内存由 `__yo_decr_rc` 在 dispose 函数返回后释放

5. **sync_fut_t 优化**：当异步块**没有 await 点**（纯同步）时，生成轻量级的 `sync_fut_t` 结构体而非完整的状态机。它具有相同的头部布局但没有状态分派——resume 函数仅调用闭包并将状态设为 -1（已完成）。

**为什么不用栈分配？** 即使使用 `Impl(...)`（在 Yo 中通常意味着静态分派），Future 也必须堆分配，因为其生命周期与创建它的栈帧解耦。在函数 `f()` 中创建的 Future 可能在 `f()` 返回后才在函数 `g()` 中被 await。

### 状态机内存

状态机很小（约 32-500 字节）：

- 状态 ID：4 字节
- 捕获的参数：大小不定
- 捕获的局部变量：大小不定
- 待处理的 Future：每个 8 字节

## 性能特征

### 内存使用

**10,000 个并发异步操作：**

- 状态机：10,000 × 约 200 字节 = 2MB
- 无需线程栈！

**对比：**

- 10,000 个操作系统线程 × 1MB 栈 = 10GB ❌
- 10,000 个 Go goroutine × 2KB = 20MB
- 10,000 个 Yo 异步任务 × 200 字节 = 2MB ✅

### 吞吐量

- 状态机轮询：每次约 10-50ns
- 无上下文切换（同一线程）
- 无同步开销
- 缓存友好（小型状态机）

## API

### 核心操作

```rust
{ yield } :: import "std/async";

// io.async：创建惰性 Future（冷，在 await/spawn 之前不会启动）
task := io.async((io : Io)=> {
  // 函数体
  return value;
});

// io.await：若为冷任务则启动，等待完成，返回结果
result := io.await(task);

// io.spawn：启动冷 Future 但不等待，返回 JoinHandle(T)
handle1 := io.spawn(task1);
handle2 := io.spawn(task2);
// spawn 后任务正在运行——handle.await 返回 Option(T)
r1 := handle1.await(io);
r2 := handle2.await(io);
```

### 示例：使用 Spawn 的并发任务

```rust
{ yield } :: import "std/async";

main :: (fn(io : Io) -> unit)({
  counter := Box(i32)(0);

  task1 := io.async((io : Io)=> {
    counter.* = (counter.* + 1);
    io.await(yield());
    counter.* = (counter.* + 1);
    return counter.*;
  });

  task2 := io.async((io : Io)=> {
    counter.* = (counter.* + 10);
    io.await(yield());
    counter.* = (counter.* + 10);
    return counter.*;
  });

  // 任务为冷状态——counter 仍为 0
  handle1 := io.spawn(task1);
  handle2 := io.spawn(task2);
  // 两者通过交替执行运行：counter = 22
  result1 := handle1.await(io);
  result2 := handle2.await(io);
});
export main;
```

### 示例：顺序 Await（不使用 Spawn）

```rust
{ yield } :: import "std/async";

main :: (fn(io : Io) -> unit)({
  counter := Box(i32)(0);

  task1 := io.async((io : Io)=> {
    counter.* = (counter.* + 1);
    io.await(yield());
    counter.* = (counter.* + 1);
  });

  task2 := io.async((io : Io)=> {
    counter.* = (counter.* + 10);
    io.await(yield());
    counter.* = (counter.* + 10);
  });

  // 不使用 spawn：任务顺序执行
  io.await(task1);  // task1 完整运行至完成
  io.await(task2);  // 然后 task2 完整运行至完成
  // counter 无论哪种方式都等于 22，但没有交替执行
});
export main;
```

## 与其他语言的比较

| 语言                     | 模型           | 线程模型   | 每任务内存 | 最大并发数 |
| ------------------------ | -------------- | ---------- | ---------- | ---------- |
| **Yo**                   | 无栈状态机     | **单线程** | ~200 字节  | 百万级     |
| **JavaScript**           | 无栈 Promise   | **单线程** | ~100 字节  | 百万级     |
| **Python (asyncio)**     | 无栈协程       | **单线程** | ~200 字节  | 百万级     |
| **Rust（单线程执行器）** | 无栈 Future    | **单线程** | ~100 字节  | 百万级     |
| **Rust（tokio 多线程）** | 无栈 Future    | 多线程     | ~100 字节  | 百万级     |
| **Go**                   | 有栈 goroutine | 多线程     | 2KB+       | 10万-100万 |

**注意**：Yo 的单线程异步模型与 JavaScript 和 Python asyncio 最为相似：

- ✅ 简单的心智模型（无线程安全问题）
- ✅ 不需要 Send/Sync trait
- ✅ 无原子引用计数开销
- ✅ Web 开发者熟悉

如需并行，请使用 `Task.spawn`（参见 `PARALLELISM.md`）。

## 效应注入（运行时效应绑定）

当异步闭包通过 `e : E` 声明效应参数时，处理器在 `io.async` 创建时可能尚未确定。Yo 支持**运行时效应注入**：调用方在 `io.spawn` 或 `io.await` 时提供具体的处理器，将其绑定到 Future 的捕获结构体中。`io.spawn` 返回 `JoinHandle(T)`，可通过 `handle.await(io)` 等待并返回 `Option(T)`。

### 何时使用运行时注入？

当以下条件**全部**满足时，效应参数在捕获结构体中成为运行时 `void*` 字段：

1. 参数是**函数类型**（不是像 `Io` 这样的模块）
2. 函数类型**没有 `generic` 参数**（像 `fn(generic(T : Type), ...) -> T` 这样的泛型效应在编译期解析）
3. 处理器在 `io.async` 创建时**尚未解析**（外部作用域中没有 `(name : Type) = handler` 绑定）

如果处理器在创建时已可用（通过 `given` 绑定），则在编译期解析，参数保持为编译期专用。

### 一次性设置语义

效应注入遵循**一次性设置**语义。首次将 Future 从 pending（状态 0）转换为 running 的 `io.spawn` 或 `io.await` 调用会绑定效应处理器。后续使用不同 `e : E` 参数的 `io.spawn`/`io.await` 调用不会生效——原始处理器被保留。

```rust
Log :: (fn(msg : String) -> unit);

task := io.async((io : Io, log : Log)=> {
  log(`hello`);
});

(log1 : Log) = (msg) -> { println(`Log1: ${msg}`); };
(log2 : Log) = (msg) -> { println(`Log2: ${msg}`); };

// 首次 spawn 将 log1 绑定为处理器，返回 JoinHandle
handle := io.spawn(task, io, log1);

// handle.await 使用已绑定的处理器
handle.await(io);
// 输出："Log1: hello"
```

### 工作原理（实现）

1. **求值器**：在 `io.async` 时未解析的函数类型 `using` 参数被添加到闭包的 `capturedVariablesWithValues` 中，带有 `isEffectParam: true` 和 `value: undefined`。

2. **捕获结构体**：效应参数字段在 C 中类型为 `void*`，在 Future 创建时初始化为 NULL。

3. **spawn/await 时注入**：当调用 `io.spawn(task, ...)` 或 `io.await(task, ...)` 且 Future 仍为冷状态（state == 0）时，代码生成器会生成如下赋值：

   ```c
   future->__capture.log = (void*)fn_handler;
   ```

4. **通过 void\* 调用**：在异步闭包体内，对效应参数的调用通过函数指针强制转换进行：
   ```c
   ((return_type (*)(param_types...))sm->__capture.log)(args);
   ```

### 编译期 vs 运行时效应

| 条件                                 | 解析方式   | C 表示           |
| ------------------------------------ | ---------- | ---------------- |
| `handler` 在 `io.async` 时在作用域内 | 编译期     | 直接函数调用     |
| 泛型效应（`generic(T)`）             | 编译期     | 直接函数调用     |
| 模块（`Io`）类型                     | 编译期     | 无运行时字段     |
| 非泛型、未解析的处理器               | 运行时注入 | `void*` 捕获字段 |

## Async + 代数效应

代数效应与 async 协同工作：异步闭包可以通过 `e : E` 声明效应参数，调用方在 `io.await` 或 `io.spawn` 时注入处理器。本节介绍已测试的场景和已知限制。

### 已测试场景

| 场景                                    | 描述                                                 |
| --------------------------------------- | ---------------------------------------------------- |
| 异步闭包内的效应恢复                    | 处理器 `return` 一个值，异步闭包接收该值             |
| 跨多次 yield 的效应恢复                 | 每次 `io.await(yield())` 后调用效应                  |
| 通过 `io.await` 注入两个效应            | 两个独立的效应处理器同时注入                         |
| 通过 `io.spawn` 注入两个效应            | 同上，但通过 `io.spawn` + `handle.await`             |
| while 循环中的效应恢复                  | 在带 yield 的 `while` 循环体中调用效应               |
| while 循环中带 break 的效应恢复         | 效应根据返回值触发 `break`                           |
| 注入效应的 unwind 中止 Future           | 处理器调用 `unwind`，Future 进入 `Aborted` 状态      |
| 通过 spawn 注入效应的 JoinHandle unwind | 同上，但使用 `io.spawn`，`handle.await` 返回 `.None` |
| 异步内部的 given 处理器跨 yield         | `given` 绑定在异步体内定义，在 yield 后使用          |

### 已知限制

1. **效应处理器不是闭包** — 处理器函数是独立的 C 函数，无法捕获外部作用域的变量。请通过显式参数或 `Box` 传递状态。参见 `docs/en-US/ALGEBRAIC_EFFECTS.md`。

2. **异步 unwind 的引用计数双重递减** — 当 Future 作为参数传递给在 `io.await` 期间 unwind 的函数时，Future 的引用计数会被递减两次（一次在 await 中止路径，一次在 unwind 清理中），导致释放后使用。解决方法：在 unwind 的函数内部创建 Future。参见 `issues/async-unwind-rc-double-decrement.md`。

3. **异步中的三参数 while 循环** — 异步状态机代码生成仅处理两参数形式 `while condition, body`。三参数形式 `while condition, step, body` 会生成错误的 C 代码。解决方法：将步进表达式放在循环体内。参见 `issues/async-while-3arg-form.md`。

4. **二元表达式作为异步返回值** — 当异步闭包的最后一个表达式是二元运算（如 `(a + b)`）时，状态机结构体得到的是 `void* result` 而非正确的类型。解决方法：先赋值给变量。参见 `issues/async-sm-result-type-binary-expr.md`。

## 总结

Yo 的 async/await 提供：

1. **惰性执行** — `io.async(fn)` 创建冷 Future，在 `io.await` 或 `io.spawn` 之前不会启动
2. **单线程并发** — 所有异步代码运行在同一线程上
3. **并发 spawn** — `io.spawn(f)` 启动冷 Future 但不等待，返回 `JoinHandle(T)`
4. **无线程安全顾虑** — 不可能发生数据竞争
5. **代数效应** — 通过 `io : Io` 显式声明 Io 能力
6. **状态机变换** — 零成本抽象
7. **非原子引用计数** — 无同步开销
8. **内存高效** — 数百万并发任务（每个约 200 字节）
9. **公平性** — yield 点确保任务正确交替执行
10. **零成本** — 编译为高效的 C 代码

### 快速参考

```rust
{ yield } :: import "std/async";

// 创建惰性异步任务
task := io.async((io : Io)=> {
  io.await(yield());  // 让出控制权给事件循环
  return i32(42);
});

// 顺序：启动并运行至完成
result := io.await(task);

// 并发：启动任务但不等待，然后 await handle
handle1 := io.spawn(task1);
handle2 := io.spawn(task2);
r1 := handle1.await(io);  // Option(T)
r2 := handle2.await(io);  // Option(T)
```

### 核心原则

1. **惰性执行** — `io.async(fn)` 创建冷 Future
2. **`io.await(task)`** — 启动冷任务，顺序运行至完成
3. **`io.spawn(task)`** — 启动冷任务但不等待，返回 `JoinHandle(T)`
4. **`handle.await(io)`** — 等待已 spawn 的任务，返回 `Option(T)`（unwind 时返回 `.None`）
5. **单线程** — 所有异步代码运行在调用线程上
6. **`yield()` 让出** — 挂起任务，将控制权交给其他就绪任务
7. **状态机** — 编译器将每个 `io.await` 变换为状态转换
8. **无线程安全问题** — 无 Send trait，无数据竞争
9. **非原子引用计数** — 简单的引用计数（无同步）
10. **事件循环** — 运行就绪任务，检查 Io 完成
11. **零成本** — 编译为高效的 C 代码

### 使用场景

| 使用场景           | 机制                                |
| ------------------ | ----------------------------------- |
| Io 密集型并发任务  | `io.async`/`io.await`               |
| 同时运行多个任务   | `io.spawn` + `handle.await`         |
| CPU 密集型并行计算 | `Task.spawn`（参见 PARALLELISM.md） |
| 后台处理           | `Task.spawn`（参见 PARALLELISM.md） |
| 等待多个 Io        | `io.spawn` + `handle.await`         |
| 利用多个 CPU 核心  | `Task.spawn`（参见 PARALLELISM.md） |
