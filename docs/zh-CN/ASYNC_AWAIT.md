# Async/Await — Yo 的单线程并发模型

## 设计理念

Yo 使用基于**代数效应**的 **async/await 状态机变换**来实现高效的**单线程并发**。这是一种无栈协程模型，类似于 JavaScript 的事件循环——所有异步代码都在与调用方**相同的线程**上运行。

**核心思想**：`io.async`/`io.await` 提供的是**并发**（交替执行），而非**并行**（同时执行）。如需并行执行，请参阅 `PARALLELISM.md` 中描述的 `Task.spawn` API，它提供隔离的多线程执行。

```rust
{ yield } :: import("std/async");

// 所有异步代码运行在同一线程上
main :: (fn(io : Io) -> unit)({
  task1 := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(1));
  });
  task2 := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(2));
  });
  // spawn 启动两个任务但不等待完成，返回 JoinHandle
  handle1 := io.spawn(task1, io);
  handle2 := io.spawn(task2, io);
  // 通过 handle 等待并提取结果（Option(T)）
  result1 := handle1.await(io);
  result2 := handle2.await(io);
});
export(main);
```

## 并发 vs 并行

| 概念     | 机制                  | 描述                         |
| -------- | --------------------- | ---------------------------- |
| **并发** | `io.async`/`io.await` | 多个任务在同一线程上交替执行 |
| **并行** | `Task.spawn`          | 多个任务在不同线程上同时执行 |

```rust
// 并发：同一线程，交替执行
main :: (fn(io : Io) -> unit)({
  a := io.async((io : Io) => { /* ... */ });
  b := io.async((io : Io) => { /* ... */ });
  io.spawn(a, io); // 启动 a 但不等待（返回 JoinHandle）
  io.spawn(b, io); // 启动 b 但不等待（返回 JoinHandle）
  io.await(a, io);
  io.await(b, io);
});

// 并行：不同线程，真正的同时执行
task := Task(i32, bool).spawn(parent -> {
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
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  counter := Box(i32)(0);

  // 惰性创建——两个任务都尚未启动
  task1 := io.async((io : Io) => {
    counter.* = (counter.* + 1); // 启动时执行
    io.await(yield(io), io); // 让出控制权给事件循环
    counter.* = (counter.* + 1); // 其他任务让出后恢复执行
  });

  task2 := io.async((io : Io) => {
    counter.* = (counter.* + 10);
    io.await(yield(io), io);
    counter.* = (counter.* + 10);
  });

  // 此时 counter 仍为 0——任务尚未启动
  assert(counter.* == i32(0), "tasks are lazy");

  // spawn 启动两个任务但不等待：
  // 1. task1 运行：counter=0→1，让出
  // 2. task2 运行：counter=1→11，让出
  handle1 := io.spawn(task1, io);
  handle2 := io.spawn(task2, io);

  // handle.await 等待完成并返回 Option(T)：
  // 3. task1 恢复：counter=11→12
  // 4. task2 恢复：counter=12→22
  handle1.await(io);
  handle2.await(io);

  assert(counter.* == i32(22), "both tasks interleaved and completed");
});
export(main);
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
{ yield } :: import("std/async");

// 异步任务创建（惰性——在 await/spawn 之前不会运行）
task := io.async((io : Io) => {
  io.await(yield(io), io); // 让出控制权给事件循环
  return(i32(42));
});

// 顺序 await：启动任务，运行至完成
result := io.await(task, io);

// 并发：spawn 启动任务但不等待，返回 JoinHandle(T)
handle1 := io.spawn(task1, io);
handle2 := io.spawn(task2, io);
handle3 := io.spawn(task3, io);

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
  task := io.async((io : Io) => {
    // 此处可使用 io.await、io.async、io.spawn
    io.await(yield(io), io);
  });
  io.await(task, io);
});
export(main);

// 测试块自动提供 `io : Io`
test("my test", {
  task := io.async((io : Io) => { /* ... */ });
  io.await(task, io);
});
```

### API

```rust
io.async(fn)                  // 创建冷 Future（惰性，不会立即启动）
io.await(future, io)              // 若为冷任务则启动，等待完成，返回结果
io.state(future)              // 查询 Future 的当前状态（返回 FutureState）
io.spawn(future, io)              // 启动冷 Future 但不等待，返回 JoinHandle(T)
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
11. `io.spawn(future, e)` 在返回之前会**内联运行任务直到它的第一个挂起点**；spawn 本身不是调用方的挂起点
12. 效应包 `e` 在 Future **冷启动时被复制进 Future**（第一次 `io.await` 或 `io.spawn`）；函数体就运行在这个包之下

### 执行模型

```rust
// 三个任务全部运行在同一线程上
main :: (fn(io : Io) -> unit)({
  // 惰性——任务为冷状态，尚未运行
  t1 := io.async((io : Io) => { /* task1 的函数体 */ });
  t2 := io.async((io : Io) => { /* task2 的函数体 */ });
  t3 := io.async((io : Io) => { /* task3 的函数体 */ });

  // spawn 启动每个任务但不等待：
  // - t1 运行到第一个 yield，挂起
  // - t2 运行到第一个 yield，挂起
  // - t3 运行到第一个 yield，挂起
  h1 := io.spawn(t1, io);
  h2 := io.spawn(t2, io);
  h3 := io.spawn(t3, io);

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
{ yield } :: import("std/async");
{ println } :: import("std/fmt");
{ String } :: import("std/string");

Raise :: (ctl(msg : String) -> i32);
Log :: (fn(msg : String) -> unit);
TaskCtx :: struct(io : Io, raise : Raise, log : Log);

main :: (fn(io : Io) -> unit)({
  (raise : Raise) = (
    msg -> {
      return(i32(0));
    }
  );
  (log : Log) = (
    msg -> {
      println(msg);
    }
  );
  ctx := TaskCtx(io : io, raise : raise, log : log);

  (task : Impl(Future(i32, TaskCtx))) = io.async((e : TaskCtx) => {
    e.log(`doing work`);
    r := e.raise(`recoverable`);
    e.io.await(yield(e.io), e.io);
    r + i32(42)
  });

  result := io.await(task, ctx);
  println(`result ${result}`);
});
export(main);
```

`Io` 效应记录本身就是一个效应包形态的 struct，由异步运行时提供：

```rust
Io :: struct(
  async : (fn(generic(T : Type, E : Type.Struct), action : Impl(Fn(e : E) -> T)) -> Impl(Future(T, E))),
  await : (fn(generic(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> T),
  state : (fn(generic(T : Type, E : Type), fut : Impl(Future(T, E))) -> FutureState),
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
{ assert } :: import("std/assert");

main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    return(i32(42));
  });
  result1 := io.await(task, io);
  result2 := io.await(task, io);
  result3 := io.await(task, io);
  assert(result1 == i32(42), "first await returns 42");
  assert(result2 == i32(42), "second await returns 42");
  assert(result3 == i32(42), "third await returns 42");
});
export(main);
```

Future 在完成后保留其结果。对于引用计数类型的结果，每次 `io.await` 调用会对结果进行 dup，使调用方获得自己的引用。Future 的 dispose 函数在状态机被释放时 drop 原始值。

多个任务也可以**同时 await 同一个尚未完成的 Future**。每个等待方都会登记在该
Future 上，Future 完成时它们按登记顺序全部恢复：

```rust
{ sleep } :: import("std/sys/timer");

shared := io.async((io : Io) => {
  io.await(sleep(u64(5)), io);
  i32(7)
});
a := io.async((io : Io) => io.await(shared, io));
b := io.async((io : Io) => io.await(shared, io));
ha := io.spawn(a, io);
hb := io.spawn(b, io);
// 两者都读到 .Some(7)。
ra := ha.await(io);
rb := hb.await(io);
```

### 中止的 Future

当代数效应处理器在异步任务内调用 `unwind` 时，Future 被标记为**已中止**（内部状态 = -2）。任务的续体被丢弃，不会存储结果。

**使用 `io.await`**：对已中止的 Future 调用 `io.await` 会导致 **panic**。

**使用 `handle.await`**：`JoinHandle.await` 返回 `Option(T)`——中止时返回 `.None`，安全地捕获 unwind：

```rust
{ yield } :: import("std/async");
{ assert } :: import("std/assert");
{ String } :: import("std/string");

main :: (fn(io : Io) -> unit)({
  Raise :: (ctl(generic(T : Type), msg : String) -> T);
  Ctx :: struct(io : Io, raise : Raise);
  task := io.async((ctx : Ctx) => {
    ctx.io.await(yield(ctx.io), ctx.io);
    ctx.raise(`something went wrong`);
    return(i32(42));
  });

  // `spawn`/`await` 只接受一个效应参数。需要多个效应时，
  // 把它们打包进一个 struct 再传入。
  (raise : Raise) =
    (
      msg -> {
        unwind(());
      }
    );
  handle := io.spawn(task, { io, raise });
  result := handle.await(io);
  // result 是 Option(i32).None——任务已被中止
  assert(result.is_none(), "aborted task returns None");
});
export(main);
```

### 取消任务

`handle.abort()` 取消一个已 spawn 的任务。任务被标记为中止（-2），而且取消是
**结构化的**：任务当前挂起所等待的东西会随它一起被取消。

- 挂起中的 I/O 操作或定时器会在操作系统层面被取消。
- 任务正在 await 的子 Future 会被递归地中止。
- 停在 `Mutex` 或 `Channel` 上的任务会离开等待队列。下一次 `unlock` 或 `send`
  会跳过这个已死的等待者，把锁或消息交给一个存活的等待者，不会丢失任何东西。
- 所有正在 await 这个被中止任务的任务都会被唤醒。中止发生时**正在等待**的
  `io.await` 会让它自己所在的任务也中止，因此更上层的 `JoinHandle.await` 读到
  `.None`。（对一个**已经**中止的 Future 发起 `io.await` 仍然会 panic。）

被中止任务的局部变量会在它的最后一个引用消失时被 drop。

```rust
{ sleep } :: import("std/sys/timer");

f := io.async((io : Io) => {
  io.await(sleep(u64(50)), io);
  i32(7)
});
hf := io.spawn(f, io);
a := io.async((io : Io) => io.await(f, io));
ha := io.spawn(a, io);
io.await(yield(io), io);
hf.abort();
// 等待方随之被中止。
assert(ha.await(io).is_none(), "the awaiter reads .None");
// 被中止的任务本身也是。
assert(hf.await(io).is_none(), "the aborted task reads .None");
```

`std/async` 的 `timeout(handle, d, io)` 建立在 `abort` 之上。超时时，任务以及
它所阻塞的一切都会被取消。

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
  Pending = 0,
  // 冷——尚未启动
  Running = 1,
  // 执行中——在 await/yield 点挂起
  Completed = -1,
  // 已完成——结果可用
  Aborted = -2 // 已中止——效应处理器调用了 unwind
);
```

```rust
{ assert } :: import("std/assert");
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(42));
  });

  // 启动前：Pending
  assert(io.state(task) == FutureState.Pending, "cold future is Pending");

  io.await(task, io);

  // 完成后：Completed
  assert(io.state(task) == FutureState.Completed, "done future is Completed");
});
export(main);
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
task := io.async((io : Io) => {
  response := io.await(http_get(url), io);
  data := io.await(response.read(), io);
  return(data);
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

任何可以出现表达式的地方都可以。函数体只经过一次降级：每个 `await` 就在它被写下的位置
成为一个挂起点，任务也从那里恢复。每个局部变量、模式绑定和中间值都存放在任务本身之中，
因此跨越挂起点不会丢失任何东西。

```rust
cond(needs_write => { io.await(write_string(p, data, io), io); }, true => ());
if(!(io.await(exists(p, io), io)), { ... });              // 在条件内部
cond(c1 => ..., io.await(f, io) => ..., true => ...);      // 位于后面的 cond 分支
match(io.await(num(io), io), 42 => ..., _ => ...);          // 作为 match 的被匹配值
x := add(io.await(a, io), io.await(b, io));                 // 同一个表达式中的两个 await
while(io.await(more(io), io), { ... });
while(c, { t := io.await(f, io); i = t; }, { ... });        // 三参数 while 的 step
```

求值顺序就是源代码顺序。在 `add(g(), io.await(f, io))` 中，`g()` 在任务挂起之前运行。
惰性求值得以保留：位于后面 `cond` 分支中、或 `&&` 右侧的 `await`，只有在该分支或操作数
被求值时才会运行。

这些都是真正的挂起：在一个被 await 的条件之前 spawn 的任务，会在进行 await 的任务挂起
期间运行。

## 编写 `io.async` 体：递归与等待任务

### 递归：按名字调用外层函数

在 `io.async` 的 lambda 内部，`recur` 指的是**这个 lambda**，而不是返回它的那个函数。
lambda 的签名是 `(io : Io) => …`，所以在那里写 `recur(n, io)` 会得到
`E0603: Argument count mismatch: expected 1 arguments, got 2`。应当按名字调用外层的
`::` 函数：

```rust
{ println } :: import("std/fmt");

count_down :: (fn(n : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) =>
    cond(
      (n == i32(0)) => i32(0),
      true => (io.await(count_down(n - i32(1), io), io) + i32(1))
    )
  )
);

main :: (fn(io : Io) -> unit)({
  r := io.await(count_down(i32(10), io), io);
  println(`count_down(10) = ${r}`); // count_down(10) = 10
});
export(main);
```

每一层都是一个独立的 future，并且所有 future 都要存活到最内层那个完成为止，所以内存随深度
线性增长。在 Linux x86-64 上用 v0.2.49 实测：100,000 层的峰值是 35 MB，1,000,000 层是
316 MB（每层约 310 字节；不会栈溢出，因为 future 分配在堆上）。

当深度取决于数据时（目录树、图），改用显式的工作列表（worklist）：总共只有一个 future，
待处理的工作放在一个 `ArrayList` 里。

```rust
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
{ ArrayList } :: import("std/collections/array_list");

// 把 `n` 不断对半拆分，直到每块都是 1；每处理一块 await 一次。
count_leaves :: (fn(n : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    stack := ArrayList(i32).new();
    stack.push(n);
    (leaves : i32) = i32(0);
    while(stack.len() > usize(0), {
      cur := match(stack.pop(), .Some(k) => k, .None => i32(0));
      io.await(yield(io), io); // 代表每一项的 I/O
      cond(
        (cur > i32(1)) => {
          half := (cur / i32(2));
          stack.push(half);
          stack.push(cur - half);
        },
        true => {
          leaves = (leaves + i32(1));
        }
      );
    });
    leaves
  })
);

main :: (fn(io : Io) -> unit)({
  r := io.await(count_leaves(i32(1000), io), io);
  println(`leaves = ${r}`); // leaves = 1000
});
export(main);
```

同样的遍历处理 100,000 块时，峰值只有 4 MB。

### 在任务内部等待 spawn 出来的任务

`handle.await(io)` 以及 `std/async` 的组合器（`join_all`、`race`、`race_first`、`any`、
`any_first`、`timeout`）都是**阻塞等待**：它们会反复驱动事件循环，直到对应的 handle 完成。
在 `main` 或任何普通 `fn` 里这正是你想要的。但在 `io.async` 体内部，它会**嵌套事件循环**：
正在等待的任务仍留在 C 栈上，由内层循环去运行其他任务；栈上位于它下面的任务在这次等待返回
之前都无法恢复执行，如果被等待的工作恰好依赖其中某个任务，程序就会死锁。

默认情况下嵌套的等待照常运行，所以这个错误很容易被忽略。设置 `YO_ASYNC_STRICT=1` 后，
任务内部第一个需要驱动事件循环的等待会确定性地 panic；`yo test` 在默认的 address
sanitizer 下运行每个测试二进制时都会设置这个变量：

```rust
run_all :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    handles := ArrayList(JoinHandle(i32)).new();
    handles.push(io.spawn(work(i32(1), io), io));
    handles.push(io.spawn(work(i32(2), io), io));
    outs := join_all(handles, io); // ✗ 在任务内部进行阻塞等待
    i32(outs.len())
  })
);
```

```
panic: a blocking await ran inside an async task: an io.await in a non-io.async function,
JoinHandle.await, or a std/async combinator (join_all/race/any/timeout) was called from a
spawned or awaited task. That nests the event loop and can deadlock. ...
```

把 `join_all` 换成直接调用 `handles(i).await(io)` 也会同样 panic。要在任务内部收集 spawn
出去的工作，先挂起直到每个 handle 都进入终态（`is_finished()` 不会阻塞；await `yield`
让事件循环去运行其他任务），然后再读取结果。已完成的 handle 的 `await` 会立即返回，不会
驱动事件循环：

```rust
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
{ ArrayList } :: import("std/collections/array_list");

work :: (fn(id : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    (k : i32) = i32(0);
    while(k < i32(3), {
      io.await(yield(io), io);
      k = (k + i32(1));
    });
    id
  })
);

all_finished :: (fn(handles : ArrayList(JoinHandle(i32))) -> bool)({
  (i : usize) = usize(0);
  (done : bool) = true;
  while(i < handles.len(), {
    if(!handles(i).is_finished(), { done = false; });
    i = (i + usize(1));
  });
  done
});

run_all :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    handles := ArrayList(JoinHandle(i32)).new();
    handles.push(io.spawn(work(i32(1), io), io));
    handles.push(io.spawn(work(i32(2), io), io));
    // ✓ 挂起，直到每个 handle 都进入终态
    while(!all_finished(handles), { io.await(yield(io), io); });
    // 每个 handle 都已完成，所以 `await` 直接读出结果，不再等待
    (sum : i32) = i32(0);
    (i : usize) = usize(0);
    while(i < handles.len(), {
      match(handles(i).await(io), .Some(v) => { sum = (sum + v); }, .None => ());
      i = (i + usize(1));
    });
    sum
  })
);

main :: (fn(io : Io) -> unit)({
  n := io.await(run_all(io), io);
  println(`sum ${n}`); // sum 3，在 YO_ASYNC_STRICT=1 下也是如此
});
export(main);
```

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
static _Thread_local struct __yo_uring __yo_io_ring;
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

类似地，**并行运行时**（线程池、Worker 创建、硬件检测）仅在程序使用 `Thread(T).spawn` 或 `std/thread` 的 `spawn(pool, cb)` 时才生成。非并行程序可节省约 450 行生成的 C 代码。

**同步系统辅助函数**（stat/dirent 访问器、sendfile/copyfile、同步文件操作、mmap/madvise、fcntl、flock、socket 地址辅助函数、信号处理器、TTY）始终通过 `generateSysRuntime()` 生成，其中包括跨平台辅助函数和平台特定的同步辅助函数（`generatePlatformSysRuntime{MacOS,Linux,Windows}`）。这些**不依赖 IoFuture**。所有函数均为 `static`，因此未使用的函数会被 C 编译器的死代码消除机制剥离。这确保了使用信号、stat、mmap、TTY 等功能的非异步程序在编译时不会引入完整的异步运行时。

### 平台特定的 I/O 后端

| 平台    | 后端                                            | 文件                    |
| ------- | ----------------------------------------------- | ----------------------- |
| Linux   | `io_uring`（内嵌环形层），epoll 回退              | `src/codegen/async/runtime_io_linux.yo`   |
| macOS   | `kqueue`（kevent 就绪通知 + 同步 pread/pwrite） | `src/codegen/async/runtime_io_macos.yo`   |
| Windows | I/O 完成端口（IOCP）                            | `src/codegen/async/runtime_io_windows.yo` |
| WASM    | POSIX I/O（NODERAWFS）+ 定时器队列              | `src/codegen/async/runtime_io_wasm.yo`    |

#### WASM 异步支持

WASM 目标（通过 emcc 的 `wasm32-unknown-emscripten`）支持核心异步调度器和真正的定时器支持——`io.async()`、`io.await()`、`io.spawn()`、`JoinHandle.await()` 和 `sleep()`（来自 `std/sys/timer`）均可正常工作。调度器使用 NODERAWFS 的 POSIX I/O 进行文件操作，使用排序定时器队列实现非阻塞 sleep。

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
- 并行（`Thread(T).spawn`）— 需要 pthread 支持（实验性）

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
  task := io.async((io : Io) => {
    /* 工作 */
  });
  // task 为冷状态（refcount=1），尚未启动
  io.spawn(task, io);
  // spawn 启动任务：运行中的任务（事件循环）+1，返回的 JoinHandle 也 +1
  // （这里立即被丢弃：语句级的 spawn 会分离任务）
  io.await(task, io);
  // 等待完成，提取结果
  // 任务完成，事件循环释放引用（refcount=1）
  // task 离开作用域（refcount=0，被释放）
});
export(main);
```

**引用计数生命周期：**

1. **创建**：`io.async(fn)` 分配状态机，`refcount = 1`
2. **启动（通过 await/spawn）**：启动前 `__yo_incr_rc()`（refcount = 2）
   - 一个引用属于用户代码（`task` 变量）
   - 一个引用属于运行中的任务（由事件循环持有）
3. **用户释放**：当 `task` 离开作用域时，`__yo_decr_rc()`（refcount = 1）
4. **任务完成**：状态机调用 `__yo_decr_rc()`（refcount = 0，被释放）

**核心洞察**：即使用户代码提前释放任务，任务也会保持存活直到完成！

**`JoinHandle(T)` 持有一个引用。** `io.spawn` 返回一个 `ref` 结构体，它持有任务
Future 的一个引用。只要还有任何一个句柄副本存在，任务及其结果就保持存活；最后一个
副本被丢弃时释放这个引用。await 句柄不会消耗它：await 两次读到同一个结果。一个未被
await 就被丢弃的句柄会**分离**任务：任务继续运行，并在结束时释放自己，因此一句
即发即弃的 `io.spawn(task, io);` 不会泄漏任何东西。

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

一个任务就是一次堆分配：

- 40 字节的头部：引用计数、状态、指向该类型操作表的指针（resume、效果绑定、中止钩子），以及第一个等待者；
- 结果；
- 捕获的值与闭包参数（一个 `Io` 占 32 字节）；
- 一个指针，指向任务当前挂起等待的 future；
- 每个跨越 `await` 仍然存活的局部变量占一个字段。

只在两个 await 之间使用的局部变量仍是 C resume 函数的局部变量，不占任务的空间。存活区间互不重叠、C 类型相同的局部变量共用一个字段，持有堆内存的值也不例外。在 x86_64 上实测：一个 await、捕获很少的任务为 88 字节；十六个顺序 await、结果全部在最后才相加的任务为 152 字节，其中 60 字节是尚待相加的十五个结果。

## 性能特征

### 内存使用

**10,000 个并发异步操作：**

- 状态机：10,000 × 约 100 字节 = 1MB
- 无需线程栈！

**对比：**

- 10,000 个操作系统线程 × 1MB 栈 = 10GB ❌
- 10,000 个 Go goroutine × 2KB = 20MB
- 10,000 个 Yo 异步任务 × 约 100 字节 = 1MB ✅

### 吞吐量

在一台负载较高的 32 线程 x86_64 机器上测得（`--optimize 2`，10 万次操作的每次耗时中位数，
误差按 ±2× 看待）：

| 操作 | ns |
|---|---|
| `io.await` 一个已完成的 future | ~4 |
| 同步完成的冷启动子 future | ~25 |
| 同上，同时有其他 I/O 停在内核中 | ~24 |
| 4 层嵌套 await 的链 | ~150 |
| 对一个不含 await 的任务 `io.spawn` + `JoinHandle.await` | ~210 |

同步完成的子 future 会就地继续执行（每次恢复的预算为 1024），而结束的任务会把同一个
调度步骤的剩余部分交给它的等待方，因此两者都不必经过运行队列或内核。

- 无上下文切换（同一线程）
- 无同步开销
- 缓存友好（小型状态机）

## 异步迭代：`Stream` trait

`Iterator` 现在就产出值，`Future` 稍后产出一个值。**`Stream`** 兼具两者 ——
“稍后产出一个值，而且反复产出”：

```rust
Stream :: trait(
  Item : Type,
  next : (fn(self : Self, io : Io) -> Impl(Future(Option(Self.Item), Io)))
);
```

它位于 `std/async/stream`，`.None` 表示流已结束 —— 这是终止状态，并且会一直保持
终止。

```rust
{ Stream } :: import("std/async/stream");
{ TcpListener } :: import("std/net/tcp");

conns := listener.incoming().take(usize(3)); // 惰性的 Stream
accepted := io.await(conns.collect(io), io); // ArrayList(Result(TcpStream, NetError))
```

### 谁实现了它

| 类型 | 它的流 |
| --- | --- |
| `TcpListener.incoming()`（`std/net/tcp`） | `Item = Result(TcpStream, NetError)` —— 每一项是一条连接 |
| `Watcher`（`std/fs/watch`） | `Item = FsEvent` —— watcher 关闭且队列排空后为 `.None` |
| `Channel(T)`（`std/async/channel`） | `Item = T` —— `next` 就是 `recv`；关闭且排空后为 `.None` |

### 组合器与消费者

它们只写一次，定义在 `where(S <: Stream)` 上，与 `Iterator` 的组合器一一对应：

| 惰性组合器 | 作用 |
| --- | --- |
| `map(f)` | 变换每一项 |
| `filter(pred)` | 只保留满足 `pred` 的项（按值传入，与 `map` 对称） |
| `filter_map(f)` | `f` 返回 `Option(B)`，只产出其中的 `.Some` |
| `take(n)` | 最多产出 `n` 项后结束，之后不再触碰上游 |
| `skip(n)` | 丢弃前 `n` 项 |

| 消费者 | 作用 |
| --- | --- |
| `for_each(f, io)` | 驱动流直到结束，对每一项调用 `f` |
| `collect(io)` | 驱动流直到结束，把所有项收集进 `ArrayList` |
| `for_await(s, io, x => body)` | 循环形式（一个宏）：每一项运行一次 `body`，其中可以使用 `break`、`continue` 和 `return` |

```rust
// 最多取五个“内容变更”事件的名字。
names := watcher.filter(e => (e.kind == FsEventKind.Change)).map(e => e.name).take(usize(5));
io.await(names.for_each(n => println(n), io), io);

// 或者写成可以提前结束的循环：这里遇到第一个空名字就停。
for_await(names, io, n => {
  if(n.len() == usize(0), {
    break;
  });
  println(n);
});
```

### 如何实现一个流

`next` 的接收者是 `self : Self`，而不是 `Iterator` 用的 `inout(self)`：它返回的
future 的生命周期超出这次调用，而 `inout` 借用无法跨越挂起点。因此流的源头都是
引用语义类型（`ref(struct(...))`），字段写入通过句柄传播：

```rust
Countdown :: ref(struct(_n : i32));
impl(
  Countdown,
  Stream(
    Item : i32,
    next : (fn(self : Self, io : Io) -> Impl(Future(Option(i32), Io)))(
      io.async(
        (io : Io) =>
          cond(
            (self._n <= i32(0)) => Option(i32).None,
            true => {
              v := self._n;
              self._n = (self._n - i32(1));
              Option(i32).Some(v)
            }
          )
      )
    )
  )
);
```

如果流的项**可能失败**，就把失败装进项里 —— `Item = Result(T, E)`，正如
`incoming` 产出 `Result(TcpStream, NetError)`。这也是 `next` 的 future 是
`Future(_, Io)` 而不是 `Future(_, IoExn)` 的原因：**流从不抛异常**，所以单项失败
不会结束整个序列，消费者也不需要 `Exception` 处理器。

### 动手前需要知道的四件事

1. **组合链要在 `io.async` 体的外面构造。** 在 async 体内部把闭包传给泛型回调
   参数，会让外层 future 的结果类型无法确定，而错误会报在调用方的 `await` 上。
   先构造链，再在任意位置 await 它 —— 包括在 spawn 出去的任务里：

   ```rust
   chain := source.map(x => f(x));            // 在外面构造
   task := io.async((io : Io) => io.await(chain.collect(io), io));   // 在里面 await
   ```

2. **`for_await` 就是这个手写循环。** 它展开成下面的代码，其中的 await 和其他
   await 一样会挂起所在的任务，所以在 spawn 出去的任务里和在 `main` 里都能用：

   ```rust
   (done : bool) = false;
   while(done == false, {
     nx := io.await(stream.next(io), io);
     match(nx, .Some(x) => { … }, .None => { done = true; });
   });
   ```

3. **泛型消费者就是普通的泛型函数。** `where(S <: Stream)`、
   `where(S <: Stream(Item := i32))` 以及带泛型 `A` 的 `where(S <: Stream(Item := A))`
   都能接受流的源头和组合链。泛型 `A` 会从实参的 `Stream` impl 中绑定，函数体可以使用它
   （`ArrayList(A)`、`A <: Add(A)`），也可以在该参数上调用 blanket 组合子
   （`s.collect(io)`、`s.map(f)`）。

4. **`.None` 是终止状态。** 消费者据此停止，所以实现者结束之后必须继续回答
   `.None`，绝不能“结束后又恢复”。

## API

### 核心操作

```rust
{ yield } :: import("std/async");

// io.async：创建惰性 Future（冷，在 await/spawn 之前不会启动）
task := io.async((io : Io) => {
  // 函数体
  return(value);
});

// io.await：若为冷任务则启动，等待完成，返回结果
result := io.await(task, io);

// io.spawn：启动冷 Future 但不等待，返回 JoinHandle(T)
handle1 := io.spawn(task1, io);
handle2 := io.spawn(task2, io);
// spawn 后任务正在运行——handle.await 返回 Option(T)
r1 := handle1.await(io);
r2 := handle2.await(io);
```

### 示例：使用 Spawn 的并发任务

```rust
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  counter := Box(i32)(0);

  task1 := io.async((io : Io) => {
    counter.* = (counter.* + 1);
    io.await(yield(io), io);
    counter.* = (counter.* + 1);
    return(counter.*);
  });

  task2 := io.async((io : Io) => {
    counter.* = (counter.* + 10);
    io.await(yield(io), io);
    counter.* = (counter.* + 10);
    return(counter.*);
  });

  // 任务为冷状态——counter 仍为 0
  handle1 := io.spawn(task1, io);
  handle2 := io.spawn(task2, io);
  // 两者通过交替执行运行：counter = 22
  result1 := handle1.await(io);
  result2 := handle2.await(io);
});
export(main);
```

### 示例：顺序 Await（不使用 Spawn）

```rust
{ yield } :: import("std/async");

main :: (fn(io : Io) -> unit)({
  counter := Box(i32)(0);

  task1 := io.async((io : Io) => {
    counter.* = (counter.* + 1);
    io.await(yield(io), io);
    counter.* = (counter.* + 1);
  });

  task2 := io.async((io : Io) => {
    counter.* = (counter.* + 10);
    io.await(yield(io), io);
    counter.* = (counter.* + 10);
  });

  // 不使用 spawn：任务顺序执行
  io.await(task1, io); // task1 完整运行至完成
  io.await(task2, io); // 然后 task2 完整运行至完成
  // counter 无论哪种方式都等于 22，但没有交替执行
});
export(main);
```

### 从另一个任务唤醒任务：`Waker` 与 `Park`

`yield` 把一个轮次交还给事件循环，但它无法让一个任务等待**另一个任务的进展**。
那需要一个可以被对方触发的令牌，`std/async/waker` 就是它。

```rust
{ Park } :: import("std/async/waker");

// 等待方。先创建 park，把它的 waker 交给将来发信号的一方，然后挂起 ——
// 顺序就是这样，中间不能有 await。
p := Park.new();
waiters.push(p.waker());
io.await(p.wait(io), io);

// 发信号方，可以来自任何其他任务：
match(waiters.pop(), .Some(w) => w.wake(), .None => ());
```

有三条性质值得记住，因为建立在它之上的原语都依赖它们：

- **在等待方挂起之前到达的唤醒不会丢失。** await 点会先读取 future 的状态，
  再注册续延，所以一个已被唤醒的 park 会直接就地恢复，而不会挂起。
- **唤醒是幂等的。** 第二次 `wake()`，或者唤醒一个任务已经结束的 park，都是空操作。
  因此等待者列表可以逐个唤醒所有人，而无需记录谁已经跑过了。
- **被取消的等待者会告诉你。** 如果被 park 的任务已被取消、永远不会运行，
  那么刚调用完 `w.wake()` 后 `w.is_woken()` 为 `false`。等待者列表据此把唤醒转交
  给下一个等待者，`Mutex` 和 `Channel` 正是靠这一点在 `abort` 和 `timeout` 下保持正确。
- **无人能唤醒的 park 会被报告，而不是挂死。** 运行时会统计存活的 waker 令牌；
  当没有可运行的任务、没有未完成的 I/O，却仍有令牌存活时，事件循环会明确报告并停止，
  而不是空转。

对于只需要一个 waker 的常见情形，`park(register, io)` 把整个顺序包好了：

```rust
{ park } :: import("std/async/waker");

io.await(
  park((w : Waker) => {
    slot.* = Option(Waker).Some(w);
  }, io),
  io
);
```

`register` 在挂起**之前**运行并拿到 waker，所以顺序不可能写错。这与 Rust 的
`Future::poll(cx)` 是同一种形状。当等待者列表需要自己持有令牌时，直接使用 `Park`。

### `yield_now`：不带定时器的公平让出

`std/async` 的 `yield` 和 `std/async/waker` 的 `yield_now` 是同一个机制：
它的 future 创建时处于 pending 状态，由下一次就绪任务批处理在测量完自己的配额
之后完成它，于是被恢复的任务在下一个轮次运行，中间正好有一次 I/O 轮询。两者
之下都没有定时器。

在 v0.2.32 之前，`yield` 停在一个 1 毫秒的定时器上，这给建立在它之上的一切都
加上了毫秒级的下限（在一个 spawn 出来的任务里跑 400 个轮次的实测：`yield_now`
0 毫秒，定时器版的 `yield` 603 毫秒）。推迟的原因是引导（bootstrap），而不是设计：
`yield` 位于编译器自身的 import 路径上，而 seed 编译器生成的是它自己构建时的
async 运行时，所以只有当某个已发布的 seed 带上新原语之后，`yield` 才能指向它。
`yield_now` 作为 `std/async/waker` 导出的名字保留。

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
Ctx :: struct(io : Io, log : Log);

task := io.async((e : Ctx) => {
  e.log(`hello`);
});

(log1 : Log) = (
  msg -> {
    println(`Log1: ${msg}`);
  }
);

// spawn 的效应参数携带 log1；任务启动时它被绑定进 Future 的捕获，
// JoinHandle 会记住它。
handle := io.spawn(task, Ctx(io : io, log : log1));

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

2. **在任务内部等待 `JoinHandle` 会嵌套事件循环** — 见上文"在任务内部等待已 spawn 的任务"。`plans/ASYNC_IO_API_AUDIT.md` 的 A1 阶段会移除这个限制。

本文档早期版本列出的限制——异步中的三参数 `while`、二元表达式作为异步返回值，以及一个从未有过 issue 记录、也无法复现的"异步 unwind 引用计数双重递减"——都已不存在。参见 `issues/fixed/async-while-3arg-form.md` 和 `issues/fixed/async-sm-result-type-binary-expr.md`。

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
{ yield } :: import("std/async");

// 创建惰性异步任务
task := io.async((io : Io) => {
  io.await(yield(io), io); // 让出控制权给事件循环
  return(i32(42));
});

// 顺序：启动并运行至完成
result := io.await(task, io);

// 并发：启动任务但不等待，然后 await handle
handle1 := io.spawn(task1, io);
handle2 := io.spawn(task2, io);
r1 := handle1.await(io); // Option(T)
r2 := handle2.await(io); // Option(T)
```

### 核心原则

1. **惰性执行** — `io.async(fn)` 创建冷 Future
2. **`io.await(task)`** — 启动冷任务，顺序运行至完成
3. **`io.spawn(task)`** — 启动冷任务但不等待，返回 `JoinHandle(T)`
4. **`handle.await(io)`** — 等待已 spawn 的任务，返回 `Option(T)`（unwind 时返回 `.None`）
5. **单线程** — 所有异步代码运行在调用线程上
6. **`yield()` 让出** — 挂起任务，将控制权交给其他就绪任务
7. **状态机** — 编译器将每个 `io.await` 变换为状态转换
8. **每个事件循环一个线程** — `io.spawn` 不要求 `Send`；`Io` 和 `JoinHandle` 是 `!Send`，任务离不开它的循环
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
| 消费异步序列       | `Stream` + `for_each`/`collect`（参见[异步迭代](#异步迭代stream-trait)） |
| 利用多个 CPU 核心  | `Task.spawn`（参见 PARALLELISM.md） |

## Linux 上的后端选择（`YO_IO_BACKEND`）

在 Linux 上，运行时在首次异步操作时为每个线程选择一次后端，且不再更改：

1. **io_uring**（内核允许时的默认选择——5.6+，未被封锁）。
2. **epoll 回退**——当无法创建环形队列时自动选择（无 io_uring 的内核，或
   封锁它的沙箱，例如 Docker 的默认 seccomp 配置）。套接字、管道与终端使用
   就绪驱动；普通文件以及 epoll 无法表达的操作在 future 中同步完成，与
   macOS 后端的行为一致。
3. **降级（degraded）**——仅当 epoll 也不可用时：每个异步操作以 errno
   完成，而不是挂起或退出进程。

选择过程从不是静默的：回退会为每个 I/O 线程向 stderr 输出一行日志，写明
errno（遇到 `ENOSYS` 时还会指出可能的原因——例如 Docker 默认配置这样的
seccomp 过滤器）。可通过 `YO_IO_BACKEND` 环境变量固定后端用于测试或基准测试
（`auto`（默认）| `uring` | `epoll`）；固定的后端初始化失败时是硬错误，
而不是静默切换；其他取值同样是错误，因此拼写错误不会悄悄变成 `auto`。

### Linux 上各操作在哪里执行

两个后端都会尽量让操作在事件循环无需等待的情况下完成，因为经过事件循环的一
次往返（挂起任务、进入内核、收割完成事件、恢复任务）远比系统调用本身昂贵：

- **套接字：** `send`/`recv`/`sendto`/`recvfrom` 先以 `MSG_DONTWAIT` 内联尝
  试；只有会阻塞的结果才会让任务挂起（一个 io_uring SQE，或一次 epoll 注册）。
  内联尝试绝不会抢在同一套接字上同方向、仍在排队的更早操作之前。若某套接字上
  一次内联 `recv` 会阻塞，它的下一次 `recv` 直接交给环形队列（或直接交给
  epoll），直到某次接收在事件循环无需等待的情况下完成。
- **定时器：** 在两个后端上，一次 sleep 都是每线程定时器堆中的一个节点；事件循
  环的等待以最早的截止时间为界。设置与取消定时器都不需要系统调用（std/async
  的 `timeout` 会在被保护的工作先完成时取消其截止任务）。
- **io_uring 上的文件元数据：** `stat`、`mkdir`、`unlink`、`rename`、
  `symlink`、`link` 以及会创建或截断文件的 open 在事件循环线程上内联执行。内核
  无法以非阻塞方式完成这些操作，因此 io_uring 总是把它们交给工作线程；这次交接
  实测约 57 µs，而系统调用本身只需 0.3–3 µs。在慢速或网络文件系统上，路径查找
  会在其持续期间阻塞事件循环——这正是 macOS 与 epoll 回退一直以来的约定。缓冲
  写入先以 `RWF_NOWAIT` 内联尝试，仅在内核拒绝时才交给环形队列；在当前内核上
  ext4 与 tmpfs 会拒绝，且该拒绝会按描述符记住。读取、普通 open、`fsync` 与
  `ftruncate` 仍走环形队列。
- **监视（watch）**（`std/sys/events` 的 poll 句柄、`std/fs/watch`）：被监视
  的描述符会结束一次阻塞等待，因此即使有无关 I/O 在进行，回调也会触发；
  `Watcher.next` 会挂起而不是轮询。

### macOS 上各操作在哪里执行

kqueue 后端遵循同样的“不经事件循环就完成”原则，并额外有两条 macOS 特有的
规则：事件循环从不为一次不可能找到任何事件的内核扫描付费，也从不无故唤醒。

- **套接字：** `send`/`recv`/`sendto`/`recvfrom`/`accept` 先内联尝试（带
  `MSG_DONTWAIT`）；只有会阻塞的结果才让任务挂起在该描述符的
  `EVFILT_READ`/`EVFILT_WRITE` knote 上。内联尝试绝不会抢在同一描述符上同方
  向、仍在挂起的更早操作之前。若某套接字上一次内联 `recv` 会阻塞，它的下一次
  `recv` 直接挂起，直到某次接收发现数据其实早已到达。事件送达后的无标志
  `recv` 是一次普通的 `read`：事件报告了可读字节数，因此它不会阻塞。
- **普通文件：** `pread`/`pwrite` 在发起时即完成（统一缓冲缓存让它们很快）。
  `pread` 返回 `ESPIPE`（管道、套接字、FIFO）或 `ENXIO`（终端）时回到就绪
  路径。以 `O_APPEND` 打开的描述符写在文件末尾。
- **定时器：** 一次 sleep 是每线程定时器堆中的一个节点；事件循环的 `kevent()`
  等待以最早的截止时间为界。设置与取消定时器都不需要系统调用。操作系统仍会合
  并定时器唤醒：1 ms 的截止时间约在 1.25 ms 后唤醒，与 libuv 及任何
  `kevent()` 超时相同。
- **事件循环进入内核的时机：** 内核中没有任何工作的一轮（只有定时器，或所有
  操作都在发起时完成）不做系统调用。一轮结束后若没有可运行的任务，这一轮不再
  单独轮询：下一步阻塞的 `kevent()` 会在同一次调用中收割同样的事件。在 macOS
  26 上，一次什么也没找到的零超时 `kevent()` 约需 12 µs，因此非阻塞轮询先以零
  超时的 `select()` 询问 kqueue 描述符（约 0.2 µs）。在仍有任务排队时，每 61
  轮轮询一次内核（与 tokio 的间隔相同）。当流量持续时（上一次等待在 50 µs 内
  得到响应），等待以 50 µs 为上限而不是无限期：在 macOS 上，截止时间很近的等待
  醒得更快，这对一次回环 TCP 往返约有 7% 的收益。第一次超时且什么也没等到的
  等待会结束这一状态。
- **监视（watch）**（`std/sys/events` 的 poll 句柄、`std/fs/watch`）：它们共
  用每线程一个的监视 kqueue，并嵌套在事件循环的 kqueue 中。被监视的描述符会结
  束一次阻塞等待；目录监视在目录的 vnode 事件发生时重新扫描，另外至多每 50 ms
  扫描一次，以发现对已有条目的写入——只有重新扫描才能看到这类写入。

### 各后端的操作生命周期一致

- **关闭描述符会结束其上仍在等待的操作**：它们以 `-EBADF` 完成（kqueue、
  epoll 与 io_uring 相同——环形队列会取消自己的请求，因为 io_uring 请求持有
  自己的文件引用，否则会比描述符活得更久）。这也包括对一个已打开描述符执行
  `dup2`（它会关闭该描述符）。运行时曾在其上等待过的描述符，请通过
  std 关闭（`file.close`、`tcp.close`、`pipe.dup2`），而不是直接调用 `libc` 的
  `close`：后端无法感知它没有被告知的关闭。
- **同一流套接字上的并发接收：** kqueue 与 epoll 按发起顺序完成它们；io_uring
  不保证顺序（较晚的 `recv` 可能拿到下一批字节）。每个字节仍只会到达一个
  `recv`。
- **中止任务会取消它正挂起其中的操作**，因此被中止的 `recv` 不会吞掉本应由
  后续 `recv` 读到的数据。
- **`std/net` 流向已关闭的对端写入时会抛出错误**（`IoError.BrokenPipe` 或连
  接重置），而不是触发默认动作为终止进程的 `SIGPIPE`。`TcpStream`/`UnixStream`
  的写入经由 `std/sys` 的 `stream_write`：在 macOS 上是 `write(2)`，std 会为
  它连接或接受的每个流设置 `SO_NOSIGPIPE`；在 Linux 上是
  `send(MSG_NOSIGNAL)`。底层 `std/sys` 的 `send` 原样传递调用者给出的标志。
- **`send`/`recv`/`sendto`/`recvfrom` 的套接字可以是阻塞或非阻塞的**：
  就绪型后端以 `MSG_DONTWAIT` 尝试这些调用。在 macOS 与 epoll 后端上，
  `accept`、`connect` 以及对管道或终端的 `read`/`write` 需要非阻塞描述符
  （std 创建的每个套接字与管道都是非阻塞的）；阻塞描述符会在调用期间阻塞
  事件循环线程。io_uring 两种模式都能处理。
- 向 backlog 已满的监听者发起 Unix 域 `connect` 时，io_uring 会一直重试直到
  连接成功；epoll 回退则报告 `EAGAIN`——就绪通知无法表达“backlog 有空位”。
